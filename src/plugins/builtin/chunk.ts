/**
 * Built-in Chunk Plugin
 *
 * Splits an array into chunks of specified size.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface ChunkArrayInput {
  source: unknown[];
  size: number;
}

const chunkArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, size } = inputs as unknown as ChunkArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    if (!size || size < 1) {
      return {
        success: false,
        error: "Chunk size must be at least 1",
        durationMs: performance.now() - startTime,
      };
    }

    const chunks: unknown[][] = [];
    for (let i = 0; i < source.length; i += size) {
      chunks.push(source.slice(i, i + size));
    }

    return {
      success: true,
      output: {
        result: chunks,
        chunkCount: chunks.length,
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

export const chunkPlugin: BuiltinPlugin = {
  id: "builtin:chunk",
  name: "Chunk",
  description: "Split array into chunks",
  actions: {
    array: {
      name: "array",
      description: "Split array into chunks of specified size",
      handler: chunkArray,
    },
  },
};
