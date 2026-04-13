/**
 * Built-in Switch Plugin
 *
 * Routes workflow based on matching values against cases.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface SwitchCase {
  value: unknown;
  label?: string;
}

/**
 * Evaluate switch expression and find matching case.
 */
const evaluateSwitch = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { value, cases } = inputs as {
      value: unknown;
      cases: SwitchCase[];
    };

    // Find matching case
    const matchedIndex = (cases || []).findIndex((c) => c.value === value);

    let matchedCase: string;
    let matchedLabel: string | undefined;

    if (matchedIndex >= 0) {
      matchedCase = `case_${matchedIndex}`;
      matchedLabel = cases[matchedIndex].label;
    } else {
      matchedCase = "default";
    }

    return {
      success: true,
      output: {
        value,
        case: matchedCase,
        matchedIndex: matchedIndex >= 0 ? matchedIndex : null,
        matchedLabel,
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

export const switchPlugin: BuiltinPlugin = {
  id: "builtin:switch",
  name: "Switch",
  description: "Route based on value matching",
  actions: {
    evaluate: {
      name: "evaluate",
      description: "Evaluate switch and find matching case",
      handler: evaluateSwitch,
    },
  },
};
