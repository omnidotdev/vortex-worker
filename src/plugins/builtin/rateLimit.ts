/**
 * Built-in Rate Limit Plugin
 *
 * Throttling and rate limiting for workflow steps and API calls.
 * Supports token bucket, sliding window, and fixed window algorithms.
 * Uses cache with Lua scripts for atomic operations when available,
 * falls back to in-memory Maps.
 */

import { cacheClient } from "lib/cache";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type RateLimitAlgorithm = "token_bucket" | "sliding_window" | "fixed_window";

/** Rate limit configuration */
interface RateLimitConfig {
  /** Unique key for this rate limit (e.g., API endpoint, user ID) */
  key: string;
  /** Maximum requests allowed */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Algorithm to use */
  algorithm?: RateLimitAlgorithm;
  /** Burst capacity for token bucket (default: same as limit) */
  burstCapacity?: number;
  /** Refill rate per second for token bucket (default: limit/windowSeconds) */
  refillRate?: number;
}

/** Acquire token input */
interface AcquireInput extends RateLimitConfig {
  /** Number of tokens to acquire (default: 1) */
  tokens?: number;
  /** Wait for token if none available (default: false) */
  wait?: boolean;
  /** Max wait time in ms (default: 30000) */
  maxWaitMs?: number;
}

/** Check limit input */
interface CheckInput {
  /** Rate limit key */
  key: string;
}

/** Reset limit input */
interface ResetInput {
  /** Rate limit key */
  key: string;
}

// Cache key prefixes
const TB_PREFIX = "wk:rl:tb:";
const FW_PREFIX = "wk:rl:fw:";
const SW_PREFIX = "wk:rl:sw:";

// Lua scripts for atomic cache operations

const TOKEN_BUCKET_ACQUIRE_LUA = `
local key = KEYS[1]
local tokens_requested = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_rate = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill', 'capacity', 'refillRate')
local current_tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if current_tokens == nil then
  current_tokens = capacity
  last_refill = now
  redis.call('HMSET', key, 'tokens', capacity, 'lastRefill', now, 'capacity', capacity, 'refillRate', refill_rate)
end

local elapsed = (now - last_refill) / 1000
local tokens_to_add = elapsed * refill_rate
current_tokens = math.min(capacity, current_tokens + tokens_to_add)

if current_tokens >= tokens_requested then
  current_tokens = current_tokens - tokens_requested
  redis.call('HMSET', key, 'tokens', current_tokens, 'lastRefill', now)
  local reset_in = math.ceil(((capacity - current_tokens) / refill_rate) * 1000)
  return {1, math.floor(current_tokens), reset_in}
else
  redis.call('HMSET', key, 'tokens', current_tokens, 'lastRefill', now)
  local wait_time = math.ceil(((tokens_requested - current_tokens) / refill_rate) * 1000)
  return {0, math.floor(current_tokens), wait_time}
end
`;

const FIXED_WINDOW_ACQUIRE_LUA = `
local key = KEYS[1]
local tokens = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'count', 'windowStart', 'windowSeconds', 'limit')
local count = tonumber(data[1])
local window_start = tonumber(data[2])

if count == nil then
  count = 0
  window_start = now
  redis.call('HMSET', key, 'count', 0, 'windowStart', now, 'windowSeconds', window_seconds, 'limit', limit)
end

local window_end = window_start + window_seconds * 1000
if now >= window_end then
  count = 0
  window_start = now
  window_end = now + window_seconds * 1000
end

local remaining = limit - count
local reset_in = math.max(0, window_end - now)

if count + tokens <= limit then
  count = count + tokens
  redis.call('HMSET', key, 'count', count, 'windowStart', window_start)
  return {1, remaining - tokens, reset_in}
else
  return {0, remaining, reset_in}
end
`;

