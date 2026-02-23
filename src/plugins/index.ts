/**
 * Vortex Plugin System
 *
 * Plugin system supporting:
 * - Built-in plugins (native TypeScript for core primitives)
 * - WASM plugins via Extism runtime (sandboxed execution)
 */

// Built-in plugins
export {
  executeBuiltinAction,
  getBuiltinHandler,
  getBuiltinPlugin,
  httpPlugin,
  isBuiltinPlugin,
  listBuiltinPlugins,
  transformPlugin,
} from "./builtin";
// Extism WASM host
export { ExtismPluginHost, getPluginHost, resetPluginHost } from "./host";
export * from "./interface";
export { default as PluginPool } from "./pool";
export * from "./types";

export type { BuiltinAction, BuiltinHandler, BuiltinPlugin } from "./builtin";
