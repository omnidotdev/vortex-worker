/**
 * Sandboxed Code Runner
 *
 * Executes untrusted JavaScript code in an isolated Bun Worker with
 * configurable resource limits (timeout, memory, output size). The worker
 * runs user code via `new Function()` in a stripped environment where
 * dangerous globals (`process`, `require`, `Bun`, `Deno`) are undefined.
 *
 * ## Design
 *
 * For WASM-level isolation, see `sandbox/extism.ts` which runs user code
 * in a QuickJS-ng evaluator compiled to WASM via Extism. This Worker
 * sandbox is retained for code that needs Web APIs (fetch, setTimeout)
 * or ES2023+ features not supported by QuickJS-ng.
 *
 * ## Security
 *
 * - Code runs in a separate Worker thread (V8 isolate)
 * - Dangerous globals are explicitly shadowed to `undefined`
 * - `fetch` is exposed but wrapped in an SSRF guard (see `guardedFetch.ts`)
 *   that rejects private/internal addresses and non-http(s) schemes
 * - Worker is terminated on timeout to prevent infinite loops
 * - Output size is capped to prevent memory exhaustion on the host
 */

import { createGuardedFetch } from "./guardedFetch";

/** Input for the sandboxed code runner */
type SandboxInput = {
  /** JavaScript source code to execute */
  source: string;
  /** Key/value inputs available as `input` inside the code */
  inputs: Record<string, unknown>;
  /** Trigger context available as `trigger` inside the code */
  trigger?: { data: Record<string, unknown> };
  /** Step results available as `steps` inside the code */
  steps?: Record<string, unknown>;
  /** Resource limits */
  limits: {
    /** Maximum memory in megabytes (advisory -- enforced at Worker level) */
    memoryMb: number;
    /** Maximum execution time in milliseconds */
    timeoutMs: number;
    /** Maximum output JSON size in bytes (default: 1 MB) */
    maxOutputBytes?: number;
  };
};

/** Successful execution result */
type SandboxResult = {
  /** Parsed output returned by the user code */
  output: Record<string, unknown>;
  /** Wall-clock execution duration in milliseconds */
  durationMs: number;
};

// Default maximum output size: 1 MB
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * Globals that are explicitly shadowed inside the user function.
 *
 * These are passed as named parameters to the constructed function so that
 * even though the Worker thread may expose them on `globalThis`, the user
 * code sees them as `undefined`.
 */
const BLOCKED_GLOBALS = [
  "process",
  "require",
  "Bun",
  "Deno",
  "__dirname",
  "__filename",
  "importScripts",
  "globalThis",
  "self",
] as const;

/**
 * Build the Worker source that will execute user code in isolation.
 *
 * The generated script:
 * 1. Shadows dangerous globals by passing them as `undefined` parameters
 * 2. Injects the caller-provided `input` object
 * 3. Evaluates the user source via the `AsyncFunction` constructor
 * 4. Posts the result (or error) back to the parent
 */
const buildWorkerSource = (
  source: string,
  inputs: Record<string, unknown>,
  trigger: { data: Record<string, unknown> },
  steps: Record<string, unknown>,
): string => {
  // Escape backticks and backslashes in the user source so it can be
  // safely embedded in a template literal inside the worker script
  const escapedSource = source
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  // Build parameter list: "input, trigger, steps, fetch, process, require, ..."
  // `fetch` is bound to an SSRF-guarded wrapper (below); the blocked globals
  // are bound to `undefined`
  const params = [
    "input",
    "trigger",
    "steps",
    "fetch",
    ...BLOCKED_GLOBALS,
  ].join(", ");

  return `
(async () => {
  try {
    // Use AsyncFunction constructor so user code can use await
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    const __userFn = new AsyncFunction(${JSON.stringify(params)}, \`
      "use strict";
      ${escapedSource}
    \`);

    // Wrap the worker's real fetch in the SSRF guard before exposing it
    const __guardedFetch = (${createGuardedFetch.toString()})(fetch);

    // Call with input, trigger, steps, guarded fetch + undefined for every
    // blocked global
    const __result = await __userFn(
      ${JSON.stringify(inputs)},
      ${JSON.stringify(trigger)},
      ${JSON.stringify(steps)},
      __guardedFetch,
      ${BLOCKED_GLOBALS.map(() => "undefined").join(", ")}
    );

    // Normalise output to a plain object
    const output =
      __result !== null && __result !== undefined && typeof __result === "object" && !Array.isArray(__result)
        ? __result
        : { result: __result };

    self.postMessage({ ok: true, output });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})();
`;
};

/** Error thrown when user code exceeds the configured timeout */
class SandboxTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Code execution timed out after ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Error thrown when user code exceeds the configured memory limit */
class SandboxMemoryError extends Error {
  readonly limitMb: number;

  constructor(limitMb: number) {
    super(`Code execution exceeded memory limit of ${limitMb}MB`);
    this.name = "SandboxMemoryError";
    this.limitMb = limitMb;
  }
}

