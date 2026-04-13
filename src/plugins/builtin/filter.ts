/**
 * Built-in Filter Plugin
 *
 * Filters array items by a condition expression.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface FilterInput {
  source: unknown[];
  expression: string;
  itemVariable?: string;
}

const evaluateCondition = (
  expression: string,
  item: unknown,
  itemVariable: string,
): boolean => {
  const fn = new Function(itemVariable, `return ${expression}`);
  return Boolean(fn(item));
};

const filterArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      source,
      expression,
      itemVariable = "item",
    } = inputs as unknown as FilterInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    if (!expression) {
      return {
        success: false,
        error: "Expression is required",
        durationMs: performance.now() - startTime,
      };
    }

    const result = source.filter((item) =>
      evaluateCondition(expression, item, itemVariable),
    );

    return {
      success: true,
      output: {
        result,
        originalLength: source.length,
        filteredLength: result.length,
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

export const filterPlugin: BuiltinPlugin = {
  id: "builtin:filter",
  name: "Filter",
  description: "Filter array items by condition",
  actions: {
    array: {
      name: "array",
      description: "Filter array items using an expression",
      handler: filterArray,
    },
  },
};
