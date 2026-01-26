/**
 * Built-in Rate Limit Plugin
 *
 * Throttling and rate limiting for workflow steps and API calls.
 * Supports token bucket, sliding window, and fixed window algorithms.
 */

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

// In-memory rate limit storage.
// In production, use Redis for distributed rate limiting.

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
 * Acquire tokens using token bucket algorithm.
 */
const acquireTokenBucket = (
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

  const waitTime = Math.ceil(((tokens - bucket.tokens) / bucket.refillRate) * 1000);
  return { allowed: false, remaining: Math.floor(bucket.tokens), resetIn: waitTime };
};

/**
 * Acquire tokens using fixed window algorithm.
 */
const acquireFixedWindow = (
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

  // Check if window has expired.
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
 * Acquire tokens using sliding window algorithm.
 */
const acquireSlidingWindow = (
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

  // Remove expired requests.
  const cutoff = now - window.windowSeconds * 1000;
  window.requests = window.requests.filter((t) => t > cutoff);

  const remaining = window.limit - window.requests.length;

  if (window.requests.length + tokens <= window.limit) {
    // Add timestamps for acquired tokens.
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

    let result: { allowed: boolean; remaining: number; resetIn: number };

    switch (algorithm) {
      case "token_bucket":
        result = acquireTokenBucket(input.key, tokens, input);
        break;
      case "fixed_window":
        result = acquireFixedWindow(input.key, tokens, input);
        break;
      case "sliding_window":
        result = acquireSlidingWindow(input.key, tokens, input);
        break;
      default:
        return {
          success: false,
          error: `Unknown algorithm: ${algorithm}`,
          durationMs: performance.now() - startTime,
        };
    }

    // Wait for token if requested.
    if (!result.allowed && input.wait) {
      const maxWaitMs = input.maxWaitMs ?? 30000;
      const waitTime = Math.min(result.resetIn, maxWaitMs);

      if (waitTime > 0 && waitTime <= maxWaitMs) {
        await sleep(waitTime);

        // Retry acquisition.
        switch (algorithm) {
          case "token_bucket":
            result = acquireTokenBucket(input.key, tokens, input);
            break;
          case "fixed_window":
            result = acquireFixedWindow(input.key, tokens, input);
            break;
          case "sliding_window":
            result = acquireSlidingWindow(input.key, tokens, input);
            break;
        }
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

    // Check all algorithms for this key.
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
      const result = await acquire(
        { ...input, wait: false },
        _context,
      );

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

    switch (algorithm) {
      case "token_bucket": {
        const capacity = input.burstCapacity ?? input.limit;
        const refillRate = input.refillRate ?? input.limit / input.windowSeconds;
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
  description: "Rate limiting and throttling (token bucket, sliding/fixed window)",
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
