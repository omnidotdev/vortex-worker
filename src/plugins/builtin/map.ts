/**
 * Built-in Map Plugin
 *
 * Transforms each item in an array using an expression.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface MapInput {
  source: unknown[];
  expression: string;
  itemVariable?: string;
}

const evaluateSimpleExpression = (
  expression: string,
  item: unknown,
  itemVariable: string,
): unknown => {
  const fn = new Function(itemVariable, `return ${expression}`);
  return fn(item);
};

const mapTransform = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      source,
      expression,
      itemVariable = "item",
    } = inputs as unknown as MapInput;

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

    const result = source.map((item) =>
      evaluateSimpleExpression(expression, item, itemVariable),
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

export const mapPlugin: BuiltinPlugin = {
  id: "builtin:map",
  name: "Map",
  description: "Transform each item in an array",
  actions: {
    transform: {
      name: "transform",
      description: "Transform each item in an array using an expression",
      handler: mapTransform,
    },
  },
};
