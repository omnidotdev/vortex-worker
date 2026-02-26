/**
 * Event routing engine.
 *
 * Matches incoming events against `event_routing_rule` records and
 * dispatches matching workflows to Hatchet for execution.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { context, trace } from "@opentelemetry/api";
import { getDb } from "db";
import {
  eventLogTable,
  eventRoutingRuleTable,
  eventSchemaTable,
  workflowRunTable,
  workflowTable,
} from "db/schema";
import { and, desc, eq } from "drizzle-orm";
import jsonata from "jsonata";
import { JSONPath } from "jsonpath-plus";
import {
  endSpan,
  extractTraceContext,
  injectTraceContext,
  startRouterSpan,
} from "tracing/propagation";
import { z } from "zod";

import { cacheClient } from "lib/cache/client";
import logger from "lib/logger";
import BatchAccumulator from "./batch-accumulator";
import { evaluateCel } from "./cel-evaluator";
import { withRetry, writeToDlq } from "./dlq";
import { validateEventData } from "./schema-validator";
import { resolveSchemaVersion } from "./schema-version-resolver";

import type Redis from "ioredis";
import type { Enforcement } from "./schema-validator";
import type { VersionedSchema } from "./schema-version-resolver";
import type { OmniEvent } from "./types";

/**
 * Match a glob-style pattern against a value.
 *
 * Supports:
 * - `"*"` matches everything
 * - `"prefix.*"` matches `"prefix.anything"`
 * - `"exact"` matches exactly `"exact"`
 */
const matchGlobPattern = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;

  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(value);
};

/**
 * Evaluate a JSONPath condition against event data.
 *
 * Returns `true` when `condition` is null (no filter) or when the
 * JSONPath expression returns a non-empty result set. Returns `false`
 * when the path matches nothing or on evaluation error.
 */
