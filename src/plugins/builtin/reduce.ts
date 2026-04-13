/**
 * Built-in Reduce Plugin
 *
 * Aggregates array items into a single value using an expression.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface ReduceInput {
  source: unknown[];
  expression: string;
  initialValue: unknown;
  accumulatorVariable?: string;
  itemVariable?: string;
}

const evaluateReduce = (
  expression: string,
  acc: unknown,
  item: unknown,
  accVariable: string,
  itemVariable: string,
): unknown => {
  const fn = new Function(accVariable, itemVariable, `return ${expression}`);
  return fn(acc, item);
};

const reduceAggregate = async (
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
    } = inputs as unknown as ReduceInput;

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

    const result = source.reduce(
      (acc, item) =>
        evaluateReduce(
          expression,
          acc,
          item,
          accumulatorVariable,
          itemVariable,
        ),
      initialValue,
    );

    return {
      success: true,
      output: {
        result,
        originalLength: source.length,
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

export const reducePlugin: BuiltinPlugin = {
  id: "builtin:reduce",
  name: "Reduce",
  description: "Aggregate array items into a single value",
  actions: {
    aggregate: {
      name: "aggregate",
      description: "Reduce array items using an expression",
      handler: reduceAggregate,
    },
  },
};
