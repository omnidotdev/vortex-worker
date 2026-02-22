/**
 * Trigger Adapter Registry
 *
 * Discovers and manages trigger adapters from built-in sources
 * and an optional external plugins directory (`VORTEX_TRIGGER_PLUGINS_DIR`).
 *
 * Each external adapter file must export `createAdapter(config): EventAdapter`.
 */

import { readdirSync, statSync } from "node:fs";
import { join, parse } from "node:path";

import { CdcAdapter } from "adapters/cdc.adapter";
import { KafkaAdapter } from "adapters/kafka.adapter";
import { MqttAdapter } from "adapters/mqtt.adapter";
import { PollingAdapter } from "adapters/polling.adapter";
import { RedisAdapter } from "adapters/redis.adapter";
import { S3Adapter } from "adapters/s3.adapter";
import { SqsAdapter } from "adapters/sqs.adapter";
import { WebSocketAdapter } from "adapters/websocket.adapter";
import logger from "lib/logger";

import type { EventAdapter } from "adapters/types";

type AdapterFactory = (config: Record<string, unknown>) => EventAdapter;

type AdapterEntry = {
  id: string;
  factory: AdapterFactory;
  builtin: boolean;
};

/** Built-in adapter constructors keyed by trigger type */
const BUILTIN_ADAPTERS: Record<
  string,
  new (config: Record<string, unknown>) => EventAdapter
> = {
  mqtt: MqttAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  websocket: WebSocketAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  kafka: KafkaAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  sqs: SqsAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  polling: PollingAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  s3: S3Adapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  cdc: CdcAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
  redis: RedisAdapter as unknown as new (
    config: Record<string, unknown>,
  ) => EventAdapter,
};

/** Registry of all known adapters (built-in + external) */
const registry = new Map<string, AdapterEntry>();

/** Whether the registry has been initialized */
let initialized = false;

/**
 * Register all built-in adapters.
 */
function registerBuiltins(): void {
  for (const [id, Ctor] of Object.entries(BUILTIN_ADAPTERS)) {
    registry.set(id, {
      id,
      factory: (config) => new Ctor(config),
      builtin: true,
    });
  }
}

/**
 * Load external adapter plugins from a directory.
 *
 * Each file in the directory should export a `createAdapter` function:
 * ```ts
 * export function createAdapter(config: Record<string, unknown>): EventAdapter
 * ```
 *
 * The adapter ID is derived from the filename (e.g. `nats.ts` -> `nats`).
 */
async function loadExternalAdapters(dir: string): Promise<void> {
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    logger.warn("Trigger plugins directory not readable", { dir });
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const { name, ext } = parse(entry);
    if (![".ts", ".js", ".mjs", ".cjs"].includes(ext)) continue;

    // Skip files that look like type definitions or tests
    if (name.endsWith(".d") || name.endsWith(".test") || name.endsWith(".spec"))
      continue;

    try {
      const mod = await import(fullPath);
      const factory = mod.createAdapter ?? mod.default?.createAdapter;

      if (typeof factory !== "function") {
        logger.warn("External adapter missing createAdapter export", {
          file: fullPath,
        });
        continue;
      }

      const id = name.replace(/\.adapter$/, "");

      if (registry.has(id)) {
        logger.warn("External adapter overrides built-in", { id, file: fullPath });
      }

      registry.set(id, { id, factory, builtin: false });
      logger.info("Loaded external trigger adapter", { id, file: fullPath });
    } catch (err) {
      logger.error("Failed to load external trigger adapter", {
        file: fullPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Initialize the trigger adapter registry.
 * Loads built-in adapters and discovers external plugins from
 * `VORTEX_TRIGGER_PLUGINS_DIR` if set.
 */
async function initTriggerRegistry(): Promise<void> {
  if (initialized) return;

  registerBuiltins();

  const pluginsDir = process.env.VORTEX_TRIGGER_PLUGINS_DIR;
  if (pluginsDir) {
    await loadExternalAdapters(pluginsDir);
  }

  initialized = true;
  logger.info("Trigger adapter registry initialized", {
    total: registry.size,
    builtin: [...registry.values()].filter((e) => e.builtin).length,
    external: [...registry.values()].filter((e) => !e.builtin).length,
  });
}

/**
 * Get an adapter factory by trigger type ID.
 */
function getAdapterFactory(id: string): AdapterFactory | undefined {
  return registry.get(id)?.factory;
}

/**
 * Create an adapter instance by trigger type ID.
 */
function createAdapter(
  id: string,
  config: Record<string, unknown>,
): EventAdapter | null {
  const entry = registry.get(id);
  if (!entry) return null;
  return entry.factory(config);
}

/**
 * List all registered adapter IDs.
 */
function listAdapterIds(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Check whether an adapter is registered.
 */
function hasAdapter(id: string): boolean {
  return registry.has(id);
}

export {
  createAdapter,
  getAdapterFactory,
  hasAdapter,
  initTriggerRegistry,
  listAdapterIds,
};
