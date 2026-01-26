/**
 * Built-in Unique Plugin
 *
 * Remove duplicate values from arrays.
 * Supports uniqueness by value or by a key path.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Unique array input */
interface UniqueArrayInput {
  /** Array to deduplicate */
  source: unknown[];
  /** Dot-notation key path for determining uniqueness (e.g., "user.id") */
  key?: string;
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
 * Get unique key for a value (handles objects via JSON.stringify).
 */
const getUniqueKey = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") return JSON.stringify(value);

  return String(value);
};

/**
 * Remove duplicate values from an array.
 */
const uniqueArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, key } = inputs as unknown as UniqueArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const seen = new Set<string>();
    const result: unknown[] = [];

    for (const item of source) {
      const value = key ? getByPath(item, key) : item;
      const uniqueKey = getUniqueKey(value);

      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        result.push(item);
      }
    }

    return {
      success: true,
      output: {
        result,
        originalCount: source.length,
        uniqueCount: result.length,
        duplicatesRemoved: source.length - result.length,
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
 * Unique built-in plugin definition.
 */
export const uniquePlugin: BuiltinPlugin = {
  id: "builtin:unique",
  name: "Unique",
  description: "Remove duplicate values from arrays",
  actions: {
    array: {
      name: "array",
      description: "Remove duplicate values from an array",
      handler: uniqueArray,
    },
  },
};
