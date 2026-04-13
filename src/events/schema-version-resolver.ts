/**
 * Schema version resolver for event migration.
 *
 * Build migration chains between schema versions and apply
 * JSONata transforms to migrate event data forward through versions.
 */
import jsonata from "jsonata";

import logger from "lib/logger";

export type VersionedSchema = {
  id: string;
  name: string;
  version: number;
  compatibilityMode: string;
  previousVersionId: string | null;
  migrationTransform: string | null;
  payloadSchema: Record<string, unknown> | null;
};

type MigrationStep = {
  fromVersion: number;
  toVersion: number;
  transform: string;
};

type ResolveResult = {
  data: Record<string, unknown>;
  migrated: boolean;
  fromVersion?: number;
  toVersion?: number;
  /** True when data passed through without transform (backward compat) */
  passthrough?: boolean;
  error?: string;
};

/**
 * Build an ordered list of migration transforms from source to target version.
 * @param schemas - All known schema versions for the event type
 * @param fromVersion - Source version number
 * @param toVersion - Target version number
 * @returns Ordered migration steps, or null if the chain is broken
 */
function buildMigrationChain(
  schemas: VersionedSchema[],
  fromVersion: number,
  toVersion: number,
): MigrationStep[] | null {
  if (fromVersion === toVersion) return [];
  if (fromVersion > toVersion) return null;

  const byVersion = new Map(schemas.map((s) => [s.version, s]));
  const steps: MigrationStep[] = [];

  for (let v = fromVersion + 1; v <= toVersion; v++) {
    const schema = byVersion.get(v);
    if (!schema) return null;
    if (!schema.migrationTransform) return null;

    steps.push({
      fromVersion: v - 1,
      toVersion: v,
      transform: schema.migrationTransform,
    });
  }

  return steps;
}

/**
 * Resolve an event's data from one schema version to another.
 *
 * Apply a chain of JSONata transforms to migrate the data forward.
 * Fall back to passthrough when backward compatibility allows it.
 * @param data - Event payload to migrate
 * @param fromVersion - Current version of the data
 * @param toVersion - Desired target version
 * @param schemas - All known schema versions for the event type
 * @returns Resolve result with migrated data or error details
 */
async function resolveSchemaVersion(
  data: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  schemas: VersionedSchema[],
): Promise<ResolveResult> {
  if (fromVersion === toVersion) {
    return { data, migrated: false };
  }

  const chain = buildMigrationChain(schemas, fromVersion, toVersion);

  if (chain === null || chain.length === 0) {
    // Only allow passthrough for single-step version gaps where backward
    // compatibility makes it safe to skip the transform
    const isSingleStep = toVersion - fromVersion === 1;
    const targetSchema = schemas.find((s) => s.version === toVersion);

    if (
      isSingleStep &&
      (targetSchema?.compatibilityMode === "backward" ||
        targetSchema?.compatibilityMode === "full")
    ) {
      return { data, migrated: false, passthrough: true };
    }

    return {
      data,
      migrated: false,
      error: `No migration path from v${fromVersion} to v${toVersion} for ${schemas[0]?.name ?? "unknown"}`,
    };
  }

  let current = { ...data };

  for (const step of chain) {
    try {
      const expr = jsonata(step.transform);
      const result = await expr.evaluate(current);

      if (
        result !== undefined &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        current = result as Record<string, unknown>;
      } else {
        logger.warn(
          "Migration transform returned non-object, keeping current data",
          {
            fromVersion: step.fromVersion,
            toVersion: step.toVersion,
          },
        );
      }
    } catch (err) {
      return {
        data: current,
        migrated: false,
        error: `Migration transform failed at v${step.fromVersion}->v${step.toVersion}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    data: current,
    migrated: true,
    fromVersion,
    toVersion,
  };
}

export { buildMigrationChain, resolveSchemaVersion };
