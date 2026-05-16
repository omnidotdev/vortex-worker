/**
 * Simple in-memory TTL cache for subscription queries.
 *
 * Avoids hitting the database on every incoming event by caching
 * enabled subscriptions per organization for a short window.
 */

const DEFAULT_TTL_MS = 30_000;

type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

/** Get a cached value if it exists and hasn't expired */
const get = <T>(key: string): T | undefined => {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }

  return entry.data as T;
};

/** Set a value with an optional TTL (defaults to 30s) */
const set = <T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void => {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
};

/** Invalidate a specific key */
const invalidate = (key: string): void => {
  store.delete(key);
};

/** Clear the entire cache */
const clear = (): void => {
  store.clear();
};

export { clear, get, invalidate, set };
