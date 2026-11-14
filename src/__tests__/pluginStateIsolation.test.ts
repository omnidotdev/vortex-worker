/**
 * Plugin state isolation security tests.
 *
 * The WASM host functions `vortex_state_get` / `vortex_state_set` used the org
 * id the plugin passed in, falling back to the executing workflow's org only
 * when the plugin passed none. Any plugin (or tenant WASM function) could
 * therefore read and write another organization's workflow state by naming
 * its org. These tests assert state is bound to the executing workflow's org
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { ExtismPluginHost, resolvePluginStateOrg } from "../plugins/host";
import { stateStore } from "../state/store";

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("resolvePluginStateOrg", () => {
  it("binds to the executing workflow's org", () => {
    expect(resolvePluginStateOrg(undefined, ORG_A)).toBe(ORG_A);
    expect(resolvePluginStateOrg("", ORG_A)).toBe(ORG_A);
    expect(resolvePluginStateOrg(ORG_A, ORG_A)).toBe(ORG_A);
  });

  it("denies a plugin-supplied org that differs from the executing org", () => {
    expect(resolvePluginStateOrg(ORG_B, ORG_A)).toBeNull();
  });

  it("denies all state access when no workflow org is executing", () => {
    expect(resolvePluginStateOrg(ORG_B, undefined)).toBeNull();
    expect(resolvePluginStateOrg(undefined, undefined)).toBeNull();
  });
});

type HostFn = (ctx: unknown, ...ptrs: bigint[]) => unknown;

/** Minimal fake of Extism's CallContext */
const fakeCallContext = (
  strings: Record<string, string>,
  hostContext: { organizationId?: string } | undefined,
) => {
  const stored: string[] = [];
  return {
    stored,
    ctx: {
      read: (ptr: bigint) => {
        const value = strings[String(ptr)];
        return value === undefined ? null : { text: () => value };
      },
      store: (value: string) => {
        stored.push(value);
        return BigInt(stored.length);
      },
      hostContext: () => hostContext,
    },
  };
};

describe("vortex_state host functions", () => {
  const host = new ExtismPluginHost();
  const fns = (
    host as unknown as {
      buildHostFunctions: () => { vortex_host: Record<string, HostFn> };
    }
  ).buildHostFunctions().vortex_host;

  const getSpy = spyOn(stateStore, "get").mockResolvedValue("secret" as never);
  const setSpy = spyOn(stateStore, "set").mockResolvedValue(undefined as never);

  afterEach(() => {
    getSpy.mockClear();
    setSpy.mockClear();
  });

  it("refuses to read another org's state", async () => {
    const { ctx, stored } = fakeCallContext(
      { "1": ORG_B, "2": "key" },
      {
        organizationId: ORG_A,
      },
    );

    await fns.vortex_state_get?.(ctx, 1n, 2n);

    expect(getSpy).not.toHaveBeenCalled();
    expect(stored).toEqual(["null"]);
  });

  it("refuses to write another org's state", async () => {
    const { ctx } = fakeCallContext(
      { "1": ORG_B, "2": "key", "3": '"x"' },
      { organizationId: ORG_A },
    );

    await fns.vortex_state_set?.(ctx, 1n, 2n, 3n);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it("refuses state access with no executing org", async () => {
    const { ctx } = fakeCallContext({ "1": ORG_B, "2": "key" }, undefined);

    await fns.vortex_state_get?.(ctx, 1n, 2n);

    expect(getSpy).not.toHaveBeenCalled();
  });

  it("reads and writes the executing org's own state", async () => {
    const read = fakeCallContext({ "2": "key" }, { organizationId: ORG_A });
    await fns.vortex_state_get?.(read.ctx, 1n, 2n);
    expect(getSpy).toHaveBeenCalledWith(ORG_A, "key");

    const write = fakeCallContext(
      { "1": ORG_A, "2": "key", "3": '"x"' },
      { organizationId: ORG_A },
    );
    await fns.vortex_state_set?.(write.ctx, 1n, 2n, 3n);
    expect(setSpy).toHaveBeenCalledWith(ORG_A, "key", "x");
  });
});
