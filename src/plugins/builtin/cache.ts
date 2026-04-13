/**
 * Built-in Cache Plugin
 *
 * Cache values with optional TTL.
 * Uses cache when available, falls back to in-memory Map.
 */

import { cacheClient } from "lib/cache";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type CacheOperation = "get" | "set" | "delete" | "getOrSet";

const KEY_PREFIX = "wk:cache:";

interface CacheEntry {
  value: unknown;
  expiresAt?: number;
}

// In-memory fallback cache
const memoryCache = new Map<string, CacheEntry>();

/**
 * Check if entry is expired.
 */
const isExpired = (entry: CacheEntry): boolean => {
  if (!entry.expiresAt) return false;
  return Date.now() > entry.expiresAt;
};

/**
 * Execute cache operation.
 */
const executeCache = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      operation = "get",
      key,
      value,
      ttl,
    } = inputs as {
      operation?: CacheOperation;
      key: string;
      value?: unknown;
      ttl?: number;
    };

    if (!key) {
      return {
        success: false,
        error: "key is required",
        durationMs: performance.now() - startTime,
      };
    }

    switch (operation) {
      case "get": {
        if (cacheClient) {
          const raw = await cacheClient.get(`${KEY_PREFIX}${key}`);
          if (!raw) {
            return {
              success: true,
              output: { hit: false, key, value: null },
              durationMs: performance.now() - startTime,
            };
          }
          const entry = JSON.parse(raw) as { value: unknown };
          return {
            success: true,
            output: { hit: true, key, value: entry.value },
            durationMs: performance.now() - startTime,
          };
        }

        // In-memory fallback
        const entry = memoryCache.get(key);
        if (!entry || isExpired(entry)) {
          memoryCache.delete(key);
          return {
            success: true,
            output: { hit: false, key, value: null },
            durationMs: performance.now() - startTime,
          };
        }
        return {
          success: true,
          output: { hit: true, key, value: entry.value },
          durationMs: performance.now() - startTime,
        };
      }

      case "set": {
        if (cacheClient) {
          const cacheKey = `${KEY_PREFIX}${key}`;
          const cacheValue = JSON.stringify({ value });
          if (ttl) {
            await cacheClient.set(cacheKey, cacheValue, "EX", ttl);
          } else {
            await cacheClient.set(cacheKey, cacheValue);
          }
          return {
            success: true,
            output: { stored: true, key, ttl },
            durationMs: performance.now() - startTime,
          };
        }

        // In-memory fallback
        const entry: CacheEntry = {
          value,
          expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        };
        memoryCache.set(key, entry);
        return {
          success: true,
          output: { stored: true, key, ttl },
          durationMs: performance.now() - startTime,
        };
      }

      case "delete": {
        if (cacheClient) {
          const deleted = await cacheClient.del(`${KEY_PREFIX}${key}`);
          return {
            success: true,
            output: { deleted: deleted > 0, key },
            durationMs: performance.now() - startTime,
          };
        }

        // In-memory fallback
        const existed = memoryCache.delete(key);
        return {
          success: true,
          output: { deleted: existed, key },
          durationMs: performance.now() - startTime,
        };
      }

      case "getOrSet": {
        if (cacheClient) {
          const raw = await cacheClient.get(`${KEY_PREFIX}${key}`);
          if (raw) {
            const entry = JSON.parse(raw) as { value: unknown };
            return {
              success: true,
              output: { hit: true, key, value: entry.value },
              durationMs: performance.now() - startTime,
            };
          }
          // Cache miss - caller should handle fallback
          return {
            success: true,
            output: { hit: false, key, needsFallback: true },
            durationMs: performance.now() - startTime,
          };
        }

        // In-memory fallback
        const existing = memoryCache.get(key);
        if (existing && !isExpired(existing)) {
          return {
            success: true,
            output: { hit: true, key, value: existing.value },
            durationMs: performance.now() - startTime,
          };
        }
        return {
          success: true,
          output: { hit: false, key, needsFallback: true },
          durationMs: performance.now() - startTime,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown cache operation: ${operation}`,
          durationMs: performance.now() - startTime,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const cachePlugin: BuiltinPlugin = {
  id: "builtin:cache",
  name: "Cache",
  description: "Cache values with optional TTL",
  actions: {
    execute: {
      name: "execute",
      description: "Execute cache operation",
      handler: executeCache,
    },
  },
};