const SLIDING_WINDOW_ACQUIRE_LUA = `
local key = KEYS[1]
local tokens = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local cutoff = now - window_seconds * 1000
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

local current_count = redis.call('ZCARD', key)
local remaining = limit - current_count

if current_count + tokens <= limit then
  for i = 1, tokens do
    redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  end
  redis.call('EXPIRE', key, window_seconds + 1)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_in = 0
  if #oldest >= 2 then
    reset_in = math.max(0, tonumber(oldest[2]) + window_seconds * 1000 - now)
  end
  return {1, remaining - tokens, reset_in}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_in = 0
  if #oldest >= 2 then
    reset_in = math.max(0, tonumber(oldest[2]) + window_seconds * 1000 - now)
  end
  return {0, remaining, reset_in}
end
`;

// In-memory rate limit storage (fallback)

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
}

interface WindowState {
  count: number;
  windowStart: number;
  windowSeconds: number;
  limit: number;
}

interface SlidingWindowState {
  requests: number[];
  windowSeconds: number;
  limit: number;
}

const tokenBuckets = new Map<string, TokenBucketState>();
const fixedWindows = new Map<string, WindowState>();
const slidingWindows = new Map<string, SlidingWindowState>();

/**
 * Refill tokens based on elapsed time.
 */
const refillTokens = (state: TokenBucketState): void => {
  const now = Date.now();
  const elapsed = (now - state.lastRefill) / 1000;
  const tokensToAdd = elapsed * state.refillRate;
  state.tokens = Math.min(state.capacity, state.tokens + tokensToAdd);
  state.lastRefill = now;
};

/**
 * Acquire tokens using token bucket algorithm (in-memory).
 */
const acquireTokenBucketMemory = (
  key: string,
  tokens: number,
  config: AcquireInput,
): { allowed: boolean; remaining: number; resetIn: number } => {
  let bucket = tokenBuckets.get(key);

  if (!bucket) {
    const capacity = config.burstCapacity ?? config.limit;
    const refillRate = config.refillRate ?? config.limit / config.windowSeconds;
    bucket = {
      tokens: capacity,
      lastRefill: Date.now(),
      capacity,
      refillRate,
    };
    tokenBuckets.set(key, bucket);
  }

  refillTokens(bucket);

  if (bucket.tokens >= tokens) {
    bucket.tokens -= tokens;
    const resetIn = Math.ceil(
      ((bucket.capacity - bucket.tokens) / bucket.refillRate) * 1000,
    );
    return { allowed: true, remaining: Math.floor(bucket.tokens), resetIn };
  }

  const waitTime = Math.ceil(
    ((tokens - bucket.tokens) / bucket.refillRate) * 1000,
  );
  return {
    allowed: false,
    remaining: Math.floor(bucket.tokens),
    resetIn: waitTime,
  };
};

/**
 * Acquire tokens using fixed window algorithm (in-memory).
 */
const acquireFixedWindowMemory = (
  key: string,
  tokens: number,
  config: AcquireInput,
): { allowed: boolean; remaining: number; resetIn: number } => {
  const now = Date.now();
  let window = fixedWindows.get(key);

  if (!window) {
    window = {
      count: 0,
      windowStart: now,
      windowSeconds: config.windowSeconds,
      limit: config.limit,
    };
    fixedWindows.set(key, window);
  }

  // Check if window has expired
  const windowEnd = window.windowStart + window.windowSeconds * 1000;
  if (now >= windowEnd) {
    window.count = 0;
    window.windowStart = now;
  }

  const remaining = window.limit - window.count;
  const resetIn = Math.max(0, windowEnd - now);

  if (window.count + tokens <= window.limit) {
    window.count += tokens;
    return { allowed: true, remaining: remaining - tokens, resetIn };
  }

  return { allowed: false, remaining, resetIn };
};

/**
 * Acquire tokens using sliding window algorithm (in-memory).
 */
const acquireSlidingWindowMemory = (
  key: string,
  tokens: number,
  config: AcquireInput,
): { allowed: boolean; remaining: number; resetIn: number } => {
  const now = Date.now();
  let window = slidingWindows.get(key);

  if (!window) {
    window = {
      requests: [],
      windowSeconds: config.windowSeconds,
      limit: config.limit,
    };
    slidingWindows.set(key, window);
  }

  // Remove expired requests
  const cutoff = now - window.windowSeconds * 1000;
  window.requests = window.requests.filter((t) => t > cutoff);

  const remaining = window.limit - window.requests.length;

  if (window.requests.length + tokens <= window.limit) {
    // Add timestamps for acquired tokens
    for (let i = 0; i < tokens; i++) {
      window.requests.push(now);
    }
    const oldestRequest = window.requests[0];
    const resetIn = oldestRequest
      ? Math.max(0, oldestRequest + window.windowSeconds * 1000 - now)
      : 0;
    return { allowed: true, remaining: remaining - tokens, resetIn };
  }

  const oldestRequest = window.requests[0];
  const resetIn = oldestRequest
    ? Math.max(0, oldestRequest + window.windowSeconds * 1000 - now)
    : 0;
  return { allowed: false, remaining, resetIn };
};

