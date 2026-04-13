/**
 * Distributed cron lock using Redis (simplified Redlock for single-instance Redis)
 */

import { randomUUID } from "node:crypto";

import { cacheClient } from "lib/cache/client";
import logger from "lib/logger";

/** Lua script for atomic compare-and-delete */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Acquire a distributed lock for cron execution.
 * @param workflowId - Workflow being scheduled
 * @param ttlMs - Lock TTL in milliseconds (default: 300000 = 5 min)
 * @returns Lock token if acquired, null if lock held by another instance
 */
async function acquireCronLock(
  workflowId: string,
  ttlMs = 300_000,
): Promise<string | null> {
  const token = randomUUID();
  const key = `cron:lock:${workflowId}`;

  if (!cacheClient) {
    logger.debug("Cache not configured, granting cron lock", { workflowId });
    return token;
  }

  const result = await cacheClient.set(key, token, "PX", ttlMs, "NX");

  if (result === "OK") {
    logger.debug("Cron lock acquired", { workflowId, ttlMs });
    return token;
  }

  logger.debug("Cron lock already held", { workflowId });

  return null;
}

/**
 * Release a cron lock.
 * @param workflowId - Workflow to unlock
 * @param token - Lock token from `acquireCronLock`
 */
async function releaseCronLock(
  workflowId: string,
  token: string,
): Promise<void> {
  if (!cacheClient) return;

  const key = `cron:lock:${workflowId}`;

  const result = await cacheClient.eval(RELEASE_SCRIPT, 1, key, token);

  if (result === 0) {
    logger.warn("Cron lock release failed, token mismatch", { workflowId });
  } else {
    logger.debug("Cron lock released", { workflowId });
  }
}

/**
 * Execute a function with a distributed cron lock.
 * Acquires lock, runs fn, releases lock. If lock not acquired, returns null.
 * @param workflowId - Workflow to lock
 * @param fn - Function to execute while holding the lock
 * @param ttlMs - Lock TTL in milliseconds
 * @returns Result of fn, or null if lock was not acquired
 */
async function withCronLock<T>(
  workflowId: string,
  fn: () => Promise<T>,
  ttlMs?: number,
): Promise<T | null> {
  const token = await acquireCronLock(workflowId, ttlMs);

  if (!token) return null;

  try {
    return await fn();
  } finally {
    await releaseCronLock(workflowId, token);
  }
}

export { acquireCronLock, releaseCronLock, withCronLock };
