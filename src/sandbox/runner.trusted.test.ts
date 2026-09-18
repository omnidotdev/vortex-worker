import { describe, expect, test } from "bun:test";

import { resolveSandboxMode, runTrustedCode } from "./runner";

const PLATFORM_ORG = "33880602-cf32-4d8d-8db3-a4a9994c5d45";

describe("resolveSandboxMode (security gate)", () => {
  test("allows native only for the configured platform org", () => {
    expect(resolveSandboxMode("native", PLATFORM_ORG, PLATFORM_ORG)).toBe(
      "native",
    );
  });

  test("downgrades native to wasm for a non-platform org", () => {
    expect(resolveSandboxMode("native", "some-user-org", PLATFORM_ORG)).toBe(
      "wasm",
    );
  });

  test("downgrades native to wasm when the org is missing", () => {
    expect(resolveSandboxMode("native", undefined, PLATFORM_ORG)).toBe("wasm");
  });

  test("downgrades native to wasm when no platform org is configured", () => {
    expect(resolveSandboxMode("native", PLATFORM_ORG, undefined)).toBe("wasm");
  });

  test("always downgrades the escapable worker mode to wasm", () => {
    // worker is never a selectable execution mode, even for the platform org
    expect(resolveSandboxMode("worker", PLATFORM_ORG, PLATFORM_ORG)).toBe(
      "wasm",
    );
    expect(resolveSandboxMode("worker", "some-user-org", PLATFORM_ORG)).toBe(
      "wasm",
    );
    expect(resolveSandboxMode("worker", undefined, undefined)).toBe("wasm");
  });

  test("passes through wasm/mcp unchanged regardless of org", () => {
    expect(resolveSandboxMode("wasm", "x", PLATFORM_ORG)).toBe("wasm");
    expect(resolveSandboxMode("mcp", "x", PLATFORM_ORG)).toBe("mcp");
  });

  test("never yields an in-process mode for an untrusted org", () => {
    for (const mode of ["native", "worker", "wasm", "mcp"] as const) {
      const resolved = resolveSandboxMode(mode, "untrusted-org", PLATFORM_ORG);
      expect(resolved).not.toBe("native");
      expect(resolved).not.toBe("worker");
    }
  });
});

describe("runTrustedCode (in-process execution)", () => {
  test("executes source in-process and returns the output object", async () => {
    const { output } = await runTrustedCode({
      source: "return { sum: input.a + input.b };",
      inputs: { a: 2, b: 3 },
      limits: { memoryMb: 128, timeoutMs: 5_000 },
    });
    expect(output).toEqual({ sum: 5 });
  });

  test("exposes trigger and steps to the code", async () => {
    const { output } = await runTrustedCode({
      source: "return { t: trigger.data.x, s: steps.prev };",
      inputs: {},
      trigger: { data: { x: 7 } },
      steps: { prev: "ok" },
      limits: { memoryMb: 128, timeoutMs: 5_000 },
    });
    expect(output).toEqual({ t: 7, s: "ok" });
  });

  test("wraps a non-object return as { result }", async () => {
    const { output } = await runTrustedCode({
      source: "return 42;",
      inputs: {},
      limits: { memoryMb: 128, timeoutMs: 5_000 },
    });
    expect(output).toEqual({ result: 42 });
  });

  test("rejects when execution exceeds the timeout", async () => {
    await expect(
      runTrustedCode({
        source: "await new Promise((r) => setTimeout(r, 1_000)); return {};",
        inputs: {},
        limits: { memoryMb: 128, timeoutMs: 50 },
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("propagates an error thrown by the code", async () => {
    await expect(
      runTrustedCode({
        source: "throw new Error('boom');",
        inputs: {},
        limits: { memoryMb: 128, timeoutMs: 5_000 },
      }),
    ).rejects.toThrow(/boom/);
  });
});
