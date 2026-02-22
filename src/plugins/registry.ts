/**
 * Plugin Registry
 *
 * Singleton service that loads enabled plugins from the database on startup
 * and tracks plugin invocation usage. Usage recording is fire-and-forget
 * (non-blocking) so it never slows down plugin execution.
 */

import { getDb } from "db";
import { pluginTable, pluginUsageTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";

import type { PluginManifest } from "./types";

type RegistryEntry = {
  pluginId: string;
  organizationId: string;
  manifest: PluginManifest;
  enabled: boolean;
};

class PluginRegistry {
  private cache = new Map<string, RegistryEntry>();
  private initialized = false;

  /**
   * Load all enabled plugins from the DB into the in-memory cache.
   * Called once on worker startup.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();

    try {
      const plugins = await db.query.pluginTable.findMany({
        where: eq(pluginTable.isEnabled, true),
        columns: {
          id: true,
          organizationId: true,
          manifest: true,
          isEnabled: true,
        },
      });

      for (const plugin of plugins) {
        this.cache.set(plugin.id, {
          pluginId: plugin.id,
          organizationId: plugin.organizationId,
          manifest: plugin.manifest as PluginManifest,
          enabled: plugin.isEnabled,
        });
      }

      this.initialized = true;

      logger.info("Plugin registry initialized", {
        count: this.cache.size,
      });
    } catch (err) {
      logger.error("Failed to initialize plugin registry", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Look up a plugin manifest by ID.
   */
  get(pluginId: string): RegistryEntry | undefined {
    return this.cache.get(pluginId);
  }

  /**
   * Track a plugin function invocation.
   * Non-blocking: errors are logged but never thrown.
   */
  incrementUsage(
    pluginId: string,
    organizationId: string,
    workflowId: string | undefined,
    runId: string | undefined,
    functionName: string,
    durationMs: number,
    success: boolean,
  ): void {
    const db = getDb();

    db.insert(pluginUsageTable)
      .values({
        pluginId,
        organizationId,
        workflowId: workflowId ?? null,
        runId: runId ?? null,
        functionName,
        durationMs,
        success,
      })
      .catch((err) => {
        logger.error("Failed to record plugin usage", {
          pluginId,
          functionName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

let registryInstance: PluginRegistry | null = null;

/**
 * Get the singleton plugin registry instance.
 */
export function getPluginRegistry(): PluginRegistry {
  if (!registryInstance) {
    registryInstance = new PluginRegistry();
  }
  return registryInstance;
}
