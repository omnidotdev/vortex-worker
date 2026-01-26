/**
 * Built-in Filter Plugin
 *
 * Filters arrays based on JavaScript expressions.
 * Supports custom item variable names and index access.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Filter array input */
interface FilterArrayInput {
  /** Array to filter */
  source: unknown[];
  /** JavaScript expression that returns truthy/falsy (e.g., "item.active === true") */
  expression: string;
  /** Variable name for current item in expression (default: "item") */
  itemVariable?: string;
}

/**
 * Filter array items using a JavaScript expression.
 */
const filterArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, expression, itemVariable = "item" } =
      inputs as unknown as FilterArrayInput;

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

    // Create filter function from expression.
    const filterFn = new Function(
      itemVariable,
      "index",
      `return Boolean(${expression})`,
    );

    const result = source.filter((item, index) => {
      try {
        return filterFn(item, index);
      } catch {
        return false;
      }
    });

    return {
      success: true,
      output: {
        result,
        originalCount: source.length,
        filteredCount: result.length,
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
 * Filter built-in plugin definition.
 */
export const filterPlugin: BuiltinPlugin = {
  id: "builtin:filter",
  name: "Filter",
  description: "Filter arrays based on expressions",
  actions: {
    array: {
      name: "array",
      description: "Filter array items using an expression",
      handler: filterArray,
    },
  },
};
