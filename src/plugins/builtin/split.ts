/**
 * Built-in Split Plugin
 *
 * Splits arrays into individual items or batches for parallel processing.
 * Useful for fan-out patterns in workflow execution.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Split array input */
interface SplitArrayInput {
  /** Array to split */
  source: unknown[];
  /** Number of items per batch (default: 1 for individual items) */
  batchSize?: number;
  /** Maximum number of items to process */
  maxItems?: number;
}

/**
 * Split an array into individual items or batches.
 */
const splitArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { source, batchSize = 1, maxItems } =
      inputs as unknown as SplitArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    let items = source;

    if (maxItems !== undefined && maxItems > 0) {
      items = items.slice(0, maxItems);
    }

    const batches: unknown[][] = [];

    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }

    // If batch size is 1, unwrap single-item arrays
    const result = batchSize === 1 ? batches.map((b) => b[0]) : batches;

    return {
      success: true,
      output: {
        result,
        totalItems: items.length,
        batchCount: batches.length,
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
 * Split built-in plugin definition.
 */
export const splitPlugin: BuiltinPlugin = {
  id: "builtin:split",
  name: "Split",
  description: "Split arrays into items or batches",
  actions: {
    array: {
      name: "array",
      description: "Split an array into individual items or batches",
      handler: splitArray,
    },
  },
};
