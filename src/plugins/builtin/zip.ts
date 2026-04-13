/**
 * Built-in Zip Plugin
 *
 * Combines multiple arrays element-wise.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface ZipArraysInput {
  sources: unknown[][];
}

const zipArrays = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { sources } = inputs as unknown as ZipArraysInput;

    if (!Array.isArray(sources) || sources.length === 0) {
      return {
        success: false,
        error: "Sources must be a non-empty array of arrays",
        durationMs: performance.now() - startTime,
      };
    }

    for (const source of sources) {
      if (!Array.isArray(source)) {
        return {
          success: false,
          error: "All sources must be arrays",
          durationMs: performance.now() - startTime,
        };
      }
    }

    const maxLength = Math.max(...sources.map((s) => s.length));
    const result: unknown[][] = [];

    for (let i = 0; i < maxLength; i++) {
      result.push(sources.map((source) => source[i]));
    }

    return {
      success: true,
      output: {
        result,
        length: result.length,
        sourceCount: sources.length,
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

export const zipPlugin: BuiltinPlugin = {
  id: "builtin:zip",
  name: "Zip",
  description: "Combine arrays element-wise",
  actions: {
    arrays: {
      name: "arrays",
      description: "Combine multiple arrays element-wise",
      handler: zipArrays,
    },
  },
};
