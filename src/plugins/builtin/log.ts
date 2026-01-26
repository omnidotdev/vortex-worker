/**
 * Built-in Log Plugin
 *
 * Structured logging for workflows.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type LogLevel = "debug" | "info" | "warn" | "error";

/** Log entry input */
interface LogInput {
  /** Log level */
  level?: LogLevel;
  /** Log message */
  message: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
  /** Tags for filtering/categorization */
  tags?: string[];
}

/**
 * Write a structured log entry.
 */
const write = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { level = "info", message, data, tags } = inputs as unknown as LogInput;

    if (!message) {
      return {
        success: false,
        error: "Message is required",
        durationMs: performance.now() - startTime,
      };
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      workflowId: context?.workflowId,
      runId: context?.runId,
      ...(data && { data }),
      ...(tags && { tags }),
    };

    // biome-ignore lint/suspicious/noConsole: Intentional logging for workflow log plugin
    const logFn = console[level] || console.log;
    logFn("[Workflow Log]", JSON.stringify(logEntry, null, 2));

    return {
      success: true,
      output: {
        logged: true,
        entry: logEntry,
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
 * Log built-in plugin definition.
 */
export const logPlugin: BuiltinPlugin = {
  id: "builtin:log",
  name: "Log",
  description: "Structured workflow logging",
  actions: {
    write: {
      name: "write",
      description: "Write a log entry",
      handler: write,
    },
  },
};
