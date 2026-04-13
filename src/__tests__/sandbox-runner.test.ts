/**
 * Sandbox Runner Tests
 *
 * Tests for the isolated JavaScript code execution sandbox covering
 * basic execution, timeout enforcement, output limits, host isolation,
 * and async code support.
 */

import { describe, expect, it } from "bun:test";

import {
  SandboxExecutionError,
  SandboxOutputError,
  SandboxTimeoutError,
  runSandboxedCode,
} from "../sandbox/runner";

const DEFAULT_LIMITS = {
  memoryMb: 64,
  timeoutMs: 5_000,
};

describe("runSandboxedCode", () => {
  // --- Basic execution ---

  describe("basic execution", () => {
    it("should execute simple arithmetic and return result", async () => {
      const { output } = await runSandboxedCode({
        source: "return { sum: input.a + input.b };",
        inputs: { a: 2, b: 3 },
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ sum: 5 });
    });

    it("should handle string inputs", async () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: user code is a string, not a template
      const source = "return { greeting: `Hello, ${input.name}!` };";

      const { output } = await runSandboxedCode({
        source,
        inputs: { name: "Vortex" },
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ greeting: "Hello, Vortex!" });
    });

    it("should wrap non-object return values", async () => {
      const { output } = await runSandboxedCode({
        source: "return 42;",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ result: 42 });
    });

    it("should wrap null return as empty result", async () => {
      const { output } = await runSandboxedCode({
        source: "return null;",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ result: null });
    });

    it("should wrap array return values", async () => {
      const { output } = await runSandboxedCode({
        source: "return [1, 2, 3];",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ result: [1, 2, 3] });
    });

    it("should handle complex object outputs", async () => {
      const { output } = await runSandboxedCode({
        source: `
          const items = input.data.map(x => x * 2);
          return { items, count: items.length };
        `,
        inputs: { data: [1, 2, 3] },
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ items: [2, 4, 6], count: 3 });
    });

    it("should report durationMs", async () => {
      const { durationMs } = await runSandboxedCode({
        source: "return { ok: true };",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(durationMs).toBeGreaterThan(0);
    });
  });

  // --- Async code ---

  describe("async code", () => {
    it("should handle async code with await", async () => {
      const { output } = await runSandboxedCode({
        source: `
          const delay = (ms) => new Promise(r => setTimeout(r, ms));
          await delay(10);
          return { waited: true };
        `,
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ waited: true });
    });
  });

  // --- Timeout enforcement ---

  describe("timeout enforcement", () => {
    it("should throw SandboxTimeoutError on infinite loop", async () => {
      await expect(
        runSandboxedCode({
          source: "while (true) {}",
          inputs: {},
          limits: { memoryMb: 64, timeoutMs: 200 },
        }),
      ).rejects.toThrow(SandboxTimeoutError);
    });

    it("should throw SandboxTimeoutError for long-running code", async () => {
      await expect(
        runSandboxedCode({
          source: `
            const start = Date.now();
            while (Date.now() - start < 10000) {}
            return { done: true };
          `,
          inputs: {},
          limits: { memoryMb: 64, timeoutMs: 200 },
        }),
      ).rejects.toThrow(SandboxTimeoutError);
    });
  });

  // --- Output size enforcement ---

  describe("output size enforcement", () => {
    it("should throw SandboxOutputError when output exceeds maxOutputBytes", async () => {
      await expect(
        runSandboxedCode({
          source: `return { data: "x".repeat(1000) };`,
          inputs: {},
          limits: { memoryMb: 64, timeoutMs: 5_000, maxOutputBytes: 50 },
        }),
      ).rejects.toThrow(SandboxOutputError);
    });

    it("should succeed when output is within maxOutputBytes", async () => {
      const { output } = await runSandboxedCode({
        source: 'return { data: "small" };',
        inputs: {},
        limits: {
          memoryMb: 64,
          timeoutMs: 5_000,
          maxOutputBytes: 1_000_000,
        },
      });

      expect(output.data).toBe("small");
    });
  });

  // --- Host isolation ---

  describe("host isolation", () => {
    it("should not have access to process", async () => {
      await expect(
        runSandboxedCode({
          source: "return { pid: process.pid };",
          inputs: {},
          limits: DEFAULT_LIMITS,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should not have access to require", async () => {
      await expect(
        runSandboxedCode({
          source: 'const fs = require("fs"); return { ok: true };',
          inputs: {},
          limits: DEFAULT_LIMITS,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should not have access to Bun globals", async () => {
      await expect(
        runSandboxedCode({
          source: "return { version: Bun.version };",
          inputs: {},
          limits: DEFAULT_LIMITS,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should shadow __dirname as undefined", async () => {
      const { output } = await runSandboxedCode({
        source: "return { dir: __dirname };",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output.dir).toBeUndefined();
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("should throw SandboxExecutionError for syntax errors", async () => {
      await expect(
        runSandboxedCode({
          source: "return {{{;",
          inputs: {},
          limits: DEFAULT_LIMITS,
        }),
      ).rejects.toThrow();
    });

    it("should throw SandboxExecutionError for runtime errors", async () => {
      await expect(
        runSandboxedCode({
          source: "throw new Error('test error');",
          inputs: {},
          limits: DEFAULT_LIMITS,
        }),
      ).rejects.toThrow(SandboxExecutionError);
    });

    it("should propagate user error messages", async () => {
      try {
        await runSandboxedCode({
          source: "throw new Error('custom message');",
          inputs: {},
          limits: DEFAULT_LIMITS,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxExecutionError);
        expect((err as SandboxExecutionError).message).toContain(
          "custom message",
        );
      }
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("should handle empty source returning undefined", async () => {
      const { output } = await runSandboxedCode({
        source: "",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      // undefined return becomes { result: undefined }
      expect(output).toEqual({ result: undefined });
    });

    it("should handle empty inputs", async () => {
      const { output } = await runSandboxedCode({
        source: "return { keys: Object.keys(input) };",
        inputs: {},
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ keys: [] });
    });

    it("should handle deeply nested input objects", async () => {
      const { output } = await runSandboxedCode({
        source: "return { value: input.a.b.c };",
        inputs: { a: { b: { c: 42 } } },
        limits: DEFAULT_LIMITS,
      });

      expect(output).toEqual({ value: 42 });
    });
  });
});
