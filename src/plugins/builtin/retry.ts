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