/**
 * Acquire rate limit tokens via cache Lua script.
 */
const acquireDistributed = async (
  key: string,
  tokens: number,
  config: AcquireInput,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> => {
  const algorithm = config.algorithm ?? "token_bucket";
  const now = Date.now();

  switch (algorithm) {
    case "token_bucket": {
      const capacity = config.burstCapacity ?? config.limit;
      const refillRate =
        config.refillRate ?? config.limit / config.windowSeconds;
      const result = (await cacheClient!.eval(
        TOKEN_BUCKET_ACQUIRE_LUA,
        1,
        `${TB_PREFIX}${key}`,
        tokens,
        capacity,
        refillRate,
        now,
      )) as number[];
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetIn: result[2],
      };
    }
    case "fixed_window": {
      const result = (await cacheClient!.eval(
        FIXED_WINDOW_ACQUIRE_LUA,
        1,
        `${FW_PREFIX}${key}`,
        tokens,
        config.windowSeconds,
        config.limit,
        now,
      )) as number[];
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetIn: result[2],
      };
    }
    case "sliding_window": {
      const result = (await cacheClient!.eval(
        SLIDING_WINDOW_ACQUIRE_LUA,
        1,
        `${SW_PREFIX}${key}`,
        tokens,
        config.windowSeconds,
        config.limit,
        now,
      )) as number[];
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetIn: result[2],
      };
    }
  }
};

/**
 * Acquire rate limit tokens (dispatches to cache or in-memory).
 */