/** Error thrown when the serialised output exceeds maxOutputBytes */
class SandboxOutputError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Code output exceeded maximum size of ${limitBytes} bytes`);
    this.name = "SandboxOutputError";
    this.limitBytes = limitBytes;
  }
}

/** Error thrown when user code throws at runtime */
class SandboxExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

/**
 * Execute JavaScript source code in an isolated Bun Worker.
 *
 * @param input - Source code, inputs, and resource limits
 * @returns Parsed output from the user code
 * @throws {SandboxTimeoutError} If execution exceeds `limits.timeoutMs`
 * @throws {SandboxMemoryError} If execution exceeds `limits.memoryMb`
 * @throws {SandboxOutputError} If output exceeds `limits.maxOutputBytes`
 * @throws {SandboxExecutionError} If the user code throws
 */
const runSandboxedCode = (input: SandboxInput): Promise<SandboxResult> => {
  const { source, inputs, trigger, steps, limits } = input;
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<SandboxResult>((resolve, reject) => {
    const startTime = performance.now();
    let settled = false;

    const workerSource = buildWorkerSource(
      source,
      inputs,
      trigger ?? { data: {} },
      steps ?? {},
    );
    const blob = new Blob([workerSource], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    const worker = new Worker(workerUrl, {
      smol: true,
    });

    // Arm the timeout
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      reject(new SandboxTimeoutError(limits.timeoutMs));
    }, limits.timeoutMs);

    worker.onmessage = (event: MessageEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      const durationMs = performance.now() - startTime;
      const data = event.data as {
        ok: boolean;
        output?: Record<string, unknown>;
        error?: string;
      };

      if (!data.ok) {
        const message = data.error ?? "Unknown execution error";

        // Detect memory-related errors from the runtime
        if (
          message.includes("out of memory") ||
          message.includes("allocation") ||
          message.includes("Maximum call stack")
        ) {
          reject(new SandboxMemoryError(limits.memoryMb));
          return;
        }

        reject(new SandboxExecutionError(message));
        return;
      }

      const output = data.output ?? {};

      // Enforce output size limit
      const serialised = JSON.stringify(output);
      if (serialised.length > maxOutputBytes) {
        reject(new SandboxOutputError(maxOutputBytes));
        return;
      }

      resolve({ output, durationMs });
    };

    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      const message =
        event.message ?? (event as unknown as { error?: string }).error ?? "";

      // Detect memory-related errors
      if (
        message.includes("out of memory") ||
        message.includes("allocation") ||
        message.includes("Maximum call stack")
      ) {
        reject(new SandboxMemoryError(limits.memoryMb));
        return;
      }

      reject(
        new SandboxExecutionError(
          message || "Worker encountered an unknown error",
        ),
      );
    };
  });
};

/** Code-step sandbox modes, including the in-process `"native"` mode. */
type SandboxMode = "mcp" | "worker" | "wasm" | "native";

/**
 * Resolve the effective sandbox for a code step, enforcing the trust gate.
 *
 * The in-process `"native"` mode is granted ONLY to workflows owned by the
 * platform organization. Any other org (or a missing org / unconfigured
 * platform org) that requests `"native"` is transparently downgraded to the
 * isolated `"worker"` sandbox, so untrusted user code can never opt into
 * in-process execution. All other sandbox values pass through unchanged.
 */
const resolveSandboxMode = (
  sandbox: SandboxMode,
  organizationId: string | undefined,
  platformOrgId: string | undefined,
): SandboxMode => {
  if (sandbox !== "native") return sandbox;
  if (platformOrgId && organizationId === platformOrgId) return "native";
  return "worker";
};

/**
 * Execute trusted, platform-authored code in-process (no Bun Worker).
 *
 * Reserved for platform-org system workflows via {@link resolveSandboxMode}.
 * This avoids the per-execution Worker spawn/terminate churn that
 * {@link runSandboxedCode} incurs (the churn that segfaults Bun under load).
 * The code runs with the real `fetch` and the same `input`/`trigger`/`steps`
 * interface; isolation is intentionally NOT applied because the code is
 * platform-authored and trusted.
 *
 * The timeout bounds asynchronous work via `Promise.race`; a runaway
 * synchronous loop cannot be interrupted in-process, so this path must only
 * ever run trusted code.
 */
const runTrustedCode = (input: SandboxInput): Promise<SandboxResult> => {
  const { source, inputs, trigger, steps, limits } = input;
  const startTime = performance.now();

  const AsyncFunction = Object.getPrototypeOf(async () => {})
    .constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const userFn = new AsyncFunction(
    "input",
    "trigger",
    "steps",
    "fetch",
    `"use strict";\n${source}`,
  );

  const execution = Promise.resolve()
    .then(() => userFn(inputs, trigger ?? { data: {} }, steps ?? {}, fetch))
    .then((result) => {
      const output =
        result !== null &&
        result !== undefined &&
        typeof result === "object" &&
        !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };
      return { output, durationMs: performance.now() - startTime };
    })
    .catch((err) => {
      throw new SandboxExecutionError(
        err instanceof Error ? err.message : String(err),
      );
    });

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SandboxTimeoutError(limits.timeoutMs)),
      limits.timeoutMs,
    );
  });

  return Promise.race([execution, timeout]).finally(() => clearTimeout(timer));
};

export type { SandboxInput, SandboxMode, SandboxResult };
export {
  SandboxExecutionError,
  SandboxMemoryError,
  SandboxOutputError,
  SandboxTimeoutError,
  resolveSandboxMode,
  runSandboxedCode,
  runTrustedCode,
};