export const evaluateCondition = (
  condition: string | null,
  data: Record<string, unknown>,
): boolean => {
  if (condition === null) return true;

  try {
    // `wrap: true` ensures the result is always an array, even for scalar matches
    const result = JSONPath({ path: condition, json: data, wrap: true });
    return Array.isArray(result) && result.length > 0;
  } catch (err) {
    logger.warn("Failed to evaluate routing rule condition", {
      condition,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};

/**
 * Apply a JSONata expression to transform event data.
 *
 * Returns transformed result on success. On evaluation error or when
 * `transform` is null, returns the original data unchanged.
 */
export const applyTransform = async (
  transform: string | null,
  data: Record<string, unknown>,
): Promise<unknown> => {
  if (transform === null) return data;

  try {
    const expr = jsonata(transform);
    const result = await expr.evaluate(data);

    if (result === undefined) {
      logger.warn(
        "Transform returned undefined, falling back to original data",
        {
          transform,
        },
      );
      return data;
    }

    return result;
  } catch (err) {
    logger.warn("Failed to apply routing rule transform", {
      transform,
      error: err instanceof Error ? err.message : String(err),
    });
    return data;
  }
};

/** Deduplication window for correlationId-based idempotency (24 hours). */
const DEDUP_TTL_SECONDS = 86_400;

/** Zod schema for validating `batch` JSONB column from `event_routing_rule` */
const BatchConfigSchema = z.object({
  maxSize: z.number().positive(),
  maxWaitMs: z.number().positive(),
  partitionKey: z.string().optional(),
});

/**
 * Per-rule batch accumulator cache (keyed by rule ID).
 *
 * NOTE: accumulators are not removed when a rule is disabled/deleted.
 * Orphaned entries are inert (empty partitions, no timers) and will be
 * replaced if the rule is re-enabled. Periodic cleanup can be added if
 * the Map grows large enough to matter.
 */
const accumulators = new Map<string, BatchAccumulator>();

/** Flush all active batch accumulators (call during graceful shutdown) */
export async function shutdownAccumulators(): Promise<void> {
  await Promise.all([...accumulators.values()].map((acc) => acc.shutdown()));
  accumulators.clear();
}

let _hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!_hatchet) {
    _hatchet = Hatchet.init();
  }
  return _hatchet;
}

/**
 * Check and mark an event as seen for idempotency.
 *
 * Uses Redis SET NX to atomically check-and-set a deduplication key
 * keyed on `correlationId`. Returns `true` if this `correlationId` has
 * been seen before within the 24-hour TTL (skip routing). Returns `false`
 * if it is new (proceed), or when Redis is unavailable or `correlationId`
 * is absent (fail open).
 *
 * Note: the dedup key is written before the workflow run is persisted.
 * In the event of a crash between the SET NX and a successful DB insert,
 * the event will be treated as a duplicate for up to 24 hours. This is an
 * accepted trade-off for simplicity; operators can clear the Redis key
 * manually to force re-processing.
 */
export const isDuplicate = async (
  cache: Redis | null,
  organizationId: string,
  correlationId: string | undefined,
): Promise<boolean> => {
  if (!cache || !correlationId) return false;

  try {
    const key = `dedup:${organizationId}:${correlationId}`;
    // SET NX: returns "OK" on first write, null if key already existed
    const result = await cache.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
    return result === null; // null = already existed = duplicate
  } catch (err) {
    logger.warn("Dedup check failed, proceeding without deduplication", {
      organizationId,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};

/**
 * Normalize an incoming event to CloudEvents v1.0 format.
 *
 * Adds missing CloudEvents fields while preserving existing ones.
 * This is backward-compatible — events without CloudEvents fields
 * get them added automatically.
 */
export function normalizeToCloudEvent(event: OmniEvent): OmniEvent {
  return {
    ...event,
    specversion: event.specversion ?? "1.0",
    time: event.time ?? event.timestamp,
    datacontenttype: event.datacontenttype ?? "application/json",
    omniorgid: event.omniorgid ?? event.organizationId,
  };
}

/**
 * Route an incoming event to matching workflows.
 *
 * Queries enabled routing rules for the event's organization, filters
 * by type/source glob patterns, then creates a workflow run and pushes
 * a `workflow:execute` event to Hatchet for each match.
 */
async function routeEvent(rawEvent: OmniEvent): Promise<void> {
  const event = normalizeToCloudEvent(rawEvent);
  const parentCtx = extractTraceContext(event.traceContext);
  const routerSpan = startRouterSpan(event.type, event.source, parentCtx);

  try {
    await context.with(trace.setSpan(parentCtx, routerSpan), async () => {
      const db = getDb();
      const hatchet = getHatchet();

      // Log this event for audit and replay (best-effort, never blocks routing)
      db.insert(eventLogTable)
        .values({
          type: event.type,
          source: event.source,
          subject: event.subject,
          organizationId: event.organizationId,
          data: event.data,
          correlationId: event.correlationId,
          schemaId: event.schemaId,
          timestamp: event.timestamp,
          specversion: event.specversion,
          dataschema: event.dataschema,
        })
        .catch((err) => {
          logger.warn("Failed to write event to event_log", {
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      // Find enabled routing rules for this organization, highest priority first
      const rules = await db.query.eventRoutingRuleTable.findMany({
        where: and(
          eq(eventRoutingRuleTable.organizationId, event.organizationId),
          eq(eventRoutingRuleTable.enabled, true),
        ),
        orderBy: [desc(eventRoutingRuleTable.priority)],
      });

      // Filter rules whose patterns match this event
      const matchingRules = rules.filter((rule) => {
        if (!matchGlobPattern(rule.typePattern, event.type)) return false;

        // If the rule specifies a source pattern, it must also match
        if (
          rule.sourcePattern &&
          !matchGlobPattern(rule.sourcePattern, event.source)
        ) {
          return false;
        }

        // CEL condition takes precedence over legacy JSONPath condition
        if (rule.celCondition) {
          return evaluateCel(rule.celCondition, event);
        }

        // Fall back to legacy JSONPath condition
        if (!evaluateCondition(rule.condition, event.data)) return false;

        return true;
      });

      routerSpan.setAttribute(
        "vortex.routing.matched_rules",
        matchingRules.length,
      );

      if (matchingRules.length === 0) {
        logger.debug("No routing rules matched", {
          eventId: event.id,
          type: event.type,
          organizationId: event.organizationId,
        });
        return;
      }

      // Skip if this correlationId has already been routed (idempotency)
      if (
        await isDuplicate(
          cacheClient,
          event.organizationId,
          event.correlationId,
        )
      ) {
        logger.info("Skipping duplicate event (already routed)", {
          eventId: event.id,
          correlationId: event.correlationId,
          matchedRuleCount: matchingRules.length,
        });
        return;
      }

      // Validate event data against registered schema and migrate versions
      const eventSchemaName = event.schemaId ?? event.dataschema;
      const eventVersion = event.omnischemaversion;
      let eventData = event.data;

      if (eventSchemaName) {
        // Fetch all versions of this schema for validation and migration
        const allVersions = await db.query.eventSchemaTable.findMany({
          where: eq(eventSchemaTable.name, eventSchemaName),
        });

        // Find the version matching the event (or latest if unversioned)
        const matchedSchema = eventVersion
          ? allVersions.find((s) => s.version === eventVersion)
          : allVersions.sort((a, b) => b.version - a.version)[0];

        if (matchedSchema?.payloadSchema) {
          const result = validateEventData(event.data, {
            name: matchedSchema.name,
            enforcement: (matchedSchema.enforcement ?? "warn") as Enforcement,
            payloadSchema: matchedSchema.payloadSchema as Record<
              string,
              unknown
            >,
          });

          if (!result.valid) {
            logger.warn("Event failed schema validation", {
              eventId: event.id,
              schemaId: eventSchemaName,
              errors: result.errors,
            });

            for (const rule of matchingRules) {
              await writeToDlq(
                event,
                rule.id,
                new Error(
                  `Schema validation failed: ${result.errors.join(", ")}`,
                ),
                "SCHEMA_VALIDATION_ERROR",
                1,
              );
            }
            return;
          }
        }

        // Migrate event data to the latest schema version if needed
        if (eventVersion && allVersions.length > 0) {
          const latestVersion = Math.max(...allVersions.map((s) => s.version));

          if (eventVersion < latestVersion) {
            const migrationResult = await resolveSchemaVersion(
              event.data,
              eventVersion,
              latestVersion,
              allVersions as VersionedSchema[],
            );

            if (migrationResult.error) {
              logger.warn("Schema version migration failed", {
                eventId: event.id,
                schemaId: eventSchemaName,
                fromVersion: eventVersion,
                toVersion: latestVersion,
                error: migrationResult.error,
              });

              for (const rule of matchingRules) {
                await writeToDlq(
                  event,
                  rule.id,
                  new Error(migrationResult.error),
                  "SCHEMA_VERSION_MISMATCH",
                  1,
                );
              }
              return;
            }

            if (migrationResult.migrated) {
              logger.info("Migrated event data to latest schema version", {
                eventId: event.id,
                schemaId: eventSchemaName,
                fromVersion: eventVersion,
                toVersion: latestVersion,
              });

              // Re-validate migrated data against the target schema
              const latestSchema = allVersions.find(
                (s) => s.version === latestVersion,
              );

              if (latestSchema?.payloadSchema) {
                const postMigrationResult = validateEventData(
                  migrationResult.data,
                  {
                    name: latestSchema.name,
                    enforcement: (latestSchema.enforcement ??
                      "warn") as Enforcement,
                    payloadSchema: latestSchema.payloadSchema as Record<
                      string,
                      unknown
                    >,
                  },
                );

                if (!postMigrationResult.valid) {
                  logger.warn(
                    "Migrated event data failed target schema validation",
                    {
                      eventId: event.id,
                      schemaId: eventSchemaName,
                      fromVersion: eventVersion,
                      toVersion: latestVersion,
                      errors: postMigrationResult.errors,
                    },
                  );

                  for (const rule of matchingRules) {
                    await writeToDlq(
                      event,
                      rule.id,
                      new Error(
                        `Post-migration validation failed: ${postMigrationResult.errors.join(", ")}`,
                      ),
                      "SCHEMA_VERSION_MISMATCH",
                      1,
                    );
                  }
                  return;
                }
              }
            }

            eventData = migrationResult.data;
          }
        }
      }

      for (const rule of matchingRules) {
        const rawTransformed = await applyTransform(rule.transform, eventData);

        let transformedData: Record<string, unknown>;
        if (
          rawTransformed !== null &&
          typeof rawTransformed === "object" &&
          !Array.isArray(rawTransformed)
        ) {
          transformedData = rawTransformed as Record<string, unknown>;
        } else {
          if (rawTransformed !== eventData) {
            logger.warn(
              "Transform returned non-object result, using original event data",
              {
                workflowId: rule.workflowId,
                transform: rule.transform,
                resultType: Array.isArray(rawTransformed)
                  ? "array"
                  : typeof rawTransformed,
              },
            );
          }
          transformedData = eventData;
        }

        const workflow = await db.query.workflowTable.findFirst({
          where: and(
            eq(workflowTable.id, rule.workflowId),
            eq(workflowTable.isActive, true),
          ),
        });

        if (!workflow) continue;

        // Route through batch accumulator when rule has batch config
        if (rule.batch) {
          const parsed = BatchConfigSchema.safeParse(rule.batch);

          if (!parsed.success) {
            logger.warn("Invalid batch config on rule, skipping batch mode", {
              ruleId: rule.id,
              errors: parsed.error.issues,
            });
            // Fall through to non-batched dispatch below
          } else {
            const ruleId = rule.id;
            const workflowId = rule.workflowId;
            const organizationId = event.organizationId;
            let acc = accumulators.get(ruleId);

            if (!acc) {
              acc = new BatchAccumulator(
                ruleId,
                parsed.data,
                async (events, meta) => {
                  try {
                    // Re-fetch workflow at flush time to avoid stale closures
                    const currentWorkflow =
                      await db.query.workflowTable.findFirst({
                        where: and(
                          eq(workflowTable.id, workflowId),
                          eq(workflowTable.isActive, true),
                        ),
                      });

                    if (!currentWorkflow) {
                      logger.warn(
                        "Workflow deactivated during batch window, discarding batch",
                        {
                          ruleId,
                          workflowId,
                          batchSize: meta.size,
                        },
                      );
                      return;
                    }

                    await withRetry(async () => {
                      const engineWorkflowId = `event-${currentWorkflow.id}-${Date.now()}`;
                      const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

                      const [inserted] = await db
                        .insert(workflowRunTable)
                        .values({
                          workflowId: currentWorkflow.id,
                          engineWorkflowId,
                          engineRunId,
                          status: "pending",
                          input: {
                            events,
                            batchMetadata: meta,
                          },
                        })
                        .returning();

                      const traceCtx = injectTraceContext();

                      await hatchet.event.push("workflow:execute", {
                        workflowId: engineWorkflowId,
                        runId: inserted.id,
                        organizationId,
                        traceContext: traceCtx,
                        triggerData: {
                          events,
                          batchMetadata: meta,
                        },
                        definition: currentWorkflow.definition,
                      });

                      await db
                        .update(workflowRunTable)
                        .set({ status: "running" })
                        .where(eq(workflowRunTable.id, inserted.id));
                    });
                  } catch (err) {
                    logger.error("Failed to dispatch batch after retries", {
                      ruleId,
                      workflowId,
                      batchSize: meta.size,
                      error: err instanceof Error ? err.message : String(err),
                    });

                    // Write all batch events to DLQ so none are silently lost
                    for (const batchEvent of events) {
                      await writeToDlq(
                        batchEvent as OmniEvent,
                        ruleId,
                        err,
                        "DISPATCH_ERROR",
                        3,
                      );
                    }
                  }
                },
              );
              accumulators.set(ruleId, acc);
            }

            await acc.add({ ...event, data: transformedData });
            continue;
          }
        }

        try {
          const run = await withRetry(async () => {
            const engineWorkflowId = `event-${workflow.id}-${Date.now()}`;
            const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

            const [inserted] = await db
              .insert(workflowRunTable)
              .values({
                workflowId: workflow.id,
                engineWorkflowId,
                engineRunId,
                status: "pending",
                input: {
                  event: {
                    id: event.id,
                    type: event.type,
                    subject: event.subject,
                    source: event.source,
                    data: transformedData,
                    correlationId: event.correlationId,
                    timestamp: event.timestamp,
                  },
                },
              })
              .returning();

            // Inject trace context so downstream workflow execution continues the trace
            const traceCtx = injectTraceContext();

            await hatchet.event.push("workflow:execute", {
              workflowId: engineWorkflowId,
              runId: inserted.id,
              organizationId: event.organizationId,
              traceContext: traceCtx,
              triggerData: {
                event: {
                  id: event.id,
                  type: event.type,
                  subject: event.subject,
                  source: event.source,
                  data: transformedData,
                  correlationId: event.correlationId,
                  timestamp: event.timestamp,
                },
              },
              definition: workflow.definition,
            });

            // Optimistically mark as running after successful Hatchet push
            await db
              .update(workflowRunTable)
              .set({ status: "running" })
              .where(eq(workflowRunTable.id, inserted.id));

            return inserted;
          });

          logger.info("Routed event to workflow", {
            eventId: event.id,
            type: event.type,
            workflowId: workflow.id,
            runId: run.id,
          });
        } catch (err) {
          logger.error("Failed to route event after retries", {
            eventId: event.id,
            workflowId: workflow.id,
            error: err instanceof Error ? err.message : String(err),
          });

          await writeToDlq(event, rule.id, err, "DISPATCH_ERROR", 3);
        }
      }
    });

    endSpan(routerSpan);
  } catch (err) {
    endSpan(routerSpan, err);
    throw err;
  }
}

export default routeEvent;
