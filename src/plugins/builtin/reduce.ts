/**
 * Built-in Reduce Plugin
 *
 * Aggregate arrays into a single value using reducer expressions.
 * Supports custom accumulator and item variable names.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Reduce array input */
interface ReduceArrayInput {
  /** Array to reduce */
  source: unknown[];
  /** JavaScript expression for the reducer (e.g., "acc + item.value") */
  expression: string;
  /** Initial value for the accumulator */
  initialValue: unknown;
  /** Variable name for accumulator in expression (default: "acc") */
  accumulatorVariable?: string;
  /** Variable name for current item in expression (default: "item") */
  itemVariable?: string;
}

/**
 * Reduce array to a single value using a JavaScript expression.
 */
const reduceArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      source,
      expression,
      initialValue,
      accumulatorVariable = "acc",
      itemVariable = "item",
    } = inputs as unknown as ReduceArrayInput;

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

    if (initialValue === undefined) {
      return {
        success: false,
        error: "Initial value is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Create reducer function from expression.
    const reducerFn = new Function(
      accumulatorVariable,
      itemVariable,
      "index",
      `return (${expression})`,
    );

    const result = source.reduce((acc, item, index) => {
      try {
        return reducerFn(acc, item, index);
      } catch {
        return acc;
      }
    }, initialValue);

    return {
      success: true,
      output: {
        result,
        itemsProcessed: source.length,
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
 * Reduce built-in plugin definition.
 */
export const reducePlugin: BuiltinPlugin = {
  id: "builtin:reduce",
  name: "Reduce",
  description: "Aggregate arrays into a single value",
  actions: {
    aggregate: {
      name: "aggregate",
      description: "Reduce array to a single value using an expression",
      handler: reduceArray,
    },
  },
};
