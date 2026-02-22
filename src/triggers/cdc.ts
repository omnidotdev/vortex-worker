/**
 * CDC Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "cdc"` and starts
 * a polling-based change data capture adapter for each one. When a row
 * change is detected the workflow is dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { CdcAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

// Scan interval for detecting new/removed cdc-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID
const activeAdapters = new Map<string, CdcAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type CdcTriggerConfig = {
  connectionString: string;
  tables: string[];
  operations?: ("insert" | "update" | "delete")[];
  intervalMs?: number;
  trackingColumn?: string;
};

/**
 * Parse CDC trigger config from workflow definition steps.
 */
function extractCdcConfig(definition: unknown): CdcTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "cdc") return null;

  const config = triggerStep.trigger.config as Partial<CdcTriggerConfig>;

  if (
    !config.connectionString ||
    !config.tables ||
    !Array.isArray(config.tables) ||
    config.tables.length === 0
  ) {
    return null;
  }

  return {
    connectionString: config.connectionString as string,
    tables: config.tables as string[],
    operations: config.operations,
    intervalMs: config.intervalMs,
    trackingColumn: config.trackingColumn,
  };
}

/**
 * Dispatch a workflow when a CDC row change is detected.
 */
async function dispatchFromCdc(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  triggerData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `cdc-${workflowId}-${Date.now()}`;
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
          trigger: "cdc",
          data: triggerData,
          receivedAt: new Date().toISOString(),
        },
      })
      .returning();

    await getHatchet().event.push("workflow:execute", {
      workflowId: run.engineWorkflowId,
      runId: run.id,
      organizationId,
      triggerData: {
        trigger: "cdc",
        data: triggerData,
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
    logger.error("Failed to dispatch cdc-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start a CDC adapter for a single workflow.
 */
async function startCdcConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  cdcConfig: CdcTriggerConfig;
}): Promise<void> {
  const adapter = new CdcAdapter(workflow.cdcConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromCdc(
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
    logger.info("CDC adapter started", {
      workflowId: workflow.id,
      tables: workflow.cdcConfig.tables,
    });
  } catch (err) {
    logger.error("Failed to start CDC adapter", {
      workflowId: workflow.id,
      tables: workflow.cdcConfig.tables,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan for active workflows with CDC triggers and reconcile adapters.
 */
async function scanCdcWorkflows(): Promise<void> {
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

    // Find workflows with CDC triggers that have valid configs
    const cdcWorkflows = workflows.flatMap((w) => {
      const cdcConfig = extractCdcConfig(w.definition);
      if (!cdcConfig) return [];
      return [{ ...w, cdcConfig }];
    });

    const activeWorkflowIds = new Set(cdcWorkflows.map((w) => w.id));

    // Stop adapters for removed/disabled workflows
    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping CDC adapter", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("CDC adapter stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start adapters for new workflows
    for (const workflow of cdcWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startCdcConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning cdc workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the CDC trigger runner.
 */
export function startCdcTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("CDC trigger runner already running");
    return;
  }

  logger.info("CDC trigger runner started");

  scanCdcWorkflows();
  scanInterval = setInterval(scanCdcWorkflows, SCAN_INTERVAL_MS);
}

/**
 * Stop the CDC trigger runner and disconnect all adapters.
 */
export async function stopCdcTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping CDC adapter during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("CDC trigger runner stopped");
}
