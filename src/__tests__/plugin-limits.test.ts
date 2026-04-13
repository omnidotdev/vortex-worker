/**
 * Plugin Limits Tests
 *
 * Tests for memory limit conversion and maxOutputSize enforcement.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { Plugin as ExtismPlugin } from "@extism/extism";

// --- Mock createPlugin to capture options ---

let lastCreateOptions: Record<string, unknown> | undefined;

const makeFakePlugin = (resultText = '{"ok":true}'): ExtismPlugin =>
  ({
    close: mock(() => Promise.resolve()),
    call: mock(() => {
      const buf = new TextEncoder().encode(resultText);
      return Promise.resolve({
        text: () => resultText,
        json: () => JSON.parse(resultText),
        bytes: () => buf,
        length: buf.length,
      });
    }),
    functionExists: mock(() => Promise.resolve(true)),
  }) as unknown as ExtismPlugin;

mock.module("@extism/extism", () => ({
  createPlugin: mock(async (_manifest: unknown, options?: unknown) => {
    lastCreateOptions = options as Record<string, unknown> | undefined;
    return makeFakePlugin();
  }),
}));

// Must import AFTER mock.module
const { ExtismPluginHost } = await import("../plugins/host");
const { PluginMemoryError } = await import("../plugins/interface");

import type { PluginManifest } from "../plugins/types";

const baseManifest: PluginManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  wasm: { bytes: new Uint8Array([0]) },
  functions: [
    {
      name: "run",
      inputs: {},
      outputs: { ok: { type: "boolean" } },
    },
  ],
};

// --- Memory limit conversion ---

describe("memory limit conversion", () => {
  let host: InstanceType<typeof ExtismPluginHost>;

  beforeEach(() => {
    lastCreateOptions = undefined;
    host = new ExtismPluginHost();
  });

  afterEach(async () => {
    await host.unloadAll();
  });

  it("should convert memory MB to WASM pages and pass to createPlugin", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      limits: { memory: 128 },
    };

    const loaded = await host.load(manifest);
    // Trigger instance creation by calling the function
    await loaded.call("run", {});

    // 128 MB = 128 * 1024 * 1024 bytes / 65536 bytes per page = 2048 pages
    expect(lastCreateOptions).toBeDefined();
    expect(lastCreateOptions?.memoryLimitPages).toBe(2048);
  });

  it("should convert non-power-of-two memory to ceiling pages", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-odd",
      limits: { memory: 1 },
    };

    const loaded = await host.load(manifest);
    await loaded.call("run", {});

    // 1 MB = 1 * 1024 * 1024 / 65536 = 16 pages (exact)
    expect(lastCreateOptions?.memoryLimitPages).toBe(16);
  });

  it("should not pass memoryLimitPages when no memory limit set", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-no-limit",
      limits: { timeout: 5000 },
    };

    const loaded = await host.load(manifest);
    await loaded.call("run", {});

    expect(lastCreateOptions?.memoryLimitPages).toBeUndefined();
  });

  it("should not pass memoryLimitPages when no limits object", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-no-limits",
    };

    const loaded = await host.load(manifest);
    await loaded.call("run", {});

    expect(lastCreateOptions?.memoryLimitPages).toBeUndefined();
  });
});

// --- maxOutputSize enforcement ---

describe("maxOutputSize enforcement", () => {
  let host: InstanceType<typeof ExtismPluginHost>;

  beforeEach(() => {
    host = new ExtismPluginHost();
  });

  afterEach(async () => {
    await host.unloadAll();
  });

  it("should throw PluginMemoryError when output exceeds maxOutputSize", async () => {
    // Set a very small maxOutputSize (5 bytes)
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-small-output",
      limits: { maxOutputSize: 5 },
    };

    const loaded = await host.load(manifest);

    // The mock returns '{"ok":true}' which is 11 bytes, exceeding the 5-byte limit
    await expect(loaded.call("run", {})).rejects.toThrow(PluginMemoryError);
  });

  it("should succeed when output is within maxOutputSize", async () => {
    // Set maxOutputSize large enough for the output
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-large-output",
      limits: { maxOutputSize: 1_000_000 },
    };

    const loaded = await host.load(manifest);
    const result = await loaded.call("run", {});

    expect(result.success).toBe(true);
  });

  it("should succeed when no maxOutputSize is set", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-no-max",
    };

    const loaded = await host.load(manifest);
    const result = await loaded.call("run", {});

    expect(result.success).toBe(true);
  });

  it("should succeed when result is null (no output)", async () => {
    // Override the mock to return null for this specific test
    mock.module("@extism/extism", () => ({
      createPlugin: mock(async () => ({
        close: mock(() => Promise.resolve()),
        call: mock(() => Promise.resolve(null)),
        functionExists: mock(() => Promise.resolve(true)),
      })),
    }));

    // Re-import with new mock
    const { ExtismPluginHost: FreshHost } = await import("../plugins/host");
    const freshHost = new FreshHost();

    const manifest: PluginManifest = {
      ...baseManifest,
      id: "test-plugin-null-output",
      limits: { maxOutputSize: 5 },
    };

    const loaded = await freshHost.load(manifest);
    const result = await loaded.call("run", {});

    expect(result.success).toBe(true);
    await freshHost.unloadAll();
  });
});
