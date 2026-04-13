/**
 * Extism WASM Sandbox Runner
 *
 * Executes untrusted JavaScript in a QuickJS-based WASM sandbox via Extism.
 * Provides true WASM-level isolation without access to Web APIs, the network,
 * or the host filesystem.
 *
 * ## Limitations
 *
 * - No Web APIs: `fetch`, `setTimeout`, `setInterval`, DOM APIs unavailable
 * - Synchronous execution: async/await syntax works but Promises don't resolve
 *   across ticks (no event loop)
 * - ES2020 max: QuickJS-ng supports up to ES2020 (nullish coalescing, optional
 *   chaining, BigInt) but not ES2023+ features
 * - JSON boundary only: Functions, Symbols, circular references can't cross
 *   the WASM boundary
 * - No npm deps: unlike the MCP sandbox, can't install packages
 */

import { resolve } from "node:path";

import { getPluginHost } from "../plugins/host";
import { PluginMemoryError, PluginTimeoutError } from "../plugins/interface";
import {
  SandboxExecutionError,
  SandboxMemoryError,
  SandboxOutputError,
  SandboxTimeoutError,
} from "./runner";

import type { PluginCallResult, PluginManifest } from "../plugins/types";
import type { SandboxInput, SandboxResult } from "./runner";

const PLUGIN_ID = "vortex-quickjs-evaluator";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Resolve path to the compiled evaluator WASM */
const getWasmPath = (): string =>
  resolve(import.meta.dir, "wasm", "evaluator.wasm");

/** Build the plugin manifest for the evaluator */
const buildEvaluatorManifest = (): PluginManifest => ({
  id: PLUGIN_ID,
  name: "QuickJS Evaluator",
  version: "1.0.0",
  description: "Sandboxed JavaScript evaluator using QuickJS-ng via Extism",
  wasm: { path: getWasmPath() },
  functions: [
    {
      name: "run",
      inputs: {
        source: { type: "string", required: true },
        inputs: { type: "object", required: false },
      },
      outputs: {
        ok: { type: "boolean" },
        output: { type: "object" },
        error: { type: "string" },
      },
    },
  ],
  permissions: {},
  limits: {
    memory: 128,
    timeout: 60_000,
  },
});

/**
 * Execute JavaScript source code in the Extism WASM sandbox.
 *
 * @param input - Source code, inputs, and resource limits
 * @returns Parsed output from the user code
 * @throws {SandboxTimeoutError} If execution exceeds `limits.timeoutMs`
 * @throws {SandboxMemoryError} If execution exceeds `limits.memoryMb`
 * @throws {SandboxOutputError} If output exceeds `limits.maxOutputBytes`
 * @throws {SandboxExecutionError} If the user code throws
 */
const runExtismSandbox = async (
  input: SandboxInput,
): Promise<SandboxResult> => {
  const { source, inputs, limits } = input;
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const host = getPluginHost();
  const manifest = buildEvaluatorManifest();

  // Lazy-load (reuses cached instance on subsequent calls)
  const plugin = await host.load(manifest);

  const startTime = performance.now();

  // Race the plugin call against a per-call timeout
  const callPromise = plugin.call("run", { source, inputs });

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SandboxTimeoutError(limits.timeoutMs));
    }, limits.timeoutMs);
  });

  let result: PluginCallResult;
  try {
    result = await Promise.race([callPromise, timeoutPromise]);
    clearTimeout(timeoutId!);
  } catch (error) {
    clearTimeout(timeoutId!);
    if (error instanceof SandboxTimeoutError) {
      throw error;
    }
    if (error instanceof PluginTimeoutError) {
      throw new SandboxTimeoutError(limits.timeoutMs);
    }
    if (error instanceof PluginMemoryError) {
      throw new SandboxMemoryError(limits.memoryMb);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("out of memory") ||
      message.includes("allocation") ||
      message.includes("Maximum call stack")
    ) {
      throw new SandboxMemoryError(limits.memoryMb);
    }

    throw new SandboxExecutionError(message);
  }

  const durationMs = performance.now() - startTime;

  // Outer envelope: PluginCallResult from ExtismLoadedPlugin
  if (!result.success) {
    const message = result.error ?? "Unknown plugin error";

    if (message.includes("timeout") || message.includes("Timeout")) {
      throw new SandboxTimeoutError(limits.timeoutMs);
    }

    throw new SandboxExecutionError(message);
  }

  // Inner envelope: {ok, output, error} from the evaluator JS
  const envelope = result.output as
    | {
        ok?: boolean;
        output?: Record<string, unknown>;
        error?: string;
      }
    | undefined;

  if (!envelope?.ok) {
    throw new SandboxExecutionError(
      envelope?.error ?? "Unknown execution error",
    );
  }

  const output = envelope.output ?? {};

  // Enforce output size limit
  const serialised = JSON.stringify(output);
  if (serialised.length > maxOutputBytes) {
    throw new SandboxOutputError(maxOutputBytes);
  }

  return { output, durationMs };
};

export { runExtismSandbox };
