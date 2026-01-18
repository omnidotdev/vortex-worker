/**
 * Extism Plugin Host Implementation
 *
 * Manages loading, caching, and executing WASM plugins via the Extism runtime.
 * Provides sandboxed execution with configurable permissions and resource limits.
 */

import { createPlugin } from "@extism/extism";

import {
  PluginFunctionNotFoundError,
  PluginInputValidationError,
  PluginLoadError,
  PluginTimeoutError,
} from "./interface";

import type { Plugin as ExtismPlugin } from "@extism/extism";
import type { LoadedPlugin, PluginHost } from "./interface";
import type {
  PluginCallResult,
  PluginContext,
  PluginManifest,
  PluginSchema,
  WasmSource,
} from "./types";

/**
 * Internal representation of a loaded plugin with its Extism instance.
 */
class ExtismLoadedPlugin implements LoadedPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly loadedAt: Date;
  private plugin: ExtismPlugin | null;

  constructor(id: string, manifest: PluginManifest, plugin: ExtismPlugin) {
    this.id = id;
    this.manifest = manifest;
    this.plugin = plugin;
    this.loadedAt = new Date();
  }

  get isLoaded(): boolean {
    return this.plugin !== null;
  }

  async call(
    functionName: string,
    inputs: Record<string, unknown>,
    _context?: PluginContext,
  ): Promise<PluginCallResult> {
    if (!this.plugin) {
      return {
        success: false,
        error: "Plugin is not loaded",
        durationMs: 0,
      };
    }

    // Validate function exists in manifest
    const funcDef = this.manifest.functions.find(
      (f) => f.name === functionName,
    );
    if (!funcDef) {
      throw new PluginFunctionNotFoundError(this.id, functionName);
    }

    // Validate inputs
    const validation = this.validateInputs(functionName, inputs);
    if (!validation.valid) {
      throw new PluginInputValidationError(this.id, validation.errors || []);
    }

    const startTime = performance.now();

    try {
      // Check if function exists in WASM module
      const exists = await this.plugin.functionExists(functionName);
      if (!exists) {
        throw new PluginFunctionNotFoundError(this.id, functionName);
      }

      // Call the function with JSON input
      const inputJson = JSON.stringify(inputs);
      const result = await this.plugin.call(functionName, inputJson);

      const durationMs = performance.now() - startTime;

      if (result === null) {
        return {
          success: true,
          output: {},
          durationMs,
        };
      }

      // Parse output as JSON
      try {
        const output = result.json();
        return {
          success: true,
          output: typeof output === "object" ? output : { result: output },
          durationMs,
        };
      } catch {
        // If not JSON, return as string
        return {
          success: true,
          output: { result: result.text() },
          durationMs,
        };
      }
    } catch (error) {
      const durationMs = performance.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      // Check for timeout
      if (message.includes("timeout") || message.includes("Timeout")) {
        throw new PluginTimeoutError(
          this.id,
          this.manifest.limits?.timeout || 30000,
        );
      }

      return {
        success: false,
        error: message,
        durationMs,
      };
    }
  }

  validateInputs(
    functionName: string,
    inputs: Record<string, unknown>,
  ): { valid: boolean; errors?: string[] } {
    const funcDef = this.manifest.functions.find(
      (f) => f.name === functionName,
    );
    if (!funcDef) {
      return { valid: false, errors: [`Function '${functionName}' not found`] };
    }

    const errors: string[] = [];

    for (const [key, schema] of Object.entries(funcDef.inputs)) {
      const value = inputs[key];

      // Check required fields
      if (schema.required !== false && value === undefined) {
        if (schema.default === undefined) {
          errors.push(`Missing required input: ${key}`);
        }
        continue;
      }

      // Skip validation if value is undefined and has default
      if (value === undefined) {
        continue;
      }

      // Type validation
      const typeError = this.validateType(key, value, schema);
      if (typeError) {
        errors.push(typeError);
      }
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  private validateType(
    key: string,
    value: unknown,
    schema: PluginSchema,
  ): string | null {
    switch (schema.type) {
      case "string":
        if (typeof value !== "string") {
          return `${key} must be a string, got ${typeof value}`;
        }
        break;
      case "number":
        if (typeof value !== "number") {
          return `${key} must be a number, got ${typeof value}`;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return `${key} must be a boolean, got ${typeof value}`;
        }
        break;
      case "object":
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          return `${key} must be an object`;
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          return `${key} must be an array`;
        }
        break;
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.plugin) {
      await this.plugin.close();
      this.plugin = null;
    }
  }
}

