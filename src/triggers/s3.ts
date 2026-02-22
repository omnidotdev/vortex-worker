/**
 * S3 Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "s3"` and starts
 * an S3 poller for each one. When an object change is detected the
 * workflow is dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { S3Adapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

// Scan interval for detecting new/removed s3-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID
const activeAdapters = new Map<string, S3Adapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type S3TriggerConfig = {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  events?: ("created" | "modified" | "deleted")[];
  intervalMs?: number;
};

/**
 * Parse S3 trigger config from workflow definition steps.
 */
function extractS3Config(definition: unknown): S3TriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "s3") return null;

  const config = triggerStep.trigger.config as Partial<S3TriggerConfig>;

  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    return null;
  }

  return {
    bucket: config.bucket as string,
    prefix: config.prefix as string | undefined,
    endpoint: config.endpoint as string | undefined,
    region: config.region as string | undefined,
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
    events: config.events,
    intervalMs: config.intervalMs,
  };
}

/**
 * Dispatch a workflow when an S3 object change is detected.
 */
async function dispatchFromS3(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  objectData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `s3-${workflowId}-${Date.now()}`;
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
          trigger: "s3",
          data: objectData,
          receivedAt: new Date().toISOString(),
        },
      })
      .returning();

    await getHatchet().event.push("workflow:execute", {
      workflowId: run.engineWorkflowId,
      runId: run.id,
      organizationId,
      triggerData: {
        trigger: "s3",
        data: objectData,
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
    logger.error("Failed to dispatch s3-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start an S3 poller for a single workflow.
 */
async function startS3Poller(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  s3Config: S3TriggerConfig;
}): Promise<void> {
  const adapter = new S3Adapter(workflow.s3Config);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromS3(
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
    logger.info("S3 poller started", {
      workflowId: workflow.id,
      bucket: workflow.s3Config.bucket,
      prefix: workflow.s3Config.prefix,
    });
  } catch (err) {
    logger.error("Failed to start S3 poller", {
      workflowId: workflow.id,
      bucket: workflow.s3Config.bucket,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan for active workflows with S3 triggers and reconcile pollers.
 */
async function scanS3Workflows(): Promise<void> {
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

    // Find workflows with s3 triggers that have valid configs
    const s3Workflows = workflows.flatMap((w) => {
      const s3Config = extractS3Config(w.definition);
      if (!s3Config) return [];
      return [{ ...w, s3Config }];
    });

    const activeWorkflowIds = new Set(s3Workflows.map((w) => w.id));

    // Stop pollers for removed/disabled workflows
    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping S3 poller", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("S3 poller stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start pollers for new workflows
    for (const workflow of s3Workflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startS3Poller(workflow);
    }
  } catch (err) {
    logger.error("Error scanning s3 workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the S3 trigger runner.
 */
export function startS3TriggerRunner(): void {
  if (scanInterval) {
    logger.warn("S3 trigger runner already running");
    return;
  }

  logger.info("S3 trigger runner started");

  scanS3Workflows();
  scanInterval = setInterval(scanS3Workflows, SCAN_INTERVAL_MS);
}

/**
 * Stop the S3 trigger runner and disconnect all pollers.
 */
export async function stopS3TriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping S3 poller during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("S3 trigger runner stopped");
}
