/**
 * Event routing engine.
 *
 * Matches incoming events against `event_routing_rule` records and
 * dispatches matching workflows to Hatchet for execution.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { getDb } from "db";
import {
  eventRoutingRuleTable,
  workflowRunTable,
  workflowTable,
} from "db/schema";
import { and, desc, eq } from "drizzle-orm";
import jsonata from "jsonata";
import { JSONPath } from "jsonpath-plus";

import { cacheClient } from "lib/cache/client";
import logger from "lib/logger";

import type Redis from "ioredis";
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
 * Route an incoming event to matching workflows.
 *
 * Queries enabled routing rules for the event's organization, filters
 * by type/source glob patterns, then creates a workflow run and pushes
 * a `workflow:execute` event to Hatchet for each match.
 */
async function routeEvent(event: OmniEvent): Promise<void> {
  const db = getDb();
  const hatchet = getHatchet();

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

    // If the rule specifies a JSONPath condition, it must evaluate to a match
    if (!evaluateCondition(rule.condition, event.data)) return false;

    return true;
  });

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
    await isDuplicate(cacheClient, event.organizationId, event.correlationId)
  ) {
    logger.info("Skipping duplicate event (already routed)", {
      eventId: event.id,
      correlationId: event.correlationId,
      matchedRuleCount: matchingRules.length,
    });
    return;
  }

  for (const rule of matchingRules) {
    const rawTransformed = await applyTransform(rule.transform, event.data);

    let transformedData: Record<string, unknown>;
    if (
      rawTransformed !== null &&
      typeof rawTransformed === "object" &&
      !Array.isArray(rawTransformed)
    ) {
      transformedData = rawTransformed as Record<string, unknown>;
    } else {
      if (rawTransformed !== event.data) {
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
      transformedData = event.data;
    }

    const workflow = await db.query.workflowTable.findFirst({
      where: and(
        eq(workflowTable.id, rule.workflowId),
        eq(workflowTable.isActive, true),
      ),
    });

    if (!workflow) continue;

    try {
      const engineWorkflowId = `event-${workflow.id}-${Date.now()}`;
      const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const [run] = await db
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

      await hatchet.event.push("workflow:execute", {
        workflowId: engineWorkflowId,
        runId: run.id,
        organizationId: event.organizationId,
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
        .where(eq(workflowRunTable.id, run.id));

      logger.info("Routed event to workflow", {
        eventId: event.id,
        type: event.type,
        workflowId: workflow.id,
        runId: run.id,
      });
    } catch (err) {
      logger.error("Failed to route event to workflow", {
        eventId: event.id,
        workflowId: workflow.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export default routeEvent;
