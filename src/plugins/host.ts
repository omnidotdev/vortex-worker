/**
 * Extism Plugin Host Implementation
 *
 * Manages loading, caching, and executing WASM plugins via the Extism runtime.
 * Provides sandboxed execution with configurable permissions and resource limits.
 * Uses an instance pool so concurrent callers can run the same plugin in parallel.
 */

import { assertSafeUrl } from "lib/ssrf";
import { stateStore } from "../state/store";
import {
  PluginFunctionNotFoundError,
  PluginInputValidationError,
  PluginLoadError,
  PluginMemoryError,
  PluginTimeoutError,
} from "./interface";
import PluginPool from "./pool";

import type { CallContext } from "@extism/extism";
import type { LoadedPlugin, PluginHost } from "./interface";
import type { CreatePluginOptions, PoolConfig } from "./pool";
import type {
  PluginCallResult,
  PluginContext,
  PluginManifest,
  PluginSchema,
  WasmSource,
} from "./types";

/**
 * Internal representation of a loaded plugin backed by the instance pool.
 *
 * Each `call()` acquires an Extism instance from the pool, executes the
 * function, then releases it back so other callers can proceed concurrently.
 */
class ExtismLoadedPlugin implements LoadedPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly loadedAt: Date;
  private closed = false;
  private pool: PluginPool;
  private extismManifest: {
    wasm: Array<{
      url?: string;
      path?: string;
      data?: Uint8Array;
      hash?: string;
    }>;
  };
  private pluginOptions: CreatePluginOptions;

  constructor(
    id: string,
    manifest: PluginManifest,
    pool: PluginPool,
    extismManifest: {
      wasm: Array<{ url?: string; path?: string; data?: Uint8Array }>;
    },
    pluginOptions: CreatePluginOptions,
  ) {
    this.id = id;
    this.manifest = manifest;
    this.pool = pool;
    this.extismManifest = extismManifest;
    this.pluginOptions = pluginOptions;
    this.loadedAt = new Date();
  }

  get isLoaded(): boolean {
    return !this.closed;
  }

  async call(
    functionName: string,
    inputs: Record<string, unknown>,
    context?: PluginContext,
  ): Promise<PluginCallResult> {
    if (this.closed) {
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

    // Acquire instance from pool
    const plugin = await this.pool.acquire(
      this.id,
      this.extismManifest,
      this.pluginOptions,
    );

    const startTime = performance.now();

    try {
      // Check if function exists in WASM module
      const exists = await plugin.functionExists(functionName);
      if (!exists) {
        throw new PluginFunctionNotFoundError(this.id, functionName);
      }

      // Call the function with JSON input
      const inputJson = JSON.stringify(inputs);
      const result = await plugin.call(functionName, inputJson, context);

      const durationMs = performance.now() - startTime;

      // Enforce maxOutputSize limit
      if (result !== null && this.manifest.limits?.maxOutputSize) {
        const outputBytes = new TextEncoder().encode(result.text()).length;
        if (outputBytes > this.manifest.limits.maxOutputSize) {
          throw new PluginMemoryError(
            this.id,
            this.manifest.limits.maxOutputSize,
          );
        }
      }

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
      // Re-throw plugin-specific errors
      if (
        error instanceof PluginMemoryError ||
        error instanceof PluginFunctionNotFoundError
      ) {
        throw error;
      }

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
    } finally {
      // Always release back to the pool
      this.pool.release(this.id, plugin);
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

  /** Mark this facade as closed; actual instances are managed by the pool */
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Options for constructing an ExtismPluginHost */
type ExtismPluginHostOptions = {
  logger?: Console;
  pool?: Partial<PoolConfig>;
};

/**
 * Extism-based plugin host implementation.
 *
 * Uses a `PluginPool` under the hood so multiple concurrent callers can
 * execute the same plugin in parallel without serializing.
 */
export class ExtismPluginHost implements PluginHost {
  readonly name = "extism";
  private plugins: Map<string, ExtismLoadedPlugin> = new Map();
  private pool: PluginPool;
  private logger: Console;

  constructor(options?: ExtismPluginHostOptions) {
    this.logger = options?.logger ?? console;
    this.pool = new PluginPool(options?.pool);
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

      const pluginOptions = {
        useWasi: true,
        runInWorker: true, // Required for async host functions in Bun (no JSPI support)
        timeoutMs: manifest.limits?.timeout || 30000,
        memoryLimitPages: manifest.limits?.memory
          ? Math.ceil((manifest.limits.memory * 1024 * 1024) / 65536)
          : undefined,
        allowedHosts: this.getAllowedHosts(manifest),
        allowedPaths: this.getAllowedPaths(manifest),
        logger: this.logger,
        functions: this.buildHostFunctions(),
      };

      const loaded = new ExtismLoadedPlugin(
        manifest.id,
        manifest,
        this.pool,
        extismManifest,
        pluginOptions,
      );

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
    await this.pool.drain();
    this.logger.info("Unloaded all plugins");
  }

  isLoaded(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.isLoaded ?? false;
  }

  /**
   * Build the vortex_host namespace of host functions for plugins.
   *
   * - vortex_log: write a log message to the host logger
   * - vortex_state_get: read an org-scoped key from the Redis state store
   * - vortex_state_set: write an org-scoped key to the Redis state store
   * - vortex_http: make an outbound HTTP request and return the response
   */
  private buildHostFunctions(): {
    vortex_host: Record<
      string,
      (ctx: CallContext, ...ptrs: bigint[]) => unknown
    >;
  } {
    const hostLogger = this.logger;

    return {
      vortex_host: {
        vortex_log: (ctx: CallContext, ptr: bigint): void => {
          const message = ctx.read(ptr)?.text() ?? "";
          hostLogger.info(`[plugin] ${message}`);
        },

        vortex_state_get: async (
          ctx: CallContext,
          orgPtr: bigint,
          keyPtr: bigint,
        ): Promise<bigint> => {
          const orgId =
            ctx.read(orgPtr)?.text() ||
            ctx.hostContext<{ organizationId?: string }>()?.organizationId ||
            "";
          const key = ctx.read(keyPtr)?.text() ?? "";

          if (!orgId || !key) {
            return ctx.store(JSON.stringify(null));
          }

          try {
            const value = await stateStore.get(orgId, key);
            return ctx.store(JSON.stringify(value));
          } catch (err) {
            hostLogger.warn("vortex_state_get failed", {
              orgId,
              key,
              error: err instanceof Error ? err.message : String(err),
            });
            return ctx.store(JSON.stringify(null));
          }
        },

        vortex_state_set: async (
          ctx: CallContext,
          orgPtr: bigint,
          keyPtr: bigint,
          valuePtr: bigint,
        ): Promise<void> => {
          const orgId =
            ctx.read(orgPtr)?.text() ||
            ctx.hostContext<{ organizationId?: string }>()?.organizationId ||
            "";
          const key = ctx.read(keyPtr)?.text() ?? "";
          const rawValue = ctx.read(valuePtr)?.text() ?? "null";

          if (!orgId || !key) return;

          try {
            const value = JSON.parse(rawValue);
            await stateStore.set(orgId, key, value);
          } catch (err) {
            hostLogger.warn("vortex_state_set failed", {
              orgId,
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },

        vortex_http: async (
          ctx: CallContext,
          requestPtr: bigint,
        ): Promise<bigint> => {
          const rawRequest = ctx.read(requestPtr)?.text() ?? "{}";
          let request: {
            url?: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string;
          };

          try {
            request = JSON.parse(rawRequest);
          } catch {
            return ctx.store(JSON.stringify({ error: "Invalid request JSON" }));
          }

          if (!request.url) {
            return ctx.store(
              JSON.stringify({ error: "Missing url in request" }),
            );
          }

          try {
            // SSRF guard: a plugin-supplied URL must not reach internal/private
            // addresses (cloud metadata, RFC1918, cluster hostnames). Mirrors
            // the `http` builtin. Throws -> handled by the catch below.
            assertSafeUrl(request.url);

            const response = await fetch(request.url, {
              method: request.method ?? "GET",
              headers: request.headers,
              body: request.body,
              redirect: "error",
            });

            const responseBody = await response.text();
            return ctx.store(
              JSON.stringify({
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody,
              }),
            );
          } catch (err) {
            return ctx.store(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        },
      },
    };
  }

  /**
   * Build Extism manifest from Vortex plugin manifest.
   */
  private async buildExtismManifest(manifest: PluginManifest): Promise<{
    wasm: Array<{
      url?: string;
      path?: string;
      data?: Uint8Array;
      hash?: string;
    }>;
  }> {
    const wasmSource = manifest.wasm as WasmSource;

    if ("url" in wasmSource) {
      // Pass the expected hash through so Extism verifies the fetched module.
      // A url source without a hash is an unverified remote fetch
      return {
        wasm: [
          {
            url: wasmSource.url,
            ...(wasmSource.hash && { hash: wasmSource.hash }),
          },
        ],
      };
    }

    if ("path" in wasmSource) {
      return {
        wasm: [
          {
            path: wasmSource.path,
            ...(wasmSource.hash && { hash: wasmSource.hash }),
          },
        ],
      };
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
      // Blanket egress reaches internal/cluster addresses too, so this is only
      // safe for trusted plugins. Surface it; prefer an explicit host list
      this.logger.warn(
        `Plugin granted blanket network access (network: true); prefer an explicit host list`,
      );
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
      // Refuse to mount the whole host filesystem into the sandbox: it would
      // expose worker secrets and let a plugin read/write anywhere. A plugin
      // that needs files must enumerate explicit paths
      this.logger.warn(
        `Plugin requested blanket filesystem access (filesystem: true); refusing. List explicit paths instead`,
      );
      return undefined;
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
