/**
 * Built-in Plugin Types
 *
 * Native TypeScript plugins that run in-process (not WASM).
 * Used for core primitives like HTTP, Transform, Delay, etc.
 */

import type { PluginCallResult, PluginContext } from "../types";

/**
 * Handler function for a built-in plugin action.
 */
export type BuiltinHandler = (
  inputs: Record<string, unknown>,
  context?: PluginContext,
) => Promise<PluginCallResult>;

/**
 * Definition of a built-in plugin.
 */
export interface BuiltinPlugin {
  /** Unique plugin identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Plugin description */
  description?: string;
  /** Available actions */
  actions: Record<string, BuiltinAction>;
}

/**
 * Definition of a built-in plugin action.
 */
export interface BuiltinAction {
  /** Action name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Handler function */
  handler: BuiltinHandler;
}
