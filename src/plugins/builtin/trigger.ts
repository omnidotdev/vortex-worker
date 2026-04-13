/**
 * Built-in Trigger Plugin
 *
 * Handles workflow trigger initialization.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Execute trigger - returns the trigger data to seed the workflow context.
 */
const executeTrigger = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  return {
    success: true,
    output: {
      triggerType: inputs.triggerType || "manual",
      data: inputs.data || {},
      timestamp: new Date().toISOString(),
    },
    durationMs: performance.now() - startTime,
  };
};

export const triggerPlugin: BuiltinPlugin = {
  id: "builtin:trigger",
  name: "Trigger",
  description: "Workflow trigger handler",
  actions: {
    execute: {
      name: "execute",
      description: "Initialize workflow trigger",
      handler: executeTrigger,
    },
  },
};
