/**
 * Built-in Rivet Plugin
 *
 * Execute Rivet AI agent graphs within a workflow step.
 * Uses dynamic import of `@ironclad/rivet-core` to avoid
 * bundling the runtime when not in use.
 */

import type { LooseDataValue } from "@ironclad/rivet-core";
import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Unwrap a rivet-core `DataValue` map into a plain key-value object.
 * Each `DataValue` has `{ type, value }` -- we extract just the `value`.
 */
const unwrapOutputs = (
  outputs: Record<string, { type: string; value: unknown }>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, dataValue] of Object.entries(outputs)) {
    result[key] = dataValue?.value;
  }

  return result;
};

/**
 * Execute a Rivet graph.
 * Accepts a serialized project JSON, optional graph name, input values,
 * and optional provider configuration (LLM keys, endpoints).
 */
const execute = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      graph,
      graphName,
      inputs: graphInputs = {},
      providerConfig,
    } = inputs as {
      graph?: string;
      graphName?: string;
      inputs?: Record<string, unknown>;
      providerConfig?: Record<string, unknown>;
    };

    if (!graph) {
      return {
        success: false,
        error: "Graph project JSON is required (graph input)",
        durationMs: performance.now() - startTime,
      };
    }

    // Dynamic import to avoid loading rivet-core unless needed
    const { loadProjectFromString, coreRunGraph } = await import(
      "@ironclad/rivet-core"
    );

    const project = loadProjectFromString(graph);

    const outputs = await coreRunGraph(project, {
      graph: graphName,
      inputs: graphInputs as Record<string, LooseDataValue>,
      ...providerConfig,
    });

    return {
      success: true,
      output: unwrapOutputs(
        outputs as Record<string, { type: string; value: unknown }>,
      ),
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

export const rivetPlugin: BuiltinPlugin = {
  id: "builtin:rivet",
  name: "Rivet",
  description: "Execute Rivet AI agent graphs",
  actions: {
    execute: {
      name: "execute",
      description: "Execute a Rivet graph with inputs and return outputs",
      handler: execute,
    },
  },
};
