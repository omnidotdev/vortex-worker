/**
 * NATS Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "nats"` and starts
 * a NATS subscription for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { NatsAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, NatsAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type NatsTriggerConfig = {
  servers: string;
  subject: string;
  queue?: string;
  token?: string;
  user?: string;
  pass?: string;
};

function extractNatsConfig(definition: unknown): NatsTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "nats") return null;

  const config = triggerStep.trigger.config as Partial<NatsTriggerConfig>;

  if (!config.servers || !config.subject) return null;

  return {
    servers: config.servers as string,
    subject: config.subject as string,
    queue: config.queue,
    token: config.token,
    user: config.user,
    pass: config.pass,
  };
}

async function dispatchFromNats(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `nats-${workflowId}-${Date.now()}`;
  const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const [run] = await db
      .insert(workflowRunTable)
      .values({
        workflowId,
        engineWorkflowId,
        engineRunId,
        status: "pending",
        input: {
          trigger: "nats",
          data: messageData,
          receivedAt: new Date().toISOString(),
        },
      })
      .returning();

    await getHatchet().event.push("workflow:execute", {
      workflowId: run.engineWorkflowId,
      runId: run.id,
      organizationId,
      triggerData: {
        trigger: "nats",
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
    logger.error("Failed to dispatch nats-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function startNatsConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  natsConfig: NatsTriggerConfig;
}): Promise<void> {
  const adapter = new NatsAdapter(workflow.natsConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromNats(
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
    logger.info("NATS consumer started", {
      workflowId: workflow.id,
      subject: workflow.natsConfig.subject,
      servers: workflow.natsConfig.servers,
    });
  } catch (err) {
    logger.error("Failed to start NATS consumer", {
      workflowId: workflow.id,
      subject: workflow.natsConfig.subject,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveNatsAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, NatsAdapter>> {
  const result = new Map<string, NatsAdapter>();

  for (const w of workflows) {
    const natsConfig = extractNatsConfig(w.definition);
    if (!natsConfig) continue;

    const adapter = new NatsAdapter(natsConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanNatsWorkflows(): Promise<void> {
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

    const natsWorkflows = workflows.flatMap((w) => {
      const natsConfig = extractNatsConfig(w.definition);
      if (!natsConfig) return [];
      return [{ ...w, natsConfig }];
    });

    const activeWorkflowIds = new Set(natsWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping NATS consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("NATS consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of natsWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startNatsConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning nats workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startNatsTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("NATS trigger runner already running");
    return;
  }

  logger.info("NATS trigger runner started");

  scanNatsWorkflows();
  scanInterval = setInterval(scanNatsWorkflows, SCAN_INTERVAL_MS);
}

export async function stopNatsTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping NATS consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("NATS trigger runner stopped");
}
