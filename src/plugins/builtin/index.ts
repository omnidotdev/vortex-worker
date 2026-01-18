/**
 * Built-in Plugins
 *
 * Native TypeScript plugins for core workflow primitives.
 * These run in-process (not WASM) for performance.
 */

export { conditionPlugin } from "./condition";
export { delayPlugin } from "./delay";
export { gatePlugin } from "./gate";
export { httpPlugin } from "./http";
export { loopPlugin } from "./loop";
export { mcpPlugin } from "./mcp";
export { parallelPlugin } from "./parallel";
export { switchPlugin } from "./switch";
export { transformPlugin } from "./transform";
export { triggerPlugin } from "./trigger";
export * from "./types";

import { conditionPlugin } from "./condition";
import { delayPlugin } from "./delay";
import { gatePlugin } from "./gate";
import { httpPlugin } from "./http";
import { loopPlugin } from "./loop";
import { mcpPlugin } from "./mcp";
import { parallelPlugin } from "./parallel";
import { switchPlugin } from "./switch";
import { transformPlugin } from "./transform";
import { triggerPlugin } from "./trigger";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinHandler, BuiltinPlugin } from "./types";

/**
 * Registry of all built-in plugins.
 */
const builtinPlugins: Map<string, BuiltinPlugin> = new Map([
  [httpPlugin.id, httpPlugin],
  [transformPlugin.id, transformPlugin],
  [triggerPlugin.id, triggerPlugin],
  [conditionPlugin.id, conditionPlugin],
  [switchPlugin.id, switchPlugin],
  [delayPlugin.id, delayPlugin],
  [loopPlugin.id, loopPlugin],
  [parallelPlugin.id, parallelPlugin],
  [gatePlugin.id, gatePlugin],
  [mcpPlugin.id, mcpPlugin],
]);

/**
 * Get a built-in plugin by ID.
 */
export const getBuiltinPlugin = (
  pluginId: string,
): BuiltinPlugin | undefined => {
  return builtinPlugins.get(pluginId);
};

/**
 * List all built-in plugins.
 */
export const listBuiltinPlugins = (): BuiltinPlugin[] => {
  return Array.from(builtinPlugins.values());
};

/**
 * Check if a plugin ID is a built-in plugin.
 */
export const isBuiltinPlugin = (pluginId: string): boolean => {
  return pluginId.startsWith("builtin:") && builtinPlugins.has(pluginId);
};

/**
 * Execute a built-in plugin action.
 */
export const executeBuiltinAction = async (
  pluginId: string,
  actionName: string,
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const plugin = builtinPlugins.get(pluginId);
  if (!plugin) {
    return {
      success: false,
      error: `Built-in plugin not found: ${pluginId}`,
      durationMs: 0,
    };
  }

  const action = plugin.actions[actionName];
  if (!action) {
    return {
      success: false,
      error: `Action not found: ${actionName} in plugin ${pluginId}`,
      durationMs: 0,
    };
  }

  return action.handler(inputs, context);
};

/**
 * Get a specific action handler from a built-in plugin.
 */
export const getBuiltinHandler = (
  pluginId: string,
  actionName: string,
): BuiltinHandler | undefined => {
  const plugin = builtinPlugins.get(pluginId);
  if (!plugin) return undefined;

  const action = plugin.actions[actionName];
  return action?.handler;
};
