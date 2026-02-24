/**
 * Function Invoke Workflow
 *
 * Handles execution of registered functions (FaaS) dispatched by the
 * vortex-api via Hatchet `function:invoke` events. Routes to the
 * appropriate runtime and executor:
 *
 * - **local / JS** -- executes inline source in the sandboxed Bun Worker
 * - **local / WASM** -- loads a WASM module via ExtismPluginHost and calls "run"
 * - **spinkube / WASM** -- deploys + invokes via SpinApp CRD on Kubernetes
 */

import { SpinKubeExecutor } from "../executor/adapters/spinkube";
import { getPluginHost } from "../plugins/host";
import { runSandboxedCode } from "../sandbox/runner";

import type { Workflow } from "@hatchet-dev/typescript-sdk";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types";

/** Default resource limits when the caller does not specify any */
const DEFAULT_LIMITS = {
  memoryMb: 128,
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576, // 1 MB
};

/** Payload shape dispatched by the functions API */
interface FnInvokeInput {
  /** Function registry ID */
  fnId: string;
  /** Execution runtime */
  runtime: "js" | "wasm";
  /** Inline JS source (required when runtime is "js") */
  source?: string;
  /** URL of the WASM module (required when runtime is "wasm") */
  wasmModuleUrl?: string;
  /** Execution target: "local" (default) or "spinkube" (Kubernetes) */
  executor?: "local" | "spinkube";
  /** Resource limits override */
  limits?: {
    memoryMb?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  };
  /** Input data forwarded to the function */
  input?: Record<string, unknown>;
}

export const fnInvokeWorkflow: Workflow = {
  id: "fn-invoke",
  description: "Execute a registered function (JS or WASM)",
  on: {
    event: "function:invoke",
  },
  steps: [
    {
      name: "execute-function",
      timeout: "120s",
      retries: 0,
      run: async (ctx) => {
        const payload = ctx.workflowInput() as FnInvokeInput;
        const {
          fnId,
          runtime,
          source,
          wasmModuleUrl,
          executor,
          input = {},
        } = payload;

        const limits = {
          memoryMb: payload.limits?.memoryMb ?? DEFAULT_LIMITS.memoryMb,
          timeoutMs: payload.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
          maxOutputBytes:
            payload.limits?.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
        };

        ctx.log(
          `Invoking function ${fnId} (runtime=${runtime}, executor=${executor ?? "local"})`,
        );

        // -- SpinKube executor -----------------------------------------
        // Route WASM functions to the Kubernetes SpinApp CRD when the
        // caller specifies executor="spinkube". First invocation triggers
        // a deploy; subsequent calls go directly to the running service.
        if (executor === "spinkube") {
          if (!wasmModuleUrl) {
            throw new Error(
              `SpinKube executor requires "wasmModuleUrl" but none was provided for function ${fnId}`,
            );
          }

          const spinkube = new SpinKubeExecutor({
            namespace: process.env.SPINKUBE_NAMESPACE ?? "vortex-functions",
            runtimeClass:
              process.env.SPINKUBE_RUNTIME_CLASS ?? "wasmtime-spin-v2",
          });

          const start = performance.now();

          let output: Record<string, unknown>;

          try {
            output = await spinkube.invoke(fnId, input);
          } catch {
            // Invoke failed -- likely the SpinApp is not deployed yet.
            // Deploy and retry once.
            ctx.log(
              `SpinApp not reachable for ${fnId}, deploying and retrying`,
            );

            await spinkube.deploy({
              functionId: fnId,
              wasmModuleUrl,
            });

            // Brief wait for the scheduler to create the pod
            await new Promise((resolve) => setTimeout(resolve, 2_000));

            output = await spinkube.invoke(fnId, input);
          }

          const durationMs = performance.now() - start;

          ctx.log(
            `Function ${fnId} completed via SpinKube in ${durationMs.toFixed(1)}ms`,
          );

          return {
            fnId,
            runtime,
            executor: "spinkube",
            output: output as JsonObject,
            durationMs,
          };
        }

        // -- JS runtime ------------------------------------------------
        if (runtime === "js") {
          if (!source) {
            throw new Error(
              `JS runtime requires "source" but none was provided for function ${fnId}`,
            );
          }

          const result = await runSandboxedCode({
            source,
            inputs: input,
            limits,
          });

          ctx.log(
            `Function ${fnId} completed in ${result.durationMs.toFixed(1)}ms`,
          );

          return {
            fnId,
            runtime,
            output: result.output as JsonObject,
            durationMs: result.durationMs,
          };
        }

        // -- WASM runtime ----------------------------------------------
        if (runtime === "wasm") {
          if (!wasmModuleUrl) {
            throw new Error(
              `WASM runtime requires "wasmModuleUrl" but none was provided for function ${fnId}`,
            );
          }

          const host = getPluginHost();

          // Load (or reuse cached) WASM module
          const plugin = await host.load({
            id: `fn-${fnId}`,
            name: `function-${fnId}`,
            version: "0.0.0",
            wasm: { url: wasmModuleUrl },
            functions: [
              {
                name: "run",
                inputs: {},
                outputs: {},
              },
            ],
            limits: {
              memory: limits.memoryMb,
              timeout: limits.timeoutMs,
              maxOutputSize: limits.maxOutputBytes,
            },
          });

          const result = await plugin.call("run", input);

          if (!result.success) {
            throw new Error(
              `WASM function ${fnId} failed: ${result.error ?? "unknown error"}`,
            );
          }

          ctx.log(
            `Function ${fnId} completed in ${result.durationMs.toFixed(1)}ms`,
          );

          return {
            fnId,
            runtime,
            output: (result.output ?? {}) as JsonObject,
            durationMs: result.durationMs,
          };
        }

        // -- Unknown runtime -------------------------------------------
        throw new Error(
          `Unsupported runtime "${runtime}" for function ${fnId}`,
        );
      },
    },
  ],
};
