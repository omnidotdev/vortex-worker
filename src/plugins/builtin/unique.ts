/**
 * Built-in Unique Plugin
 *
 * Removes duplicate items from an array.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface UniqueInput {
  source: unknown[];
  key?: string;
}

const uniqueArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, key } = inputs as unknown as UniqueInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    let result: unknown[];

    if (key) {
      const seen = new Set<unknown>();
      result = source.filter((item) => {
        const val = (item as Record<string, unknown>)[key];
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      });
    } else {
      result = [...new Set(source)];
    }

    return {
      success: true,
      output: {
        result,
        originalLength: source.length,
        uniqueLength: result.length,
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

export const uniquePlugin: BuiltinPlugin = {
  id: "builtin:unique",
  name: "Unique",
  description: "Remove duplicate items from an array",
  actions: {
    array: {
      name: "array",
      description: "Remove duplicate items from an array",
      handler: uniqueArray,
    },
  },
};
