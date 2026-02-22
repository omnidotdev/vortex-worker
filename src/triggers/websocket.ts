/**
 * WebSocket Bidirectional Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "websocket"` and opens
 * a WebSocket connection for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { WebSocketAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID — value is the stop fn
const activeAdapters = new Map<string, WebSocketAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type WebSocketTriggerConfig = {
  url: string;
  messageFormat?: "json" | "text";
  heartbeatIntervalMs?: number;
  authHeaders?: Record<string, string>;
  initMessage?: unknown;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
};

function extractWebSocketConfig(
  definition: unknown,
): WebSocketTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "websocket") return null;

  const config = triggerStep.trigger.config as Partial<WebSocketTriggerConfig>;

  if (!config.url) return null;

  return {
    url: config.url as string,
    messageFormat: config.messageFormat as "json" | "text" | undefined,
    heartbeatIntervalMs: config.heartbeatIntervalMs as number | undefined,
    authHeaders: config.authHeaders as Record<string, string> | undefined,
    initMessage: config.initMessage,
    reconnectDelayMs: config.reconnectDelayMs as number | undefined,
    maxReconnectAttempts: config.maxReconnectAttempts as number | undefined,
  };
}

async function dispatchFromWebSocket(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `ws-${workflowId}-${Date.now()}`;
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
          trigger: "websocket",
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
        trigger: "websocket",
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
    logger.error("Failed to dispatch websocket-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function startWebSocketConnection(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  wsConfig: WebSocketTriggerConfig;
}): Promise<void> {
  const adapter = new WebSocketAdapter(workflow.wsConfig);

  adapter.onEvent(async (event) => {
    await dispatchFromWebSocket(
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
    logger.info("WebSocket connection started", {
      workflowId: workflow.id,
      url: workflow.wsConfig.url,
    });
  } catch (err) {
    logger.error("Failed to start WebSocket connection", {
      workflowId: workflow.id,
      url: workflow.wsConfig.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveWebSocketAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, WebSocketAdapter>> {
  const result = new Map<string, WebSocketAdapter>();

  for (const w of workflows) {
    const wsConfig = extractWebSocketConfig(w.definition);
    if (!wsConfig) continue;

    const adapter = new WebSocketAdapter(wsConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanWebSocketWorkflows(): Promise<void> {
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

    const wsWorkflows = workflows.flatMap((w) => {
      const wsConfig = extractWebSocketConfig(w.definition);
      if (!wsConfig) return [];
      return [{ ...w, wsConfig }];
    });

    const activeWorkflowIds = new Set(wsWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping WebSocket connection", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("WebSocket connection stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of wsWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startWebSocketConnection(workflow);
    }
  } catch (err) {
    logger.error("Error scanning websocket workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startWebSocketTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("WebSocket trigger runner already running");
    return;
  }

  logger.info("WebSocket trigger runner started");

  scanWebSocketWorkflows();
  scanInterval = setInterval(scanWebSocketWorkflows, SCAN_INTERVAL_MS);
}

export async function stopWebSocketTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping WebSocket connection during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("WebSocket trigger runner stopped");
}
