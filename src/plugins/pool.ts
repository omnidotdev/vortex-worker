/**
 * Plugin Instance Pool
 *
 * Manages a pool of Extism plugin instances per plugin ID so concurrent
 * workflow executions can run in parallel instead of serializing on a
 * single cached instance. Idle instances are evicted after a configurable
 * timeout.
 */

import { createPlugin } from "@extism/extism";

import type { Plugin as ExtismPlugin } from "@extism/extism";

/** Configuration for the plugin pool */
type PoolConfig = {
  /** Max instances per plugin (default: 4) */
  maxSize: number;
  /** Idle timeout before eviction in ms (default: 300_000) */
  idleTimeoutMs: number;
};

/** Stats for a single plugin ID within the pool */
type PoolStats = {
  total: number;
  idle: number;
  active: number;
};

/** Options forwarded to `createPlugin` when spawning a new instance */
type CreatePluginOptions = Parameters<typeof createPlugin>[1];

/** Wrapper around an idle instance so we can track when it became idle */
type IdleEntry = {
  plugin: ExtismPlugin;
  idleSince: number;
};

/** Per-plugin-ID state tracking */
type PluginSlot = {
  idle: IdleEntry[];
  active: number;
  /** Queued callers waiting for capacity */
  waiters: Array<{
    resolve: (plugin: ExtismPlugin) => void;
    reject: (error: Error) => void;
  }>;
};

const DEFAULT_CONFIG: PoolConfig = {
  maxSize: 4,
  idleTimeoutMs: 300_000,
};

/**
 * Pool of Extism plugin instances keyed by plugin ID.
 *
 * Acquire returns an idle instance if available, creates one if under
 * capacity, or waits until one is released when at max.
 */
class PluginPool {
  private config: PoolConfig;
  private slots: Map<string, PluginSlot> = new Map();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Run eviction sweep every half the idle timeout
    this.evictionTimer = setInterval(
      () => this.evictIdle(),
      Math.max(this.config.idleTimeoutMs / 2, 1000),
    );
  }

  /**
   * Acquire an Extism plugin instance for the given plugin ID.
   *
   * If an idle instance is available it is returned immediately.
   * If under capacity a new instance is created via `createPlugin`.
   * If at capacity the caller waits until one is released.
   *
   * @param pluginId - Unique plugin identifier
   * @param manifest - Extism manifest (wasm array)
   * @param options - Options forwarded to `createPlugin`
   */
  async acquire(
    pluginId: string,
    manifest: Parameters<typeof createPlugin>[0],
    options?: CreatePluginOptions,
  ): Promise<ExtismPlugin> {
    const slot = this.getOrCreateSlot(pluginId);

    // Try to reuse an idle instance
    const entry = slot.idle.pop();
    if (entry) {
      slot.active++;
      return entry.plugin;
    }

    // Under capacity, spin up a new instance
    const total = slot.active + slot.idle.length;
    if (total < this.config.maxSize) {
      slot.active++;

      try {
        const plugin = await createPlugin(manifest, options);
        return plugin;
      } catch (error) {
        // Roll back the active count on failure
        slot.active--;
        throw error;
      }
    }

    // At capacity, wait for a release
    return new Promise<ExtismPlugin>((resolve, reject) => {
      slot.waiters.push({ resolve, reject });
    });
  }

  /**
   * Return a plugin instance to the pool after use.
   *
   * If waiters are queued the instance is handed directly to the next
   * waiter. Otherwise it enters the idle set.
   */
  release(pluginId: string, plugin: ExtismPlugin): void {
    const slot = this.slots.get(pluginId);
    if (!slot) return;

    slot.active = Math.max(0, slot.active - 1);

    // Hand off to the next waiter if any
    const waiter = slot.waiters.shift();
    if (waiter) {
      slot.active++;
      waiter.resolve(plugin);
      return;
    }

    // Return to idle set
    slot.idle.push({ plugin, idleSince: Date.now() });
  }

  /**
   * Return pool stats for a given plugin ID.
   */
  stats(pluginId: string): PoolStats {
    const slot = this.slots.get(pluginId);
    if (!slot) {
      return { total: 0, idle: 0, active: 0 };
    }

    return {
      total: slot.active + slot.idle.length,
      idle: slot.idle.length,
      active: slot.active,
    };
  }

  /**
   * Close all instances and reject any pending waiters.
   */
  async drain(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }

    const closePromises: Promise<void>[] = [];

    for (const [, slot] of this.slots) {
      // Reject waiters
      for (const waiter of slot.waiters) {
        waiter.reject(new Error("Pool is draining"));
      }
      slot.waiters = [];

      // Close idle instances
      for (const entry of slot.idle) {
        closePromises.push(entry.plugin.close());
      }
      slot.idle = [];
      slot.active = 0;
    }

    await Promise.all(closePromises);
    this.slots.clear();
  }

  /** Evict idle instances that have exceeded the idle timeout */
  private evictIdle(): void {
    const now = Date.now();
    const cutoff = now - this.config.idleTimeoutMs;

    for (const [, slot] of this.slots) {
      const kept: IdleEntry[] = [];
      for (const entry of slot.idle) {
        if (entry.idleSince < cutoff) {
          // Fire-and-forget close; errors are swallowed
          entry.plugin.close().catch(() => {});
        } else {
          kept.push(entry);
        }
      }
      slot.idle = kept;
    }
  }

  private getOrCreateSlot(pluginId: string): PluginSlot {
    let slot = this.slots.get(pluginId);
    if (!slot) {
      slot = { idle: [], active: 0, waiters: [] };
      this.slots.set(pluginId, slot);
    }
    return slot;
  }
}

export default PluginPool;

export type { CreatePluginOptions, PoolConfig, PoolStats };
