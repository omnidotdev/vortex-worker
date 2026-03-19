/**
 * Retry utility with exponential backoff and jitter
 */

import { VortexError } from "lib/errors";
import logger from "lib/logger";

import type { ErrorCode } from "lib/errors";

/** Non-retryable error codes (deterministic failures) */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CANCELLED",
  "CONFIG_ERROR",
]);

type RetryOptions = {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelay?: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitter?: number;
  /** Predicate to determine if an error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Callback invoked before each retry */
  onRetry?: (error: unknown, attempt: number) => void;
};

/**
 * Default retryable check. Returns false for deterministic VortexError
 * codes that will never succeed on retry.
 */
function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof VortexError) {
    return !NON_RETRYABLE_CODES.has(error.code);
  }
  return true;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitter: number,
): number {
  const exponential = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return exponential * (1 + Math.random() * jitter);
}

/**
 * Execute a function with retry logic.
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws Last error if all attempts fail
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    jitter = 0.1,
    isRetryable = defaultIsRetryable,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;

      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelay, maxDelay, jitter);

      logger.warn("Retrying after error", {
        attempt: attempt + 1,
        maxAttempts,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });

      onRetry?.(error, attempt + 1);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError;
}

export type { RetryOptions };
export { defaultIsRetryable, withRetry };
