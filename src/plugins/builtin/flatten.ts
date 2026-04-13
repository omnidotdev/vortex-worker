/**
 * Built-in Flatten Plugin
 *
 * Flattens nested arrays to a specified depth.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface FlattenArrayInput {
  source: unknown[];
  depth?: number;
}

const flattenArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, depth = 1 } = inputs as unknown as FlattenArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const result = source.flat(depth);

    return {
      success: true,
      output: {
        result,
        originalLength: source.length,
        flattenedLength: result.length,
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

export const flattenPlugin: BuiltinPlugin = {
  id: "builtin:flatten",
  name: "Flatten",
  description: "Flatten nested arrays",
  actions: {
    array: {
      name: "array",
      description: "Flatten nested arrays to specified depth",
      handler: flattenArray,
    },
  },
};
