/**
 * Sandboxed Code Runner
 *
 * Resolves the execution mode for a code step and runs trusted platform code
 * in-process. Untrusted user code is executed only through the WASM/Extism
 * isolate (see `sandbox/extism.ts`), which runs user code in a QuickJS-ng
 * evaluator compiled to WASM with no host bindings.
 *
 * ## Security
 *
 * A previous "worker" mode ran user code in a Bun Worker via the
 * `AsyncFunction` constructor. That mode was escapable: the `Function`
 * constructor reaches the worker's real `globalThis` (which still exposes
 * `process`, `require`, `Bun`, etc.) and dynamic `import()` can load any node
 * builtin, so an isolate-shadowed global was no protection at all. That mode
 * has been removed. `resolveSandboxMode` never yields an in-process/worker
 * mode for untrusted orgs; it downgrades to the WASM isolate instead.
 */

/** Input for a sandboxed code run */
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
    /** Maximum memory in megabytes (advisory) */
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
 * Code-step sandbox modes.
 *
 * - `"native"` runs in-process (trusted platform-org workflows only)
 * - `"wasm"` runs in the QuickJS/Extism WASM isolate (untrusted code)
 * - `"mcp"` runs on an external MCP code-sandbox server
 * - `"worker"` is a legacy alias accepted by the DSL; it is always downgraded
 *   to `"wasm"` because the in-process Bun Worker was escapable
 */
type SandboxMode = "mcp" | "worker" | "wasm" | "native";

/**
 * Resolve the effective sandbox for a code step, enforcing the trust gate.
 *
 * The in-process `"native"` mode is granted ONLY to workflows owned by the
 * platform organization. The escapable `"worker"` mode is never honored: it is
 * always downgraded to the isolated `"wasm"` sandbox, as is any `"native"`
 * request from a non-platform (or missing / unconfigured) org. `"wasm"` and
 * `"mcp"` pass through unchanged. The result is that untrusted user code can
 * only ever reach the WASM isolate or an external MCP sandbox, never an
 * in-process or Bun Worker execution path.
 */
const resolveSandboxMode = (
  sandbox: SandboxMode,
  organizationId: string | undefined,
  platformOrgId: string | undefined,
): SandboxMode => {
  if (sandbox === "native") {
    if (platformOrgId && organizationId === platformOrgId) return "native";
    return "wasm";
  }
  // The Bun Worker sandbox was escapable (Function constructor + dynamic
  // import reach host globals), so it is never a selectable execution mode
  if (sandbox === "worker") return "wasm";
  return sandbox;
};

/**
 * Execute trusted, platform-authored code in-process (no isolation).
 *
 * Reserved for platform-org system workflows via {@link resolveSandboxMode}.
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
  runTrustedCode,
};
