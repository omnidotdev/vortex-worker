/**
 * Polling Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "polling"` and starts
 * a polling adapter for each one. When a change is detected the workflow
 * is dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { PollingAdapter } from "adapters/polling.adapter";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { isBlockedUrl } from "lib/ssrf";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, PollingAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type PollingTriggerConfig = {
  url: string;
  intervalMs?: number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  dedup?: {
    mode: "hash" | "field";
    fieldPath?: string;
  };
};

function extractPollingConfig(
  definition: unknown,
): PollingTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "polling") return null;

  const config = triggerStep.trigger.config as Partial<PollingTriggerConfig>;

  if (!config.url) return null;

  // SSRF protection: reject polling URLs targeting private/internal addresses
  try {
    const parsedUrl = new URL(config.url as string);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }
    if (isBlockedUrl(parsedUrl)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    url: config.url as string,
    intervalMs: config.intervalMs as number | undefined,
    method: config.method as "GET" | "POST" | undefined,
    headers: config.headers as Record<string, string> | undefined,
    body: config.body,
    dedup: config.dedup as PollingTriggerConfig["dedup"],
  };
}

async function dispatchFromPolling(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  pollData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `polling-${workflowId}-${Date.now()}`;
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
          trigger: "polling",
          data: pollData,
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
        trigger: "polling",
        data: pollData,
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
    logger.error("Failed to dispatch polling-triggered workflow", {
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

async function startPollingConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  pollingConfig: PollingTriggerConfig;
}): Promise<void> {
  const adapter = new PollingAdapter(workflow.pollingConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromPolling(
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
    logger.info("Polling consumer started", {
      workflowId: workflow.id,
      url: workflow.pollingConfig.url,
      intervalMs: workflow.pollingConfig.intervalMs ?? 60_000,
    });
  } catch (err) {
    logger.error("Failed to start polling consumer", {
      workflowId: workflow.id,
      url: workflow.pollingConfig.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActivePollingAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, PollingAdapter>> {
  const result = new Map<string, PollingAdapter>();

  for (const w of workflows) {
    const pollingConfig = extractPollingConfig(w.definition);
    if (!pollingConfig) continue;

    const adapter = new PollingAdapter(pollingConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanPollingWorkflows(): Promise<void> {
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

    const pollingWorkflows = workflows.flatMap((w) => {
      const pollingConfig = extractPollingConfig(w.definition);
      if (!pollingConfig) return [];
      return [{ ...w, pollingConfig }];
    });

    const activeWorkflowIds = new Set(pollingWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping polling consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("Polling consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of pollingWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startPollingConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning polling workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startPollingTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("Polling trigger runner already running");
    return;
  }

  logger.info("Polling trigger runner started");

  scanPollingWorkflows();
  scanInterval = setInterval(scanPollingWorkflows, SCAN_INTERVAL_MS);
}

export async function stopPollingTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping polling consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("Polling trigger runner stopped");
}
