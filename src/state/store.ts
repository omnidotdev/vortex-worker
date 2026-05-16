/**
 * Cross-workflow state store backed by cache
 *
 * Provides org-scoped key-value storage for sharing data between workflows.
 * Uses the centralized cache client from lib/cache/client.ts instead of
 * creating a separate Redis connection.
 */

import { cacheClient } from "lib/cache/client";

function getCache() {
  if (!cacheClient) {
    throw new Error(
      "Cache client not initialized. Ensure initCache() is called at startup",
    );
  }
  return cacheClient;
}

function scopedKey(orgId: string, key: string): string {
  return `vortex:state:${orgId}:${key}`;
}

export const stateStore = {
  async get(orgId: string, key: string): Promise<unknown | null> {
    const value = await getCache().get(scopedKey(orgId, key));
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },

  async set(
    orgId: string,
    key: string,
    value: unknown,
    ttl?: number,
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await getCache().setex(scopedKey(orgId, key), ttl, serialized);
    } else {
      await getCache().set(scopedKey(orgId, key), serialized);
    }
  },

  async delete(orgId: string, key: string): Promise<void> {
    await getCache().del(scopedKey(orgId, key));
  },

  async increment(orgId: string, key: string, by = 1): Promise<number> {
    if (by === 1) {
      return getCache().incr(scopedKey(orgId, key));
    }
    return getCache().incrby(scopedKey(orgId, key), by);
  },

  async append(orgId: string, key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await getCache().rpush(scopedKey(orgId, key), serialized);
  },

  async getList(orgId: string, key: string): Promise<unknown[]> {
    const items = await getCache().lrange(scopedKey(orgId, key), 0, -1);
    return items.map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return item;
      }
    });
  },

  async publish(
    orgId: string,
    channel: string,
    message: unknown,
  ): Promise<void> {
    await getCache().publish(
      `vortex:pubsub:${orgId}:${channel}`,
      JSON.stringify(message),
    );
  },

  async exists(orgId: string, key: string): Promise<boolean> {
    const result = await getCache().exists(scopedKey(orgId, key));
    return result === 1;
  },
};
