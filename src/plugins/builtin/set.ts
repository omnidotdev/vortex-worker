/**
 * Built-in Set Plugin
 *
 * Sets workflow variables for use in subsequent steps.
 * Variables are merged into the workflow context.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Set variables input */
interface SetVariablesInput {
  /** Object containing variable names and values to set */
  variables: Record<string, unknown>;
}

/**
 * Set one or more workflow variables.
 */
const setVariables = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { variables } = inputs as unknown as SetVariablesInput;

    if (!variables || typeof variables !== "object") {
      return {
        success: false,
        error: "Variables must be an object",
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { variables },
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
 * Set built-in plugin definition.
 */
export const setPlugin: BuiltinPlugin = {
  id: "builtin:set",
  name: "Set",
  description: "Set workflow variables",
  actions: {
    variables: {
      name: "variables",
      description: "Set one or more workflow variables",
      handler: setVariables,
    },
  },
};
