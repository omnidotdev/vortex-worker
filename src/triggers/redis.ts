/**
 * Redis Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "redis"` and starts
 * a Redis pub/sub subscriber for each one. When a message arrives the
 * workflow is dispatched via Hatchet's event bus.
 */

import { RedisAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import { getHatchet } from "lib/hatchet";
import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

// Scan interval for detecting new/removed redis-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID
const activeAdapters = new Map<string, RedisAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

type RedisTriggerConfig = {
  url?: string;
  channels?: string[];
  patterns?: string[];
};

/**
 * Parse redis trigger config from workflow definition steps.
 */
function extractRedisConfig(definition: unknown): RedisTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "redis") return null;

  const config = triggerStep.trigger.config as Partial<RedisTriggerConfig>;

  const hasChannels =
    Array.isArray(config.channels) && config.channels.length > 0;
  const hasPatterns =
    Array.isArray(config.patterns) && config.patterns.length > 0;

  if (!hasChannels && !hasPatterns) return null;

  return {
    url: config.url as string | undefined,
    channels: hasChannels ? (config.channels as string[]) : undefined,
    patterns: hasPatterns ? (config.patterns as string[]) : undefined,
  };
}

/**
 * Dispatch a workflow when a Redis message arrives.
 */
async function dispatchFromRedis(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `redis-${workflowId}-${Date.now()}`;
  const engineRunId = `run-${crypto.randomUUID()}`;

  let runId: string | undefined;

  try {
    const [run] = await db
      .insert(workflowRunTable)
      .values({
        workflowId,
        engineWorkflowId,
        engineRunId,
        status: "pending",
        input: {
          trigger: "redis",
          data: messageData,
          receivedAt: new Date().toISOString(),
        },
      })
      .returning();

    runId = run.id;

    await getHatchet().event.push("workflow:execute", {
      workflowId: run.engineWorkflowId,
      runId: run.id,
      organizationId,
      triggerData: {
        trigger: "redis",
        data: messageData,
        receivedAt: new Date().toISOString(),
        idempotencyKey,
      },
      definition,
    });

    await db
      .update(workflowRunTable)
      .set({ status: "running" })
      .where(eq(workflowRunTable.id, run.id));
  } catch (err) {
    logger.error("Failed to dispatch redis-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });

    if (runId) {
      await db
        .update(workflowRunTable)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(workflowRunTable.id, runId))
        .catch(() => {});
    }
  }
}

/**
 * Start a Redis subscriber for a single workflow.
 */
async function startRedisConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  redisConfig: RedisTriggerConfig;
}): Promise<void> {
  const adapter = new RedisAdapter(workflow.redisConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromRedis(
      workflow.id,
      workflow.organizationId,
      workflow.definition,
      event.data,
      event.metadata.idempotencyKey,
    );
  });

  try {
    await adapter.start();
    activeAdapters.set(workflow.id, adapter);
    logger.info("Redis consumer started", {
      workflowId: workflow.id,
      channels: workflow.redisConfig.channels,
      patterns: workflow.redisConfig.patterns,
    });
  } catch (err) {
    logger.error("Failed to start Redis consumer", {
      workflowId: workflow.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveRedisAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, RedisAdapter>> {
  const result = new Map<string, RedisAdapter>();

  for (const w of workflows) {
    const redisConfig = extractRedisConfig(w.definition);
    if (!redisConfig) continue;

    const adapter = new RedisAdapter(redisConfig);
    result.set(w.id, adapter);
  }

  return result;
}

/**
 * Scan for active workflows with redis triggers and reconcile subscribers.
 */
async function scanRedisWorkflows(): Promise<void> {
  const db = getDb();

  try {
    const workflows = await db.query.workflowTable.findMany({
      where: eq(workflowTable.isActive, true),
      columns: {
        id: true,
        organizationId: true,
        definition: true,
      },
    });

    // Find workflows with redis triggers that have valid configs
    const redisWorkflows = workflows.flatMap((w) => {
      const redisConfig = extractRedisConfig(w.definition);
      if (!redisConfig) return [];
      return [{ ...w, redisConfig }];
    });

    const activeWorkflowIds = new Set(redisWorkflows.map((w) => w.id));

    // Stop subscribers for removed/disabled workflows
    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping Redis consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("Redis consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start subscribers for new workflows
    for (const workflow of redisWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startRedisConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning redis workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the Redis trigger runner.
 */
export function startRedisTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("Redis trigger runner already running");
    return;
  }

  logger.info("Redis trigger runner started");

  scanRedisWorkflows();
  scanInterval = setInterval(scanRedisWorkflows, SCAN_INTERVAL_MS);
}

/**
 * Stop the Redis trigger runner and disconnect all subscribers.
 */
export async function stopRedisTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping Redis consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("Redis trigger runner stopped");
}
