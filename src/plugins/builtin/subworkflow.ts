/**
 * Built-in Subworkflow Plugin
 *
 * Execute another workflow as a step.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Execute a subworkflow.
 */
const executeSubworkflow = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { workflowId, inputs: subInputs, waitForCompletion = true, timeout: _timeout } = inputs as {
      workflowId: string;
      inputs: Record<string, unknown>;
      waitForCompletion?: boolean;
      timeout?: number;
    };

    if (!workflowId) {
      return {
        success: false,
        error: "workflowId is required",
        durationMs: performance.now() - startTime,
      };
    }

    // TODO: Implement actual workflow execution via worker API
    // For now, return a placeholder that indicates the subworkflow was triggered
    return {
      success: true,
      output: {
        workflowId,
        triggered: true,
        waitForCompletion,
        inputs: subInputs,
        // Actual implementation will include runId and outputs
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

export const subworkflowPlugin: BuiltinPlugin = {
  id: "builtin:subworkflow",
  name: "Subworkflow",
  description: "Execute another workflow",
  actions: {
    execute: {
      name: "execute",
      description: "Execute a subworkflow",
      handler: executeSubworkflow,
    },
  },
};
