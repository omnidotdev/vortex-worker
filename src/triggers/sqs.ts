/**
 * SQS Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "sqs"` and starts
 * an SQS poller for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { SqsAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

// Scan interval for detecting new/removed sqs-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID
const activeAdapters = new Map<string, SqsAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type SqsTriggerConfig = {
  queueUrl: string;
  region: string;
  batchSize?: number;
};

/**
 * Parse SQS trigger config from workflow definition steps.
 */
function extractSqsConfig(definition: unknown): SqsTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "sqs") return null;

  const config = triggerStep.trigger.config as Partial<SqsTriggerConfig>;

  if (!config.queueUrl || !config.region) return null;

  return {
    queueUrl: config.queueUrl as string,
    region: config.region as string,
    batchSize: config.batchSize,
  };
}

/**
 * Dispatch a workflow when an SQS message arrives.
 */
async function dispatchFromSqs(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `sqs-${workflowId}-${Date.now()}`;
  const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

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
          trigger: "sqs",
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
        trigger: "sqs",
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
    logger.error("Failed to dispatch sqs-triggered workflow", {
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
 * Start an SQS poller for a single workflow.
 */
async function startSqsPoller(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  sqsConfig: SqsTriggerConfig;
}): Promise<void> {
  const adapter = new SqsAdapter(workflow.sqsConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromSqs(
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
    logger.info("SQS poller started", {
      workflowId: workflow.id,
      queueUrl: workflow.sqsConfig.queueUrl,
      region: workflow.sqsConfig.region,
    });
  } catch (err) {
    logger.error("Failed to start SQS poller", {
      workflowId: workflow.id,
      queueUrl: workflow.sqsConfig.queueUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan for active workflows with SQS triggers and reconcile pollers.
 */
async function scanSqsWorkflows(): Promise<void> {
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

    // Find workflows with sqs triggers that have valid configs
    const sqsWorkflows = workflows.flatMap((w) => {
      const sqsConfig = extractSqsConfig(w.definition);
      if (!sqsConfig) return [];
      return [{ ...w, sqsConfig }];
    });

    const activeWorkflowIds = new Set(sqsWorkflows.map((w) => w.id));

    // Stop pollers for removed/disabled workflows
    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping SQS poller", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("SQS poller stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start pollers for new workflows
    for (const workflow of sqsWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startSqsPoller(workflow);
    }
  } catch (err) {
    logger.error("Error scanning sqs workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the SQS trigger runner.
 */
export function startSqsTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("SQS trigger runner already running");
    return;
  }

  logger.info("SQS trigger runner started");

  scanSqsWorkflows();
  scanInterval = setInterval(scanSqsWorkflows, SCAN_INTERVAL_MS);
}

/**
 * Stop the SQS trigger runner and disconnect all pollers.
 */
export async function stopSqsTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping SQS poller during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("SQS trigger runner stopped");
}
