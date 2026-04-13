/**
 * Built-in Parallel Plugin
 *
 * Handles parallel branch execution.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type WaitFor = "all" | "any" | number;

/**
 * Initialize parallel execution.
 * Note: Actual parallel execution is orchestrated by the executor.
 * This plugin handles the configuration and result aggregation.
 */
const executeParallel = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { branches = [], waitFor = "all" } = inputs as {
      branches?: string[][];
      waitFor?: WaitFor;
    };

    return {
      success: true,
      output: {
        branchCount: branches.length,
        waitFor,
        initialized: true,
        // Results will be populated by executor
        branchResults: [],
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
 * Aggregate results from parallel branches.
 */
const aggregateResults = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { results = [], waitFor = "all" } = inputs as {
      results?: unknown[];
      waitFor?: WaitFor;
    };

    let finalResults: unknown[];

    if (waitFor === "any") {
      finalResults = results.slice(0, 1);
    } else if (typeof waitFor === "number") {
      finalResults = results.slice(0, waitFor);
    } else {
      finalResults = results;
    }

    return {
      success: true,
      output: {
        completed: true,
        totalBranches: results.length,
        collectedResults: finalResults.length,
        results: finalResults,
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

export const parallelPlugin: BuiltinPlugin = {
  id: "builtin:parallel",
  name: "Parallel",
  description: "Execute branches in parallel",
  actions: {
    execute: {
      name: "execute",
      description: "Initialize parallel execution",
      handler: executeParallel,
    },
    aggregate: {
      name: "aggregate",
      description: "Aggregate parallel branch results",
      handler: aggregateResults,
    },
  },
};
