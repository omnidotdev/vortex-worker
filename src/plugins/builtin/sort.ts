/**
 * Built-in Sort Plugin
 *
 * Sorts array items, optionally by a key.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface SortInput {
  source: unknown[];
  key?: string;
  direction?: "asc" | "desc";
}

const sortArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, key, direction = "asc" } = inputs as unknown as SortInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const sorted = [...source].sort((a, b) => {
      const aVal = key ? (a as Record<string, unknown>)[key] : a;
      const bVal = key ? (b as Record<string, unknown>)[key] : b;

      if (aVal === bVal) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      const cmp = aVal < bVal ? -1 : 1;
      return direction === "desc" ? -cmp : cmp;
    });

    return {
      success: true,
      output: {
        result: sorted,
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

export const sortPlugin: BuiltinPlugin = {
  id: "builtin:sort",
  name: "Sort",
  description: "Sort array items",
  actions: {
    array: {
      name: "array",
      description: "Sort array items, optionally by key",
      handler: sortArray,
    },
  },
};
