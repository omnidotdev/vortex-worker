/**
 * SSE (Server-Sent Events) Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "sse"` and opens
 * an SSE connection for each one. When an event arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import { SseAdapter } from "adapters/sse.adapter";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import { getHatchet } from "lib/hatchet";
import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, SseAdapter>();

/** Workflow IDs currently mid-connection (prevents duplicate connections) */
const connectingSet = new Set<string>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

type SseTriggerConfig = {
  url: string;
  headers?: Record<string, string>;
  eventTypes?: string[];
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
};

function extractSseConfig(definition: unknown): SseTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "sse") return null;

  const config = triggerStep.trigger.config as Partial<SseTriggerConfig>;

  if (!config.url) return null;

  return {
    url: config.url as string,
    headers: config.headers as Record<string, string> | undefined,
    eventTypes: config.eventTypes as string[] | undefined,
    reconnectDelayMs: config.reconnectDelayMs as number | undefined,
    maxReconnectAttempts: config.maxReconnectAttempts as number | undefined,
  };
}

async function dispatchFromSse(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `sse-${workflowId}-${Date.now()}`;
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
          trigger: "sse",
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
        trigger: "sse",
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
    logger.error("Failed to dispatch SSE-triggered workflow", {
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

async function startSseConnection(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  sseConfig: SseTriggerConfig;
}): Promise<void> {
  const adapter = new SseAdapter(workflow.sseConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromSse(
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
    logger.info("SSE connection started", {
      workflowId: workflow.id,
      url: workflow.sseConfig.url,
    });
  } catch (err) {
    logger.error("Failed to start SSE connection", {
      workflowId: workflow.id,
      url: workflow.sseConfig.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function scanSseWorkflows(): Promise<void> {
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

    const sseWorkflows = workflows.flatMap((w) => {
      const sseConfig = extractSseConfig(w.definition);
      if (!sseConfig) return [];
      return [{ ...w, sseConfig }];
    });

    const activeWorkflowIds = new Set(sseWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping SSE connection", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("SSE connection stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of sseWorkflows) {
      if (activeAdapters.has(workflow.id) || connectingSet.has(workflow.id))
        continue;

      connectingSet.add(workflow.id);
      try {
        await startSseConnection(workflow);
      } finally {
        connectingSet.delete(workflow.id);
      }
    }
  } catch (err) {
    logger.error("Error scanning SSE workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startSseTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("SSE trigger runner already running");
    return;
  }

  logger.info("SSE trigger runner started");

  scanSseWorkflows();
  scanInterval = setInterval(scanSseWorkflows, SCAN_INTERVAL_MS);
}

export async function stopSseTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping SSE connection during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("SSE trigger runner stopped");
}
