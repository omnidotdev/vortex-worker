/**
 * Built-in Sort Plugin
 *
 * Sort arrays by value or by a key path.
 * Supports ascending and descending order with smart type detection.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Sort direction */
type SortDirection = "asc" | "desc";

/** Sort array input */
interface SortArrayInput {
  /** Array to sort */
  source: unknown[];
  /** Dot-notation key path for nested values (e.g., "user.name") */
  key?: string;
  /** Sort direction (default: "asc") */
  direction?: SortDirection;
}

/**
 * Get nested value from object using dot notation.
 */
const getByPath = (obj: unknown, path: string): unknown => {
  if (!path) return obj;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
};

/**
 * Sort array items by value or key path.
 */
const sortArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, key, direction = "asc" } =
      inputs as unknown as SortArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const multiplier = direction === "desc" ? -1 : 1;

    const result = [...source].sort((a, b) => {
      const aVal = key ? getByPath(a, key) : a;
      const bVal = key ? getByPath(b, key) : b;

      // Handle null/undefined.
      if (aVal === null || aVal === undefined) return 1 * multiplier;
      if (bVal === null || bVal === undefined) return -1 * multiplier;

      // String comparison.
      if (typeof aVal === "string" && typeof bVal === "string") {
        return aVal.localeCompare(bVal) * multiplier;
      }

      // Number comparison.
      if (typeof aVal === "number" && typeof bVal === "number") {
        return (aVal - bVal) * multiplier;
      }

      // Boolean comparison.
      if (typeof aVal === "boolean" && typeof bVal === "boolean") {
        return (Number(aVal) - Number(bVal)) * multiplier;
      }

      // Fallback: convert to string and compare.
      return String(aVal).localeCompare(String(bVal)) * multiplier;
    });

    return {
      success: true,
      output: {
        result,
        count: result.length,
        direction,
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
 * Sort built-in plugin definition.
 */
export const sortPlugin: BuiltinPlugin = {
  id: "builtin:sort",
  name: "Sort",
  description: "Sort arrays by value or key path",
  actions: {
    array: {
      name: "array",
      description: "Sort array items by value or key path",
      handler: sortArray,
    },
  },
};
