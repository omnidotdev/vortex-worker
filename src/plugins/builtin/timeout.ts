/**
 * Built-in Timeout Plugin
 *
 * Wraps operations with timeout handling and configurable behavior.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Timeout behavior when exceeded */
type TimeoutBehavior = "error" | "continue" | "fallback";

/** Timeout configuration input */
interface TimeoutConfigInput {
  /** Timeout duration in milliseconds */
  durationMs: number;
  /** Behavior when timeout is exceeded */
  onTimeout?: TimeoutBehavior;
  /** Fallback value to use when onTimeout is "fallback" */
  fallbackValue?: unknown;
}

/** Timeout configuration output */
interface TimeoutConfig {
  durationMs: number;
  onTimeout: TimeoutBehavior;
  fallbackValue?: unknown;
}

/**
 * Configure timeout behavior for subsequent operations.
 * Actual timeout logic is handled by the workflow executor.
 */
const withTimeout = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  const {
    durationMs,
    onTimeout = "error",
    fallbackValue,
  } = inputs as unknown as TimeoutConfigInput;

  // Return control flow marker for executor
  const config: TimeoutConfig = {
    durationMs,
    onTimeout,
  };

  if (fallbackValue !== undefined) {
    config.fallbackValue = fallbackValue;
  }

  return {
    success: true,
    output: {
      _timeoutConfig: config,
    },
    durationMs: performance.now() - startTime,
  };
};

/**
 * Timeout built-in plugin definition.
 */
export const timeoutPlugin: BuiltinPlugin = {
  id: "builtin:timeout",
  name: "Timeout",
  description: "Add timeout to operations",
  actions: {
    wrap: {
      name: "wrap",
      description: "Wrap an operation with timeout",
      handler: withTimeout,
    },
  },
};
