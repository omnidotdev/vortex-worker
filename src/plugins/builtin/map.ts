/**
 * Built-in Map Plugin
 *
 * Transform arrays by applying expressions to each element.
 * Supports custom item and index variable names.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Map array input */
interface MapArrayInput {
  /** Array to transform */
  source: unknown[];
  /** JavaScript expression to apply to each item (e.g., "item.name.toUpperCase()") */
  expression: string;
  /** Variable name for current item in expression (default: "item") */
  itemVariable?: string;
  /** Variable name for current index in expression (default: "index") */
  indexVariable?: string;
}

/**
 * Transform array items using a JavaScript expression.
 */
const mapArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      source,
      expression,
      itemVariable = "item",
      indexVariable = "index",
    } = inputs as unknown as MapArrayInput;

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

    // Create transform function from expression.
    const transformFn = new Function(
      itemVariable,
      indexVariable,
      `return (${expression})`,
    );

    const result = source.map((item, index) => {
      try {
        return transformFn(item, index);
      } catch {
        return null;
      }
    });

    return {
      success: true,
      output: {
        result,
        count: result.length,
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
 * Map built-in plugin definition.
 */
export const mapPlugin: BuiltinPlugin = {
  id: "builtin:map",
  name: "Map",
  description: "Transform arrays by applying expressions to each element",
  actions: {
    transform: {
      name: "transform",
      description: "Transform array items using an expression",
      handler: mapArray,
    },
  },
};
