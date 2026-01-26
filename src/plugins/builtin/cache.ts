/**
 * Built-in Cache Plugin
 *
 * Cache values with optional TTL.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type CacheOperation = "get" | "set" | "delete" | "getOrSet";

interface CacheEntry {
  value: unknown;
  expiresAt?: number;
}

// In-memory cache (will be replaced with Redis/external cache in production)
const cache = new Map<string, CacheEntry>();

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
    const { operation = "get", key, value, ttl } = inputs as {
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
        const entry = cache.get(key);
        if (!entry || isExpired(entry)) {
          cache.delete(key);
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
        const entry: CacheEntry = {
          value,
          expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        };
        cache.set(key, entry);
        return {
          success: true,
          output: { stored: true, key, ttl },
          durationMs: performance.now() - startTime,
        };
      }

      case "delete": {
        const existed = cache.delete(key);
        return {
          success: true,
          output: { deleted: existed, key },
          durationMs: performance.now() - startTime,
        };
      }

      case "getOrSet": {
        const existing = cache.get(key);
        if (existing && !isExpired(existing)) {
          return {
            success: true,
            output: { hit: true, key, value: existing.value },
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
