/**
 * Vortex Plugin Interface
 *
 * Defines the contract for the plugin system. Plugins are WASM modules
 * executed in a sandboxed Extism runtime with configurable permissions.
 *
 * ## Architecture
 *
 * ```
 * PluginRegistry (manages manifests)
 *       ↓
 * PluginHost (loads/unloads WASM)
 *       ↓
 * LoadedPlugin (executes functions)
 *       ↓
 * Extism Runtime (sandboxed execution)
 * ```
 *
 * ## Security
 *
 * - Plugins run in isolated WASM sandbox
 * - Network/filesystem access requires explicit permissions
 * - Resource limits prevent DoS
 * - Host functions are explicitly exposed
 *
 * @example
 * ```typescript
 * const host = new ExtismPluginHost();
 *
 * const plugin = await host.load({
 *   id: "http-request",
 *   name: "HTTP Request",
 *   version: "1.0.0",
 *   wasm: { url: "https://plugins.vortex.dev/http-request.wasm" },
 *   functions: [{
 *     name: "request",
 *     inputs: { url: { type: "string" }, method: { type: "string" } },
 *     outputs: { status: { type: "number" }, body: { type: "string" } }
 *   }],
 *   permissions: { network: ["*"] }
 * });
 *
 * const result = await plugin.call("request", {
 *   url: "https://api.example.com/data",
 *   method: "GET"
 * });
 * ```
 */

import type {
  PluginCallResult,
  PluginContext,
  PluginManifest,
  PluginRegistryEntry,
} from "./types";

/**
 * A loaded and ready-to-execute plugin instance.
 */
export interface LoadedPlugin {
  /** Unique plugin ID */
  readonly id: string;

  /** Plugin manifest */
  readonly manifest: PluginManifest;

  /** Whether the plugin is currently loaded */
  readonly isLoaded: boolean;

  /**
   * Call a function on the plugin.
   *
   * @param functionName - Name of the function to call (must be in manifest)
   * @param inputs - Input parameters matching function schema
   * @param context - Execution context (workflow, run, step info)
   * @returns Function result or error
   *
   * @throws {PluginFunctionNotFoundError} If function doesn't exist
   * @throws {PluginInputValidationError} If inputs don't match schema
   * @throws {PluginTimeoutError} If execution exceeds timeout
   * @throws {PluginMemoryError} If execution exceeds memory limit
   */
  call(
    functionName: string,
    inputs: Record<string, unknown>,
    context?: PluginContext,
  ): Promise<PluginCallResult>;

  /**
   * Validate inputs against function schema without executing.
   *
   * @param functionName - Name of the function
   * @param inputs - Input parameters to validate
   * @returns Validation result with any errors
   */
  validateInputs(
    functionName: string,
    inputs: Record<string, unknown>,
  ): { valid: boolean; errors?: string[] };
}

/**
 * Plugin host responsible for loading and managing plugins.
 */
export interface PluginHost {
  /** Host identifier */
  readonly name: string;

  /**
   * Load a plugin from its manifest.
   *
   * Downloads WASM module if needed, initializes runtime,
   * and returns a ready-to-use plugin instance.
   *
   * @param manifest - Plugin manifest with WASM source and config
   * @returns Loaded plugin instance
   *
   * @throws {PluginLoadError} If WASM can't be loaded
   * @throws {PluginInitError} If plugin fails to initialize
   */
  load(manifest: PluginManifest): Promise<LoadedPlugin>;

  /**
   * Get a previously loaded plugin by ID.
   *
   * @param pluginId - Plugin ID
   * @returns Plugin instance or undefined if not loaded
   */
  get(pluginId: string): LoadedPlugin | undefined;

  /**
   * List all currently loaded plugins.
   */
  list(): LoadedPlugin[];

  /**
   * Unload a plugin and free resources.
   *
   * @param pluginId - Plugin ID to unload
   */
  unload(pluginId: string): Promise<void>;

  /**
   * Unload all plugins and cleanup.
   */
  unloadAll(): Promise<void>;

  /**
   * Check if a plugin is loaded.
   *
   * @param pluginId - Plugin ID to check
   */
  isLoaded(pluginId: string): boolean;
}

/**
 * Plugin registry for discovering and managing plugin manifests.
 */
export interface PluginRegistry {
  /**
   * Register a plugin manifest.
   *
   * @param manifest - Plugin manifest to register
   */
  register(manifest: PluginManifest): Promise<void>;

  /**
   * Get a plugin manifest by ID.
   *
   * @param pluginId - Plugin ID
   * @returns Plugin entry or undefined
   */
  get(pluginId: string): Promise<PluginRegistryEntry | undefined>;

  /**
   * List all registered plugins.
   *
   * @param filter - Optional filter criteria
   */
  list(filter?: {
    tags?: string[];
    enabled?: boolean;
  }): Promise<PluginRegistryEntry[]>;

  /**
   * Search plugins by name or description.
   *
   * @param query - Search query
   */
  search(query: string): Promise<PluginRegistryEntry[]>;

  /**
   * Enable or disable a plugin.
   *
   * @param pluginId - Plugin ID
   * @param enabled - Whether to enable
   */
  setEnabled(pluginId: string, enabled: boolean): Promise<void>;

  /**
   * Unregister a plugin.
   *
   * @param pluginId - Plugin ID to remove
   */
  unregister(pluginId: string): Promise<void>;
}

// Error classes

export class PluginError extends Error {
  readonly pluginId: string;

  constructor(message: string, pluginId: string) {
    super(message);
    this.name = "PluginError";
    this.pluginId = pluginId;
  }
}

export class PluginLoadError extends PluginError {
  constructor(pluginId: string, cause: string) {
    super(`Failed to load plugin ${pluginId}: ${cause}`, pluginId);
    this.name = "PluginLoadError";
  }
}

export class PluginFunctionNotFoundError extends PluginError {
  readonly functionName: string;

  constructor(pluginId: string, functionName: string) {
    super(
      `Function '${functionName}' not found in plugin ${pluginId}`,
      pluginId,
    );
    this.name = "PluginFunctionNotFoundError";
    this.functionName = functionName;
  }
}

export class PluginInputValidationError extends PluginError {
  readonly errors: string[];

  constructor(pluginId: string, errors: string[]) {
    super(
      `Invalid inputs for plugin ${pluginId}: ${errors.join(", ")}`,
      pluginId,
    );
    this.name = "PluginInputValidationError";
    this.errors = errors;
  }
}

export class PluginTimeoutError extends PluginError {
  readonly timeoutMs: number;

  constructor(pluginId: string, timeoutMs: number) {
    super(
      `Plugin ${pluginId} execution timed out after ${timeoutMs}ms`,
      pluginId,
    );
    this.name = "PluginTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class PluginMemoryError extends PluginError {
  readonly limitMb: number;

  constructor(pluginId: string, limitMb: number) {
    super(`Plugin ${pluginId} exceeded memory limit of ${limitMb}MB`, pluginId);
    this.name = "PluginMemoryError";
    this.limitMb = limitMb;
  }
}
