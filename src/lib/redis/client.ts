/**
 * Redis client for distributed caching and coordination.
 *
 * In development, Redis is optional and falls back to in-memory stores.
 * In production, Redis enables shared state across worker instances.
 */

import Redis from "ioredis";

import logger from "lib/logger";

const { REDIS_URL } = process.env;

/**
 * Redis client instance.
 * Will be null if REDIS_URL is not configured.
 */
export let redisClient: Redis | null = null;

/**
 * Initialize Redis connection.
 * Safe to call even if Redis is not configured.
 */
export async function initRedis(): Promise<void> {
  if (!REDIS_URL) return;

  redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  redisClient.on("error", (err) => {
    logger.error("Redis connection error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Wait for connection to be ready
  await new Promise<void>((resolve, reject) => {
    if (!redisClient) return resolve();
    redisClient.once("ready", () => resolve());
    redisClient.once("error", (err) => reject(err));
  });

  logger.info("Redis connected");
}

/**
 * Close Redis connection.
 * Safe to call even if Redis is not configured.
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis disconnected");
  }
}
