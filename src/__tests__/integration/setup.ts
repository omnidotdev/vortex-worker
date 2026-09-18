import { beforeAll, mock } from "bun:test";

import type { Plugin as ExtismPlugin } from "@extism/extism";

/**
 * Mock the Extism runtime for integration tests.
 *
 * The QuickJS/Extism WASM isolate requires WASI, which is unavailable on Bun,
 * so the real evaluator cannot run in the test process. This fake mirrors the
 * evaluator's contract (`{source, inputs}` in, `{ok, output}` out) so code
 * steps that resolve to the `"wasm"` sandbox (including the downgraded legacy
 * `"worker"` mode) execute deterministically under test.
 */
const makeEvaluatorPlugin = (): ExtismPlugin =>
  ({
    close: mock(() => Promise.resolve()),
    functionExists: mock(() => Promise.resolve(true)),
    call: mock((_functionName: string, inputJson: string) => {
      const { source, inputs } = JSON.parse(inputJson);
      try {
        const fn = new Function("input", source);
        const result = fn(inputs ?? {});
        const output =
          result !== null &&
          result !== undefined &&
          typeof result === "object" &&
          !Array.isArray(result)
            ? result
            : { result };
        const text = JSON.stringify({ ok: true, output });
        const buf = new TextEncoder().encode(text);
        return Promise.resolve({
          text: () => text,
          json: () => JSON.parse(text),
          bytes: () => buf,
          length: buf.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const text = JSON.stringify({ ok: false, error: message });
        const buf = new TextEncoder().encode(text);
        return Promise.resolve({
          text: () => text,
          json: () => JSON.parse(text),
          bytes: () => buf,
          length: buf.length,
        });
      }
    }),
  }) as unknown as ExtismPlugin;

mock.module("@extism/extism", () => ({
  createPlugin: mock(async () => makeEvaluatorPlugin()),
}));

beforeAll(() => {
  process.env.NODE_ENV = "test";
});
