/**
 * Plugin Pool Tests
 *
 * Tests for the Extism plugin instance pool covering creation,
 * reuse, stats tracking, capacity limits, draining, and concurrency.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { Plugin as ExtismPlugin } from "@extism/extism";

// --- Mock createPlugin ---

let createCount = 0;

const makeFakePlugin = (): ExtismPlugin =>
  ({
    close: mock(() => Promise.resolve()),
    call: mock(() => Promise.resolve(null)),
    functionExists: mock(() => Promise.resolve(true)),
  }) as unknown as ExtismPlugin;

mock.module("@extism/extism", () => ({
  createPlugin: mock(async () => {
    createCount++;
    return makeFakePlugin();
  }),
}));

// Must import AFTER mock.module
const { default: PluginPool } = await import("../plugins/pool");

const MANIFEST = { wasm: [{ data: new Uint8Array([0]) }] };

describe("PluginPool", () => {
  let pool: InstanceType<typeof PluginPool>;

  beforeEach(() => {
    createCount = 0;
    pool = new PluginPool({ maxSize: 2, idleTimeoutMs: 60_000 });
  });

  afterEach(async () => {
    await pool.drain();
  });

  // --- Creation and reuse ---

  describe("instance creation", () => {
    it("should create a new instance on first acquire", async () => {
      const plugin = await pool.acquire("p1", MANIFEST);

      expect(plugin).toBeDefined();
      expect(createCount).toBe(1);
    });

    it("should create instances up to maxSize", async () => {
      const a = await pool.acquire("p1", MANIFEST);
      const b = await pool.acquire("p1", MANIFEST);

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(createCount).toBe(2);
    });

    it("should not create beyond maxSize", async () => {
      await pool.acquire("p1", MANIFEST);
      await pool.acquire("p1", MANIFEST);

      // Third acquire should block (not create)
      let resolved = false;
      const pending = pool.acquire("p1", MANIFEST).then((p) => {
        resolved = true;
        return p;
      });

      // Let microtasks settle
      await new Promise((r) => setTimeout(r, 10));

      expect(resolved).toBe(false);
      expect(createCount).toBe(2);

      // Clean up: release one so the waiter resolves
      const stats = pool.stats("p1");
      // Active should be 2 since we acquired two
      expect(stats.active).toBe(2);

      // Drain will reject the waiter
      await pool.drain().catch(() => {});
      await pending.catch(() => {});
    });
  });

  describe("instance reuse", () => {
    it("should reuse a released instance", async () => {
      const first = await pool.acquire("p1", MANIFEST);
      pool.release("p1", first);

      const second = await pool.acquire("p1", MANIFEST);

      // Same reference, no new creation
      expect(second).toBe(first);
      expect(createCount).toBe(1);
    });

    it("should hand released instance to a waiting caller", async () => {
      const a = await pool.acquire("p1", MANIFEST);
      const b = await pool.acquire("p1", MANIFEST);

      // Third acquire will wait
      let waitedPlugin: ExtismPlugin | null = null;
      const waiterPromise = pool.acquire("p1", MANIFEST).then((p) => {
        waitedPlugin = p;
        return p;
      });

      // Let microtasks run — waiter should still be pending
      await new Promise((r) => setTimeout(r, 10));
      expect(waitedPlugin).toBeNull();

      // Release one — waiter should get it
      pool.release("p1", a);
      await waiterPromise;

      expect(waitedPlugin as unknown).toBe(a);
      expect(createCount).toBe(2);

      // Clean up
      pool.release("p1", b);
      pool.release("p1", waitedPlugin as unknown as ExtismPlugin);
    });
  });

  // --- Stats ---

  describe("stats", () => {
    it("should return zeroes for unknown plugin", () => {
      expect(pool.stats("unknown")).toEqual({
        total: 0,
        idle: 0,
        active: 0,
      });
    });

    it("should track active instances", async () => {
      await pool.acquire("p1", MANIFEST);

      expect(pool.stats("p1")).toEqual({
        total: 1,
        idle: 0,
        active: 1,
      });
    });

    it("should track idle instances after release", async () => {
      const p = await pool.acquire("p1", MANIFEST);
      pool.release("p1", p);

      expect(pool.stats("p1")).toEqual({
        total: 1,
        idle: 1,
        active: 0,
      });
    });

    it("should track mixed active and idle", async () => {
      const a = await pool.acquire("p1", MANIFEST);
      await pool.acquire("p1", MANIFEST);
      pool.release("p1", a);

      expect(pool.stats("p1")).toEqual({
        total: 2,
        idle: 1,
        active: 1,
      });
    });
  });

  // --- Drain ---

  describe("drain", () => {
    it("should close all idle instances", async () => {
      const a = await pool.acquire("p1", MANIFEST);
      const b = await pool.acquire("p1", MANIFEST);
      pool.release("p1", a);
      pool.release("p1", b);

      await pool.drain();

      expect(a.close).toHaveBeenCalled();
      expect(b.close).toHaveBeenCalled();
      expect(pool.stats("p1")).toEqual({ total: 0, idle: 0, active: 0 });
    });

    it("should reject pending waiters", async () => {
      await pool.acquire("p1", MANIFEST);
      await pool.acquire("p1", MANIFEST);

      const waiterPromise = pool.acquire("p1", MANIFEST);

      await pool.drain();

      await expect(waiterPromise).rejects.toThrow("Pool is draining");
    });

    it("should clear all slots", async () => {
      const p = await pool.acquire("p1", MANIFEST);
      pool.release("p1", p);

      await pool.drain();

      expect(pool.stats("p1")).toEqual({ total: 0, idle: 0, active: 0 });
    });
  });

  // --- Per-plugin isolation ---

  describe("per-plugin isolation", () => {
    it("should track separate pools per plugin ID", async () => {
      await pool.acquire("p1", MANIFEST);
      await pool.acquire("p2", MANIFEST);

      expect(pool.stats("p1")).toEqual({ total: 1, idle: 0, active: 1 });
      expect(pool.stats("p2")).toEqual({ total: 1, idle: 0, active: 1 });
      expect(createCount).toBe(2);
    });

    it("should allow maxSize instances per plugin independently", async () => {
      await pool.acquire("p1", MANIFEST);
      await pool.acquire("p1", MANIFEST);
      await pool.acquire("p2", MANIFEST);
      await pool.acquire("p2", MANIFEST);

      expect(createCount).toBe(4);
      expect(pool.stats("p1").active).toBe(2);
      expect(pool.stats("p2").active).toBe(2);
    });
  });

  // --- Concurrent acquire/release ---

  describe("concurrent acquire/release", () => {
    it("should handle rapid acquire and release cycles", async () => {
      const iterations = 10;

      for (let i = 0; i < iterations; i++) {
        const p = await pool.acquire("p1", MANIFEST);
        pool.release("p1", p);
      }

      // Only one instance should have been created due to reuse
      expect(createCount).toBe(1);
      expect(pool.stats("p1")).toEqual({ total: 1, idle: 1, active: 0 });
    });

    it("should handle parallel acquires within capacity", async () => {
      const [a, b] = await Promise.all([
        pool.acquire("p1", MANIFEST),
        pool.acquire("p1", MANIFEST),
      ]);

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(pool.stats("p1").active).toBe(2);

      pool.release("p1", a);
      pool.release("p1", b);

      expect(pool.stats("p1")).toEqual({ total: 2, idle: 2, active: 0 });
    });
  });

  // --- Release edge cases ---

  describe("release edge cases", () => {
    it("should be a no-op for unknown plugin ID", () => {
      const fakePlugin = makeFakePlugin();

      // Should not throw
      pool.release("nonexistent", fakePlugin);
    });
  });
});
