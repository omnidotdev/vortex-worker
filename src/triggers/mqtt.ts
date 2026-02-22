/**
 * MQTT Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "mqtt"` and starts
 * an MQTT client for each one. When a message arrives the workflow is
 * dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { MqttAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, MqttAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type MqttTriggerConfig = {
  brokerUrl: string;
  topic: string;
  clientId?: string;
  username?: string;
  password?: string;
  qos?: 0 | 1 | 2;
  cleanSession?: boolean;
};

function extractMqttConfig(definition: unknown): MqttTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "mqtt") return null;

  const config = triggerStep.trigger.config as Partial<MqttTriggerConfig>;

  if (!config.brokerUrl || !config.topic) return null;

  return {
    brokerUrl: config.brokerUrl as string,
    topic: config.topic as string,
    clientId: config.clientId,
    username: config.username,
    password: config.password,
    qos: config.qos as 0 | 1 | 2 | undefined,
    cleanSession: config.cleanSession,
  };
}

async function dispatchFromMqtt(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `mqtt-${workflowId}-${Date.now()}`;
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
          trigger: "mqtt",
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
        trigger: "mqtt",
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
    logger.error("Failed to dispatch mqtt-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function startMqttConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  mqttConfig: MqttTriggerConfig;
}): Promise<void> {
  const adapter = new MqttAdapter(workflow.mqttConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromMqtt(
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
    logger.info("MQTT consumer started", {
      workflowId: workflow.id,
      topic: workflow.mqttConfig.topic,
      brokerUrl: workflow.mqttConfig.brokerUrl,
    });
  } catch (err) {
    logger.error("Failed to start MQTT consumer", {
      workflowId: workflow.id,
      topic: workflow.mqttConfig.topic,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveMqttAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, MqttAdapter>> {
  const result = new Map<string, MqttAdapter>();

  for (const w of workflows) {
    const mqttConfig = extractMqttConfig(w.definition);
    if (!mqttConfig) continue;

    const adapter = new MqttAdapter(mqttConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanMqttWorkflows(): Promise<void> {
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

    const mqttWorkflows = workflows.flatMap((w) => {
      const mqttConfig = extractMqttConfig(w.definition);
      if (!mqttConfig) return [];
      return [{ ...w, mqttConfig }];
    });

    const activeWorkflowIds = new Set(mqttWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping MQTT consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("MQTT consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of mqttWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startMqttConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning mqtt workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startMqttTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("MQTT trigger runner already running");
    return;
  }

  logger.info("MQTT trigger runner started");

  scanMqttWorkflows();
  scanInterval = setInterval(scanMqttWorkflows, SCAN_INTERVAL_MS);
}

export async function stopMqttTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping MQTT consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("MQTT trigger runner stopped");
}
