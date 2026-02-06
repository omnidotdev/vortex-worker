/**
 * Cache client for distributed caching and coordination.
 *
 * In development, cache is optional and falls back to in-memory stores.
 * In production, cache enables shared state across worker instances.
 */

import Redis from "ioredis";

import logger from "lib/logger";

const { CACHE_URL } = process.env;

/**
 * Cache client instance.
 * Will be null if CACHE_URL is not configured.
 */
export let cacheClient: Redis | null = null;

/**
 * Initialize cache connection.
 * Safe to call even if cache is not configured.
 */
export async function initCache(): Promise<void> {
  if (!CACHE_URL) return;

  cacheClient = new Redis(CACHE_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  cacheClient.on("error", (err) => {
    logger.error("Cache connection error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Wait for connection to be ready
  await new Promise<void>((resolve, reject) => {
    if (!cacheClient) return resolve();
    cacheClient.once("ready", () => resolve());
    cacheClient.once("error", (err) => reject(err));
  });

  logger.info("Cache connected");
}

/**
 * Close cache connection.
 * Safe to call even if cache is not configured.
 */
export async function closeCache(): Promise<void> {
  if (cacheClient) {
    await cacheClient.quit();
    cacheClient = null;
    logger.info("Cache disconnected");
  }
}
