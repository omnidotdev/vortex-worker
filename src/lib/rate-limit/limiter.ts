/**
 * Token bucket rate limiter backed by Redis
 */

import { cacheClient } from "lib/cache/client";
import logger from "lib/logger";

type RateLimitConfig = {
  /** Max tokens (burst capacity) */
  maxTokens: number;
  /** Tokens added per second */
  refillRate: number;
  /** Redis key prefix */
  keyPrefix?: string;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
};

/**
 * Lua script implementing atomic token bucket rate limiting.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = maxTokens
 * ARGV[2] = refillRate
 * ARGV[3] = now (ms)
 * ARGV[4] = TTL (seconds)
 *
 * Returns: { allowed (0|1), remaining (number), retryAfterMs (number) }
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = maxTokens
  lastRefill = now
end

local elapsed = (now - lastRefill) / 1000
local refill = elapsed * refillRate
tokens = math.min(tokens + refill, maxTokens)

if tokens >= 1 then
  tokens = tokens - 1
  redis.call("HMSET", key, "tokens", tokens, "lastRefill", now)
  redis.call("EXPIRE", key, ttl)
  return {1, math.floor(tokens), 0}
else
  redis.call("HMSET", key, "tokens", tokens, "lastRefill", now)
  redis.call("EXPIRE", key, ttl)
  local retryAfterMs = math.ceil((1 - tokens) / refillRate * 1000)
  return {0, 0, retryAfterMs}
end
`;

/**
 * Check rate limit and consume a token.
 * @param resource - Resource identifier (e.g., "workflow_execute", "function_invoke")
 * @param organizationId - Organization being rate-limited
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed, remaining tokens, and retry delay if rejected
 */
async function checkRateLimit(
  resource: string,
  organizationId: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  if (!cacheClient) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  }

  const prefix = config.keyPrefix ?? resource;
  const key = `ratelimit:${prefix}:${organizationId}`;
  const now = Date.now();
  const ttlSeconds = Math.ceil((config.maxTokens / config.refillRate) * 2);

  const result = (await cacheClient.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    config.maxTokens,
    config.refillRate,
    now,
    ttlSeconds,
  )) as [number, number, number];

  const [allowed, remaining, retryAfterMs] = result;

  if (!allowed) {
    logger.debug("Rate limit exceeded", {
      resource,
      organizationId,
      retryAfterMs,
    });
  }

  return {
    allowed: allowed === 1,
    remaining,
    ...(allowed === 0 && { retryAfterMs }),
  };
}

/** Default rate limit configs by resource type */
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  workflow_execute: { maxTokens: 100, refillRate: 10 },
  function_invoke: { maxTokens: 200, refillRate: 20 },
  event_publish: { maxTokens: 500, refillRate: 50 },
};

/** Generous fallback for unknown resource types */
const FALLBACK_LIMIT: RateLimitConfig = {
  maxTokens: 1000,
  refillRate: 100,
};

/**
 * Check if a resource is rate-limited, using default configs when none provided.
 * @param resource - Resource identifier
 * @param organizationId - Organization being rate-limited
 * @param config - Optional override config (falls back to DEFAULT_LIMITS or a generous default)
 */
async function isRateLimited(
  resource: string,
  organizationId: string,
  config?: RateLimitConfig,
): Promise<RateLimitResult> {
  const resolvedConfig =
    config ?? DEFAULT_LIMITS[resource] ?? FALLBACK_LIMIT;

  return checkRateLimit(resource, organizationId, resolvedConfig);
}

export { checkRateLimit, isRateLimited, DEFAULT_LIMITS };
export type { RateLimitConfig, RateLimitResult };