/**
 * Extism-based plugin host implementation.
 */
export class ExtismPluginHost implements PluginHost {
  readonly name = "extism";
  private plugins: Map<string, ExtismLoadedPlugin> = new Map();
  private logger: Console;

  constructor(logger: Console = console) {
    this.logger = logger;
  }

  async load(manifest: PluginManifest): Promise<LoadedPlugin> {
    // Check if already loaded
    const existing = this.plugins.get(manifest.id);
    if (existing?.isLoaded) {
      this.logger.debug(
        `Plugin ${manifest.id} already loaded, returning cached`,
      );
      return existing;
    }

    try {
      // Build Extism manifest from our manifest format
      const extismManifest = await this.buildExtismManifest(manifest);

      // Create plugin with options
      const plugin = await createPlugin(extismManifest, {
        useWasi: true,
        timeoutMs: manifest.limits?.timeout || 30000,
        allowedHosts: this.getAllowedHosts(manifest),
        allowedPaths: this.getAllowedPaths(manifest),
        logger: this.logger,
      });

      const loaded = new ExtismLoadedPlugin(manifest.id, manifest, plugin);
      this.plugins.set(manifest.id, loaded);

      this.logger.info(`Loaded plugin: ${manifest.id} v${manifest.version}`);
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginLoadError(manifest.id, message);
    }
  }

  get(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  list(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.isLoaded);
  }

  async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      await plugin.close();
      this.plugins.delete(pluginId);
      this.logger.info(`Unloaded plugin: ${pluginId}`);
    }
  }

  async unloadAll(): Promise<void> {
    const promises = Array.from(this.plugins.values()).map((p) => p.close());
    await Promise.all(promises);
    this.plugins.clear();
    this.logger.info("Unloaded all plugins");
  }

  isLoaded(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.isLoaded ?? false;
  }

  /**
   * Build Extism manifest from Vortex plugin manifest.
   */
  private async buildExtismManifest(manifest: PluginManifest): Promise<{
    wasm: Array<{ url?: string; path?: string; data?: Uint8Array }>;
  }> {
    const wasmSource = manifest.wasm as WasmSource;

    if ("url" in wasmSource) {
      return { wasm: [{ url: wasmSource.url }] };
    }

    if ("path" in wasmSource) {
      return { wasm: [{ path: wasmSource.path }] };
    }

    if ("bytes" in wasmSource) {
      return { wasm: [{ data: wasmSource.bytes }] };
    }

    throw new Error("Invalid WASM source in manifest");
  }

  /**
   * Get allowed hosts from permissions.
   */
  private getAllowedHosts(manifest: PluginManifest): string[] | undefined {
    const network = manifest.permissions?.network;

    if (!network) {
      return undefined;
    }

    if (network === true) {
      return ["*"];
    }

    if (Array.isArray(network)) {
      return network;
    }

    return undefined;
  }

  /**
   * Get allowed filesystem paths from permissions.
   */
  private getAllowedPaths(
    manifest: PluginManifest,
  ): Record<string, string> | undefined {
    const filesystem = manifest.permissions?.filesystem;

    if (!filesystem) {
      return undefined;
    }

    if (filesystem === true) {
      // Dangerous - allow all paths
      return { "/": "/" };
    }

    if (Array.isArray(filesystem)) {
      const paths: Record<string, string> = {};
      for (const path of filesystem) {
        paths[path] = path;
      }
      return paths;
    }

    return undefined;
  }
}

/**
 * Default singleton instance.
 */
let defaultHost: ExtismPluginHost | null = null;

/**
 * Get the default plugin host instance.
 */
export const getPluginHost = (): ExtismPluginHost => {
  if (!defaultHost) {
    defaultHost = new ExtismPluginHost();
  }
  return defaultHost;
};

/**
 * Reset the default plugin host (for testing).
 */
export const resetPluginHost = async (): Promise<void> => {
  if (defaultHost) {
    await defaultHost.unloadAll();
    defaultHost = null;
  }
};
