/**
 * Built-in Sleep Plugin
 *
 * Pause workflow execution for a specified duration.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type TimeUnit = "ms" | "seconds" | "minutes";

const TIME_MULTIPLIERS: Record<TimeUnit, number> = {
  ms: 1,
  seconds: 1000,
  minutes: 60 * 1000,
};

/** Sleep input */
interface SleepInput {
  /** Duration to sleep */
  duration: number;
  /** Time unit (default: seconds) */
  unit?: TimeUnit;
}

/**
 * Sleep for a specified duration.
 */
const wait = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { duration, unit = "seconds" } = inputs as unknown as SleepInput;

    if (typeof duration !== "number" || duration < 0) {
      return {
        success: false,
        error: "Duration must be a non-negative number",
        durationMs: performance.now() - startTime,
      };
    }

    const multiplier = TIME_MULTIPLIERS[unit] || TIME_MULTIPLIERS.seconds;
    const ms = duration * multiplier;

    await new Promise((resolve) => setTimeout(resolve, ms));

    return {
      success: true,
      output: { sleptMs: ms },
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
 * Sleep built-in plugin definition.
 */
export const sleepPlugin: BuiltinPlugin = {
  id: "builtin:sleep",
  name: "Sleep",
  description: "Pause workflow execution",
  actions: {
    wait: {
      name: "wait",
      description: "Sleep for a specified duration",
      handler: wait,
    },
  },
};
