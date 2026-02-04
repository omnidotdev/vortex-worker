/**
 * Cross-workflow state store backed by Redis
 *
 * Provides org-scoped key-value storage for sharing data between workflows
 */

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    if (!REDIS_URL) {
      throw new Error("REDIS_URL is required for state store");
    }
    redis = new Redis(REDIS_URL);
  }
  return redis;
}

function scopedKey(orgId: string, key: string): string {
  return `vortex:state:${orgId}:${key}`;
}

export const stateStore = {
  async get(orgId: string, key: string): Promise<unknown | null> {
    const value = await getRedis().get(scopedKey(orgId, key));
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
      await getRedis().setex(scopedKey(orgId, key), ttl, serialized);
    } else {
      await getRedis().set(scopedKey(orgId, key), serialized);
    }
  },

  async delete(orgId: string, key: string): Promise<void> {
    await getRedis().del(scopedKey(orgId, key));
  },

  async increment(
    orgId: string,
    key: string,
    by = 1,
  ): Promise<number> {
    if (by === 1) {
      return getRedis().incr(scopedKey(orgId, key));
    }
    return getRedis().incrby(scopedKey(orgId, key), by);
  },

  async append(orgId: string, key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await getRedis().rpush(scopedKey(orgId, key), serialized);
  },

  async getList(orgId: string, key: string): Promise<unknown[]> {
    const items = await getRedis().lrange(scopedKey(orgId, key), 0, -1);
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
    await getRedis().publish(
      `vortex:pubsub:${orgId}:${channel}`,
      JSON.stringify(message),
    );
  },

  async exists(orgId: string, key: string): Promise<boolean> {
    const result = await getRedis().exists(scopedKey(orgId, key));
    return result === 1;
  },
};
