/**
 * Vortex Plugin Types
 *
 * Type definitions for the plugin system. Plugins are WASM modules
 * executed via Extism runtime with sandboxed permissions.
 */

/** Schema for plugin function inputs/outputs */
export interface PluginSchema {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
  /** For arrays: schema of items */
  items?: PluginSchema;
  /** For objects: schema of properties */
  properties?: Record<string, PluginSchema>;
}

/** Definition of a plugin function */
export interface PluginFunction {
  /** Function name (must match exported WASM function) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Input parameter schemas */
  inputs: Record<string, PluginSchema>;
  /** Output value schemas */
  outputs: Record<string, PluginSchema>;
}

/** Plugin permissions for sandboxing */
export interface PluginPermissions {
  /**
   * Network access permissions.
   * - false: No network access (default)
   * - true: All network access
   * - string[]: List of allowed hosts/patterns
   */
  network?: boolean | string[];

  /**
   * Filesystem access permissions.
   * - false: No filesystem access (default)
   * - true: Full filesystem access (dangerous!)
   * - string[]: List of allowed paths
   */
  filesystem?: boolean | string[];

  /**
   * Environment variable access.
   * List of env var names the plugin can read.
   */
  env?: string[];

  /**
   * Host functions the plugin can call.
   * These are functions provided by Vortex to the plugin.
   */
  hostFunctions?: string[];
}

/** Resource limits for plugin execution */
export interface PluginLimits {
  /** Maximum memory in MB (default: 128) */
  memory?: number;
  /** Execution timeout in ms (default: 30000) */
  timeout?: number;
  /** Maximum output size in bytes (default: 1MB) */
  maxOutputSize?: number;
}

/** WASM module source */
export type WasmSource =
  | { url: string } // Fetch from URL
  | { path: string } // Load from filesystem
  | { bytes: Uint8Array }; // In-memory bytes

/** Complete plugin manifest */
export interface PluginManifest {
  /** Unique plugin identifier (e.g., "http-request", "slack-notify") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Plugin description */
  description?: string;
  /** Author or organization */
  author?: string;
  /** Homepage or repository URL */
  homepage?: string;
  /** License (SPDX identifier) */
  license?: string;

  /** WASM module source */
  wasm: WasmSource;

  /** Exported functions */
  functions: PluginFunction[];

  /** Required permissions */
  permissions?: PluginPermissions;

  /** Resource limits */
  limits?: PluginLimits;

  /** Plugin configuration schema */
  config?: Record<string, PluginSchema>;

  /** Tags for categorization */
  tags?: string[];
}

/** Result of a plugin function call */
export interface PluginCallResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Output data (if success) */
  output?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
  /** Execution time in ms */
  durationMs: number;
  /** Memory used in bytes */
  memoryUsed?: number;
}

/** Plugin execution context */
export interface PluginContext {
  /** Current workflow ID */
  workflowId: string;
  /** Current run ID */
  runId: string;
  /** Current step ID */
  stepId: string;
  /** Organization ID for state-scoped host function access */
  organizationId?: string;
  /** Plugin configuration values */
  config: Record<string, unknown>;
  /** Secrets available to the plugin (redacted in logs) */
  secrets: Record<string, unknown>;
  /** External service connections available to the plugin */
  connections?: Record<string, Record<string, unknown>>;
  /** Emit an event during execution (for SSE streaming) */
  emit?: (type: string, data: unknown) => Promise<void>;
}

/** Plugin registry entry */
export interface PluginRegistryEntry {
  manifest: PluginManifest;
  /** When the plugin was registered */
  registeredAt: Date;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Usage statistics */
  stats?: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    totalDurationMs: number;
  };
}
