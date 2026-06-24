/**
 * Kafka Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "kafka"` and starts
 * a Kafka consumer for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import { KafkaAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import { getHatchet } from "lib/hatchet";
import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

// Scan interval for detecting new/removed kafka-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active adapters keyed by workflow ID
const activeAdapters = new Map<string, KafkaAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

type KafkaTriggerConfig = {
  brokers: string[];
  topic: string;
  groupId: string;
  fromBeginning?: boolean;
};

/**
 * Parse kafka trigger config from workflow definition steps.
 */
function extractKafkaConfig(definition: unknown): KafkaTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "kafka") return null;

  const config = triggerStep.trigger.config as Partial<KafkaTriggerConfig>;

  if (
    !config.brokers ||
    !Array.isArray(config.brokers) ||
    !config.topic ||
    !config.groupId
  ) {
    return null;
  }

  return {
    brokers: config.brokers as string[],
    topic: config.topic as string,
    groupId: config.groupId as string,
    fromBeginning: config.fromBeginning,
  };
}

/**
 * Dispatch a workflow when a Kafka message arrives.
 */
async function dispatchFromKafka(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `kafka-${workflowId}-${Date.now()}`;
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
          trigger: "kafka",
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
        trigger: "kafka",
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
    logger.error("Failed to dispatch kafka-triggered workflow", {
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
 * Start a Kafka consumer for a single workflow.
 */
async function startKafkaConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  kafkaConfig: KafkaTriggerConfig;
}): Promise<void> {
  const adapter = new KafkaAdapter(workflow.kafkaConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromKafka(
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
    logger.info("Kafka consumer started", {
      workflowId: workflow.id,
      topic: workflow.kafkaConfig.topic,
      groupId: workflow.kafkaConfig.groupId,
    });
  } catch (err) {
    logger.error("Failed to start Kafka consumer", {
      workflowId: workflow.id,
      topic: workflow.kafkaConfig.topic,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan for active workflows with kafka triggers and reconcile consumers.
 */
async function scanKafkaWorkflows(): Promise<void> {
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

    // Find workflows with kafka triggers that have valid configs
    const kafkaWorkflows = workflows.flatMap((w) => {
      const kafkaConfig = extractKafkaConfig(w.definition);
      if (!kafkaConfig) return [];
      return [{ ...w, kafkaConfig }];
    });

    const activeWorkflowIds = new Set(kafkaWorkflows.map((w) => w.id));

    // Stop consumers for removed/disabled workflows
    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping Kafka consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("Kafka consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start consumers for new workflows
    for (const workflow of kafkaWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startKafkaConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning kafka workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the Kafka trigger runner.
 */
export function startKafkaTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("Kafka trigger runner already running");
    return;
  }

  logger.info("Kafka trigger runner started");

  scanKafkaWorkflows();
  scanInterval = setInterval(scanKafkaWorkflows, SCAN_INTERVAL_MS);
}

/**
 * Stop the Kafka trigger runner and disconnect all consumers.
 */
export async function stopKafkaTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping Kafka consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("Kafka trigger runner stopped");
}
