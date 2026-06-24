/**
 * gRPC Stream Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "grpc_stream"` and starts
 * a gRPC server-stream subscription for each one. When a message arrives the
 * workflow is dispatched via Hatchet's event bus.
 */

import { GrpcStreamAdapter } from "adapters";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import { getHatchet } from "lib/hatchet";
import logger from "lib/logger";
import { applyScheduleFilter, extractSchedule } from "./schedule-filter";

import type { Workflow } from "db/schema";

const SCAN_INTERVAL_MS = 60 * 1_000;

const activeAdapters = new Map<string, GrpcStreamAdapter>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

type GrpcTriggerConfig = {
  address: string;
  protoPath: string;
  service: string;
  method: string;
  requestData?: Record<string, unknown>;
  tls?: boolean;
  metadata?: Record<string, string>;
};

function extractGrpcConfig(definition: unknown): GrpcTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "grpc_stream") return null;

  const config = triggerStep.trigger.config as Partial<GrpcTriggerConfig>;

  if (!config.address || !config.service || !config.method) return null;

  return {
    address: config.address as string,
    protoPath: config.protoPath as string,
    service: config.service as string,
    method: config.method as string,
    requestData: config.requestData,
    tls: config.tls,
    metadata: config.metadata,
  };
}

async function dispatchFromGrpc(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  messageData: unknown,
  idempotencyKey: string,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `grpc-${workflowId}-${Date.now()}`;
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
          trigger: "grpc_stream",
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
        trigger: "grpc_stream",
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
    logger.error("Failed to dispatch grpc-triggered workflow", {
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

async function startGrpcConsumer(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  grpcConfig: GrpcTriggerConfig;
}): Promise<void> {
  const adapter = new GrpcStreamAdapter(workflow.grpcConfig);
  const schedule = extractSchedule(workflow.definition);

  adapter.onEvent(async (event) => {
    const shouldDispatch = await applyScheduleFilter(
      schedule,
      workflow.id,
      JSON.stringify(event.data),
    );
    if (!shouldDispatch) return;

    await dispatchFromGrpc(
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
    logger.info("gRPC stream consumer started", {
      workflowId: workflow.id,
      service: workflow.grpcConfig.service,
      method: workflow.grpcConfig.method,
      address: workflow.grpcConfig.address,
    });
  } catch (err) {
    logger.error("Failed to start gRPC stream consumer", {
      workflowId: workflow.id,
      service: workflow.grpcConfig.service,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a map of active adapters from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveGrpcAdapters(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, GrpcStreamAdapter>> {
  const result = new Map<string, GrpcStreamAdapter>();

  for (const w of workflows) {
    const grpcConfig = extractGrpcConfig(w.definition);
    if (!grpcConfig) continue;

    const adapter = new GrpcStreamAdapter(grpcConfig);
    result.set(w.id, adapter);
  }

  return result;
}

async function scanGrpcWorkflows(): Promise<void> {
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

    const grpcWorkflows = workflows.flatMap((w) => {
      const grpcConfig = extractGrpcConfig(w.definition);
      if (!grpcConfig) return [];
      return [{ ...w, grpcConfig }];
    });

    const activeWorkflowIds = new Set(grpcWorkflows.map((w) => w.id));

    for (const [id, adapter] of activeAdapters) {
      if (!activeWorkflowIds.has(id)) {
        await adapter.stop().catch((err) => {
          logger.error("Error stopping gRPC stream consumer", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        activeAdapters.delete(id);
        logger.info("gRPC stream consumer stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    for (const workflow of grpcWorkflows) {
      if (activeAdapters.has(workflow.id)) continue;
      await startGrpcConsumer(workflow);
    }
  } catch (err) {
    logger.error("Error scanning grpc workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startGrpcTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("gRPC stream trigger runner already running");
    return;
  }

  logger.info("gRPC stream trigger runner started");

  scanGrpcWorkflows();
  scanInterval = setInterval(scanGrpcWorkflows, SCAN_INTERVAL_MS);
}

export async function stopGrpcTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  const stops = [...activeAdapters.entries()].map(async ([id, adapter]) => {
    await adapter.stop().catch((err) => {
      logger.error("Error stopping gRPC stream consumer during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await Promise.all(stops);
  activeAdapters.clear();

  logger.info("gRPC stream trigger runner stopped");
}