const acquireTokens = async (
  key: string,
  tokens: number,
  config: AcquireInput,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> => {
  if (cacheClient) {
    return acquireDistributed(key, tokens, config);
  }

  const algorithm = config.algorithm ?? "token_bucket";
  switch (algorithm) {
    case "token_bucket":
      return acquireTokenBucketMemory(key, tokens, config);
    case "fixed_window":
      return acquireFixedWindowMemory(key, tokens, config);
    case "sliding_window":
      return acquireSlidingWindowMemory(key, tokens, config);
  }
};

/**
 * Sleep helper.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire rate limit token(s).
 */
const acquire = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as AcquireInput;
    const tokens = input.tokens ?? 1;
    const algorithm = input.algorithm ?? "token_bucket";

    let result = await acquireTokens(input.key, tokens, input);

    // Wait for token if requested
    if (!result.allowed && input.wait) {
      const maxWaitMs = input.maxWaitMs ?? 30000;
      const waitTime = Math.min(result.resetIn, maxWaitMs);

      if (waitTime > 0 && waitTime <= maxWaitMs) {
        await sleep(waitTime);
        result = await acquireTokens(input.key, tokens, input);
      }
    }

    return {
      success: true,
      output: {
        allowed: result.allowed,
        remaining: result.remaining,
        resetInMs: result.resetIn,
        key: input.key,
        algorithm,
        tokensRequested: tokens,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Check current rate limit status without consuming tokens.
 */
const check = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CheckInput;
    const now = Date.now();

    if (cacheClient) {
      // Check cache for each algorithm type
      const tbData = await cacheClient.hmget(
        `${TB_PREFIX}${input.key}`,
        "tokens",
        "lastRefill",
        "capacity",
        "refillRate",
      );
      if (tbData[0] !== null) {
        const currentTokens = parseFloat(tbData[0]);
        const lastRefill = parseFloat(tbData[1]!);
        const capacity = parseFloat(tbData[2]!);
        const refillRate = parseFloat(tbData[3]!);
        const elapsed = (now - lastRefill) / 1000;
        const tokens = Math.min(capacity, currentTokens + elapsed * refillRate);
        const resetIn = Math.ceil(((capacity - tokens) / refillRate) * 1000);
        return {
          success: true,
          output: {
            exists: true,
            key: input.key,
            algorithm: "token_bucket",
            limit: capacity,
            remaining: Math.floor(tokens),
            resetInMs: resetIn,
          },
          durationMs: performance.now() - startTime,
        };
      }

      const fwData = await cacheClient.hmget(
        `${FW_PREFIX}${input.key}`,
        "count",
        "windowStart",
        "windowSeconds",
        "limit",
      );
      if (fwData[0] !== null) {
        const count = parseInt(fwData[0], 10);
        const windowStart = parseInt(fwData[1]!, 10);
        const windowSeconds = parseInt(fwData[2]!, 10);
        const limit = parseInt(fwData[3]!, 10);
        const windowEnd = windowStart + windowSeconds * 1000;
        let remaining: number;
        let resetIn: number;
        if (now >= windowEnd) {
          remaining = limit;
          resetIn = 0;
        } else {
          remaining = limit - count;
          resetIn = Math.max(0, windowEnd - now);
        }
        return {
          success: true,
          output: {
            exists: true,
            key: input.key,
            algorithm: "fixed_window",
            limit,
            remaining,
            resetInMs: resetIn,
          },
          durationMs: performance.now() - startTime,
        };
      }

      const swCount = await cacheClient.zcard(`${SW_PREFIX}${input.key}`);
      if (swCount > 0) {
        // Estimate remaining - we can't easily get limit from sorted set
        return {
          success: true,
          output: {
            exists: true,
            key: input.key,
            algorithm: "sliding_window",
            currentCount: swCount,
          },
          durationMs: performance.now() - startTime,
        };
      }

      return {
        success: true,
        output: { exists: false, key: input.key },
        durationMs: performance.now() - startTime,
      };
    }

    // In-memory fallback
    const bucket = tokenBuckets.get(input.key);
    const fixed = fixedWindows.get(input.key);
    const sliding = slidingWindows.get(input.key);

    let remaining = 0;
    let resetIn = 0;
    let algorithm: string | undefined;
    let limit = 0;

    if (bucket) {
      refillTokens(bucket);
      remaining = Math.floor(bucket.tokens);
      resetIn = Math.ceil(
        ((bucket.capacity - bucket.tokens) / bucket.refillRate) * 1000,
      );
      algorithm = "token_bucket";
      limit = bucket.capacity;
    } else if (fixed) {
      const windowEnd = fixed.windowStart + fixed.windowSeconds * 1000;
      if (now >= windowEnd) {
        remaining = fixed.limit;
        resetIn = 0;
      } else {
        remaining = fixed.limit - fixed.count;
        resetIn = Math.max(0, windowEnd - now);
      }
      algorithm = "fixed_window";
      limit = fixed.limit;
    } else if (sliding) {
      const cutoff = now - sliding.windowSeconds * 1000;
      const activeRequests = sliding.requests.filter((t) => t > cutoff).length;
      remaining = sliding.limit - activeRequests;
      const oldestRequest = sliding.requests.find((t) => t > cutoff);
      resetIn = oldestRequest
        ? Math.max(0, oldestRequest + sliding.windowSeconds * 1000 - now)
        : 0;
      algorithm = "sliding_window";
      limit = sliding.limit;
    } else {
      return {
        success: true,
        output: {
          exists: false,
          key: input.key,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        exists: true,
        key: input.key,
        algorithm,
        limit,
        remaining,
        resetInMs: resetIn,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Reset rate limit for a key.
 */
const reset = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ResetInput;

    if (cacheClient) {
      const deleted = await cacheClient.del(
        `${TB_PREFIX}${input.key}`,
        `${FW_PREFIX}${input.key}`,
        `${SW_PREFIX}${input.key}`,
      );
      return {
        success: true,
        output: { reset: deleted > 0, key: input.key },
        durationMs: performance.now() - startTime,
      };
    }

    // In-memory fallback
    const hadBucket = tokenBuckets.delete(input.key);
    const hadFixed = fixedWindows.delete(input.key);
    const hadSliding = slidingWindows.delete(input.key);

    return {
      success: true,
      output: {
        reset: hadBucket || hadFixed || hadSliding,
        key: input.key,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Throttle execution - wait until allowed.
 */
const throttle = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as AcquireInput & { maxRetries?: number };
    const maxRetries = input.maxRetries ?? 10;
    const maxWaitMs = input.maxWaitMs ?? 30000;

    let totalWaited = 0;
    let retries = 0;

    while (retries < maxRetries && totalWaited < maxWaitMs) {
      const result = await acquire({ ...input, wait: false }, _context);

      if (!result.success) {
        return result;
      }

      const output = result.output as {
        allowed: boolean;
        resetInMs: number;
      };

      if (output.allowed) {
        return {
          success: true,
          output: {
            allowed: true,
            waitedMs: totalWaited,
            retries,
            key: input.key,
          },
          durationMs: performance.now() - startTime,
        };
      }

      const waitTime = Math.min(output.resetInMs, maxWaitMs - totalWaited);
      if (waitTime <= 0) break;

      await sleep(waitTime);
      totalWaited += waitTime;
      retries++;
    }

    return {
      success: true,
      output: {
        allowed: false,
        waitedMs: totalWaited,
        retries,
        key: input.key,
        reason: totalWaited >= maxWaitMs ? "timeout" : "max_retries",
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Configure a rate limit without acquiring tokens.
 */
const configure = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RateLimitConfig;
    const algorithm = input.algorithm ?? "token_bucket";

    if (cacheClient) {
      const now = Date.now();
      switch (algorithm) {
        case "token_bucket": {
          const capacity = input.burstCapacity ?? input.limit;
          const refillRate =
            input.refillRate ?? input.limit / input.windowSeconds;
          await cacheClient.hmset(`${TB_PREFIX}${input.key}`, {
            tokens: capacity,
            lastRefill: now,
            capacity,
            refillRate,
          });
          break;
        }
        case "fixed_window": {
          await cacheClient.hmset(`${FW_PREFIX}${input.key}`, {
            count: 0,
            windowStart: now,
            windowSeconds: input.windowSeconds,
            limit: input.limit,
          });
          break;
        }
        case "sliding_window": {
          // Just ensure key exists by removing old data
          await cacheClient.del(`${SW_PREFIX}${input.key}`);
          break;
        }
      }
    } else {
      // In-memory fallback
      switch (algorithm) {
        case "token_bucket": {
          const capacity = input.burstCapacity ?? input.limit;
          const refillRate =
            input.refillRate ?? input.limit / input.windowSeconds;
          tokenBuckets.set(input.key, {
            tokens: capacity,
            lastRefill: Date.now(),
            capacity,
            refillRate,
          });
          break;
        }
        case "fixed_window": {
          fixedWindows.set(input.key, {
            count: 0,
            windowStart: Date.now(),
            windowSeconds: input.windowSeconds,
            limit: input.limit,
          });
          break;
        }
        case "sliding_window": {
          slidingWindows.set(input.key, {
            requests: [],
            windowSeconds: input.windowSeconds,
            limit: input.limit,
          });
          break;
        }
      }
    }

    return {
      success: true,
      output: {
        configured: true,
        key: input.key,
        algorithm,
        limit: input.limit,
        windowSeconds: input.windowSeconds,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Rate Limit built-in plugin definition.
 */
export const rateLimitPlugin: BuiltinPlugin = {
  id: "builtin:rateLimit",
  name: "Rate Limit",
  description:
    "Rate limiting and throttling (token bucket, sliding/fixed window)",
  actions: {
    acquire: {
      name: "acquire",
      description: "Acquire rate limit token(s)",
      handler: acquire,
    },
    check: {
      name: "check",
      description: "Check current rate limit status",
      handler: check,
    },
    reset: {
      name: "reset",
      description: "Reset rate limit for a key",
      handler: reset,
    },
    throttle: {
      name: "throttle",
      description: "Wait until rate limit allows (blocking)",
      handler: throttle,
    },
    configure: {
      name: "configure",
      description: "Configure a rate limit without acquiring",
      handler: configure,
    },
  },
};
