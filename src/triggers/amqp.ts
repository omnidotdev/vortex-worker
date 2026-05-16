/**
 * AMQP Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "amqp"` and starts
 * an AMQP consumer for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { AmqpAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, AmqpAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type AmqpTriggerConfig = {
  url: string;
  queue: string;
  exchange?: string;
  routingKey?: string;
  prefetch?: number;
  durable?: boolean;
};

function extractAmqpConfig(definition: unknown): AmqpTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "amqp") return null;

  const config = triggerStep.trigger.config as Partial<AmqpTriggerConfig>;

  if (!config.url || !config.queue) return null;

  return {
    url: config.url as string,
    queue: config.queue as string,
    exchange: config.exchange,
    routingKey: config.routingKey,
    prefetch: config.prefetch,
    durable: config.durable,
  };
}

async function dispatchFromAmqp(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `amqp-${workflowId}-${Date.now()}`;
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
          trigger: "amqp",
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
        trigger: "amqp",
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
    logger.error("Failed to dispatch amqp-triggered workflow", {
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

async function startAmqpConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  amqpConfig: AmqpTriggerConfig;
}): Promise<void> {
  const adapter = new AmqpAdapter(workflow.amqpConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromAmqp(
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
    logger.info("AMQP consumer started", {
      workflowId: workflow.id,
      queue: workflow.amqpConfig.queue,
      url: workflow.amqpConfig.url,
    });
  } catch (err) {
    logger.error("Failed to start AMQP consumer", {
      workflowId: workflow.id,
      queue: workflow.amqpConfig.queue,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveAmqpAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, AmqpAdapter>> {
  const result = new Map<string, AmqpAdapter>();

  for (const w of workflows) {
    const amqpConfig = extractAmqpConfig(w.definition);
    if (!amqpConfig) continue;

    const adapter = new AmqpAdapter(amqpConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanAmqpWorkflows(): Promise<void> {
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

    const amqpWorkflows = workflows.flatMap((w) => {
      const amqpConfig = extractAmqpConfig(w.definition);
      if (!amqpConfig) return [];
      return [{ ...w, amqpConfig }];
    });

    const activeWorkflowIds = new Set(amqpWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping AMQP consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("AMQP consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of amqpWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startAmqpConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning amqp workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startAmqpTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("AMQP trigger runner already running");
    return;
  }

  logger.info("AMQP trigger runner started");

  scanAmqpWorkflows();
  scanInterval = setInterval(scanAmqpWorkflows, SCAN_INTERVAL_MS);
}

export async function stopAmqpTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping AMQP consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("AMQP trigger runner stopped");
}
