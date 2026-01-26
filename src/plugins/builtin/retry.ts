/**
 * Built-in Retry Plugin
 *
 * Provides retry configuration for operations with backoff strategies.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Backoff strategy type */
type BackoffStrategy = "fixed" | "linear" | "exponential";

/** Retry configuration input */
interface RetryConfigInput {
  /** Maximum number of retry attempts */
  maxAttempts?: number;
  /** Initial delay between retries in milliseconds */
  initialDelayMs?: number;
  /** Backoff strategy */
  backoff?: BackoffStrategy;
  /** Maximum delay between retries in milliseconds */
  maxDelayMs?: number;
}

/** Retry configuration output */
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  backoff: BackoffStrategy;
  maxDelayMs: number;
}

/**
 * Configure retry behavior for subsequent operations.
 * Actual retry logic is handled by the workflow executor.
 */
const executeWithRetry = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    backoff = "exponential",
    maxDelayMs = 30000,
  } = inputs as unknown as RetryConfigInput;

  // Return control flow marker for executor.
  return {
    success: true,
    output: {
      _retryConfig: {
        maxAttempts,
        initialDelayMs,
        backoff,
        maxDelayMs,
      } satisfies RetryConfig,
    },
    durationMs: performance.now() - startTime,
  };
};

/**
 * Calculate delay for a retry attempt based on backoff strategy.
 * @param attempt - Current attempt number (1-based).
 * @param initialDelayMs - Initial delay in milliseconds.
 * @param backoff - Backoff strategy to use.
 * @param maxDelayMs - Maximum delay cap in milliseconds.
 * @returns Delay in milliseconds for this attempt.
 */
export const calculateDelay = (
  attempt: number,
  initialDelayMs: number,
  backoff: BackoffStrategy,
  maxDelayMs: number,
): number => {
  let delay: number;

  switch (backoff) {
    case "fixed":
      delay = initialDelayMs;
      break;
    case "linear":
      delay = initialDelayMs * attempt;
      break;
    case "exponential":
      delay = initialDelayMs * 2 ** (attempt - 1);
      break;
  }

  return Math.min(delay, maxDelayMs);
};

/**
 * Sleep for a specified duration.
 * @param ms - Duration in milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry built-in plugin definition.
 */
export const retryPlugin: BuiltinPlugin = {
  id: "builtin:retry",
  name: "Retry",
  description: "Retry operations with backoff",
  actions: {
    execute: {
      name: "execute",
      description: "Execute with retry logic",
      handler: executeWithRetry,
    },
  },
};
