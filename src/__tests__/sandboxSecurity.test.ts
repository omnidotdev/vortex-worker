/**
 * Sandbox trust-gate security tests (P0-2).
 *
 * The `code` node previously honored a `sandbox: "worker"` mode that ran
 * untrusted source in a Bun Worker. That Worker was escapable: the `Function`
 * constructor reaches the worker's real `globalThis` (exposing `process`,
 * `require`, `Bun`) and dynamic `import()` loads any node builtin, giving RCE
 * and secret exfiltration. These tests assert the escapable primitive is gone
 * and that the trust gate never yields an in-process/worker mode for untrusted
 * orgs.
 */

import { describe, expect, it } from "bun:test";

import * as runner from "../sandbox/runner";
import { resolveSandboxMode } from "../sandbox/runner";

const PLATFORM_ORG = "33880602-cf32-4d8d-8db3-a4a9994c5d45";

describe("sandbox trust gate", () => {
  it("no longer exports the escapable Bun Worker primitive", () => {
    // runSandboxedCode / buildWorkerSource were the RCE primitive; they must
    // not exist any more, so nothing can be re-wired to them
    expect(
      (runner as Record<string, unknown>).runSandboxedCode,
    ).toBeUndefined();
    expect(
      (runner as Record<string, unknown>).buildWorkerSource,
    ).toBeUndefined();
  });

  it("never resolves an untrusted org to native or worker", () => {
    const untrustedOrgs = [undefined, "user-org-a", "user-org-b"];
    const requestedModes = ["native", "worker", "wasm", "mcp"] as const;

    for (const org of untrustedOrgs) {
      for (const mode of requestedModes) {
        const resolved = resolveSandboxMode(mode, org, PLATFORM_ORG);
        expect(resolved).not.toBe("native");
        expect(resolved).not.toBe("worker");
      }
    }
  });

  it("downgrades worker to the wasm isolate for every org", () => {
    expect(resolveSandboxMode("worker", PLATFORM_ORG, PLATFORM_ORG)).toBe(
      "wasm",
    );
    expect(resolveSandboxMode("worker", "user-org", PLATFORM_ORG)).toBe("wasm");
  });

  it("grants in-process native only to the platform org", () => {
    expect(resolveSandboxMode("native", PLATFORM_ORG, PLATFORM_ORG)).toBe(
      "native",
    );
    expect(resolveSandboxMode("native", "user-org", PLATFORM_ORG)).toBe("wasm");
  });
});
