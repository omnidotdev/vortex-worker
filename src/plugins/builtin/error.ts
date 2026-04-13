/**
 * Built-in Error Plugin
 *
 * Throws custom workflow errors with configurable severity.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Error throw input */
interface ThrowErrorInput {
  /** Error type/category */
  errorType: string;
  /** Error message */
  message: string;
  /** Additional error data */
  data?: Record<string, unknown>;
  /** Whether this error should terminate the workflow */
  fatal?: boolean;
}

/**
 * Throw a custom workflow error.
 */
const throwError = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  const {
    errorType,
    message,
    data,
    fatal = false,
  } = inputs as unknown as ThrowErrorInput;

  return {
    success: false,
    error: message,
    output: {
      errorType,
      message,
      data,
      fatal,
    },
    durationMs: performance.now() - startTime,
  };
};

/**
 * Error built-in plugin definition.
 */
export const errorPlugin: BuiltinPlugin = {
  id: "builtin:error",
  name: "Error",
  description: "Throw custom workflow errors",
  actions: {
    throw: {
      name: "throw",
      description: "Throw a custom error",
      handler: throwError,
    },
  },
};
