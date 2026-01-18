/**
 * Built-in Delay Plugin
 *
 * Pauses workflow execution for a specified duration.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type TimeUnit = "seconds" | "minutes" | "hours" | "days";

const TIME_MULTIPLIERS: Record<TimeUnit, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Wait for the specified duration.
 */
const executeDelay = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { duration = 1, unit = "seconds" } = inputs as {
      duration?: number;
      unit?: TimeUnit;
    };

    const multiplier = TIME_MULTIPLIERS[unit] || TIME_MULTIPLIERS.seconds;
    const ms = duration * multiplier;

    // Cap at 1 hour for safety
    const cappedMs = Math.min(ms, 60 * 60 * 1000);

    await new Promise((resolve) => setTimeout(resolve, cappedMs));

    return {
      success: true,
      output: {
        delayed: true,
        duration,
        unit,
        actualMs: cappedMs,
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

export const delayPlugin: BuiltinPlugin = {
  id: "builtin:delay",
  name: "Delay",
  description: "Pause workflow execution",
  actions: {
    wait: {
      name: "wait",
      description: "Wait for a specified duration",
      handler: executeDelay,
    },
  },
};
