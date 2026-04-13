/**
 * Built-in Loop Plugin
 *
 * Handles iteration control for workflows.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type LoopType = "forEach" | "times" | "while";

/**
 * Execute loop iteration.
 */
const executeLoop = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      type = "forEach",
      collection,
      count,
      condition,
      maxIterations = 1000,
    } = inputs as {
      type?: LoopType;
      collection?: unknown[];
      count?: number;
      condition?: boolean;
      maxIterations?: number;
    };

    const results: Array<{ index: number; item?: unknown }> = [];
    let iterations = 0;

    switch (type) {
      case "forEach": {
        const items = Array.isArray(collection) ? collection : [];
        for (let i = 0; i < items.length && i < maxIterations; i++) {
          results.push({ index: i, item: items[i] });
          iterations++;
        }
        break;
      }
      case "times": {
        const n = count ?? 0;
        for (let i = 0; i < n && i < maxIterations; i++) {
          results.push({ index: i });
          iterations++;
        }
        break;
      }
      case "while": {
        // For while loops, we just report the condition state
        // Actual iteration is handled by the executor
        if (condition) {
          results.push({ index: 0 });
          iterations = 1;
        }
        break;
      }
    }

    return {
      success: true,
      output: {
        type,
        iterations,
        results,
        completed: true,
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

export const loopPlugin: BuiltinPlugin = {
  id: "builtin:loop",
  name: "Loop",
  description: "Iterate over collections or repeat actions",
  actions: {
    iterate: {
      name: "iterate",
      description: "Execute loop iteration",
      handler: executeLoop,
    },
  },
};
