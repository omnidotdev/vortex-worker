/**
 * Built-in Merge Plugin
 *
 * Combines data from multiple sources into unified structures.
 * Supports shallow merge, array concatenation, and deep recursive merge.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Conflict resolution strategy for object merges */
type ConflictStrategy = "first" | "last" | "error";

/** Merge objects input */
interface MergeObjectsInput {
  /** Array of objects to merge */
  sources: unknown[];
  /** How to handle key conflicts (default: "last") */
  conflictStrategy?: ConflictStrategy;
}

/** Merge arrays input */
interface MergeArraysInput {
  /** Array of arrays to concatenate */
  sources: unknown[][];
}

/** Deep merge input */
interface DeepMergeInput {
  /** Array of objects to deep merge */
  sources: Record<string, unknown>[];
}

/**
 * Merge multiple objects into one (shallow merge).
 */
const mergeObjects = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { sources, conflictStrategy = "last" } =
      inputs as unknown as MergeObjectsInput;

    if (!Array.isArray(sources)) {
      return {
        success: false,
        error: "Sources must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const result: Record<string, unknown> = {};

    for (const source of sources) {
      if (source && typeof source === "object" && !Array.isArray(source)) {
        for (const [key, value] of Object.entries(source)) {
          if (key in result && conflictStrategy === "error") {
            return {
              success: false,
              error: `Conflict: key "${key}" exists in multiple sources`,
              durationMs: performance.now() - startTime,
            };
          }

          if (conflictStrategy === "first" && key in result) {
            continue;
          }

          result[key] = value;
        }
      }
    }

    return {
      success: true,
      output: { result },
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
 * Concatenate multiple arrays into one.
 */
const mergeArrays = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { sources } = inputs as unknown as MergeArraysInput;

    if (!Array.isArray(sources)) {
      return {
        success: false,
        error: "Sources must be an array of arrays",
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { result: sources.flat() },
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
 * Deep merge objects recursively.
 */
const deepMergeObjects = (
  ...objects: Record<string, unknown>[]
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      continue;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMergeObjects(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result;
};

/**
 * Deep merge multiple objects recursively.
 */
const deepMerge = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { sources } = inputs as unknown as DeepMergeInput;

    if (!Array.isArray(sources)) {
      return {
        success: false,
        error: "Sources must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { result: deepMergeObjects(...sources) },
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
 * Merge built-in plugin definition.
 */
export const mergePlugin: BuiltinPlugin = {
  id: "builtin:merge",
  name: "Merge",
  description: "Combine data from multiple sources",
  actions: {
    objects: {
      name: "objects",
      description: "Merge multiple objects into one",
      handler: mergeObjects,
    },
    arrays: {
      name: "arrays",
      description: "Concatenate multiple arrays",
      handler: mergeArrays,
    },
    deep: {
      name: "deep",
      description: "Deep merge objects recursively",
      handler: deepMerge,
    },
  },
};
