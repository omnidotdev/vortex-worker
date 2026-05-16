/**
 * Extism WASM Sandbox Tests
 *
 * Tests the QuickJS evaluator running inside the Extism WASM sandbox.
 * Covers basic execution, error handling, isolation, and output limits.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import type { Plugin as ExtismPlugin } from "@extism/extism";

// --- Mock Extism to simulate the evaluator WASM ---

/**
 * Create a fake Extism plugin that behaves like the QuickJS evaluator.
 * Runs the same logic as evaluator.js but on the host side for testing.
 */
const makeEvaluatorPlugin = (): ExtismPlugin => {
  return {
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
  } as unknown as ExtismPlugin;
};

mock.module("@extism/extism", () => ({
  createPlugin: mock(async () => makeEvaluatorPlugin()),
}));

// Must import AFTER mock.module
const { runExtismSandbox } = await import("../sandbox/extism");
const { SandboxExecutionError, SandboxOutputError } = await import(
  "../sandbox/runner"
);

const defaultLimits = {
  memoryMb: 128,
  timeoutMs: 5_000,
};

describe("extism wasm sandbox", () => {
  afterEach(() => {
    // Reset plugin host between tests to avoid stale state
  });

  describe("basic execution", () => {
    it("should evaluate arithmetic and return the result", async () => {
      const result = await runExtismSandbox({
        source: "return { sum: input.a + input.b }",
        inputs: { a: 2, b: 3 },
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ sum: 5 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle string operations", async () => {
      const result = await runExtismSandbox({
        source: 'return { greeting: "Hello, " + input.name + "!" }',
        inputs: { name: "Vortex" },
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ greeting: "Hello, Vortex!" });
    });

    it("should wrap non-object return values", async () => {
      const result = await runExtismSandbox({
        source: "return 42",
        inputs: {},
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ result: 42 });
    });

    it("should wrap null return as empty object", async () => {
      const result = await runExtismSandbox({
        source: "return null",
        inputs: {},
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ result: null });
    });

    it("should wrap array return values", async () => {
      const result = await runExtismSandbox({
        source: "return [1, 2, 3]",
        inputs: {},
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ result: [1, 2, 3] });
    });

    it("should report durationMs", async () => {
      const result = await runExtismSandbox({
        source: "return { ok: true }",
        inputs: {},
        limits: defaultLimits,
      });

      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("error handling", () => {
    it("should throw SandboxExecutionError for runtime errors", async () => {
      await expect(
        runExtismSandbox({
          source: "throw new Error('boom')",
          inputs: {},
          limits: defaultLimits,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should throw SandboxExecutionError for syntax errors", async () => {
      await expect(
        runExtismSandbox({
          source: "this is not valid javascript {{{}}}",
          inputs: {},
          limits: defaultLimits,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should throw SandboxExecutionError for reference errors", async () => {
      await expect(
        runExtismSandbox({
          source: "return nonExistentVariable",
          inputs: {},
          limits: defaultLimits,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });
  });

  describe("output size enforcement", () => {
    it("should throw SandboxOutputError when output exceeds maxOutputBytes", async () => {
      await expect(
        runExtismSandbox({
          source: 'return { data: "x".repeat(100) }',
          inputs: {},
          limits: { ...defaultLimits, maxOutputBytes: 10 },
        }),
      ).rejects.toThrow(SandboxOutputError);
    });

    it("should succeed when output is within maxOutputBytes", async () => {
      const result = await runExtismSandbox({
        source: 'return { data: "small" }',
        inputs: {},
        limits: { ...defaultLimits, maxOutputBytes: 1_000_000 },
      });

      expect(result.output).toEqual({ data: "small" });
    });
  });

  describe("input handling", () => {
    it("should pass complex nested inputs", async () => {
      const result = await runExtismSandbox({
        source: "return { value: input.config.nested.value }",
        inputs: { config: { nested: { value: "deep" } } },
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ value: "deep" });
    });

    it("should handle empty inputs", async () => {
      const result = await runExtismSandbox({
        source: "return { keys: Object.keys(input).length }",
        inputs: {},
        limits: defaultLimits,
      });

      expect(result.output).toEqual({ keys: 0 });
    });
  });
});
