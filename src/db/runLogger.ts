/**
 * Workflow run and step logging utilities.
 * Handles persisting execution state to the database for debugging and monitoring.
 */

import { and, eq } from "drizzle-orm";

import { recordUsage } from "billing";
import { VortexError } from "lib/errors";
import logger from "lib/logger";
import { getDb } from "./index";
import { redactSensitive } from "./redact";
import { workflowRunTable, workflowStepLogTable } from "./schema";

type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface CreateWorkflowRunParams {
  workflowId?: string;
  engineWorkflowId: string;
  engineRunId: string;
  input?: unknown;
}

export interface LogStepStartParams {
  stepId: string;
  stepName: string;
  stepType: string;
  input?: unknown;
}

/**
 * Create a new workflow run record.
 * Returns the database ID of the created run.
 */
export async function createWorkflowRun(
  params: CreateWorkflowRunParams,
): Promise<string> {
  const db = getDb();

  const [run] = await db
    .insert(workflowRunTable)
    .values({
      workflowId: params.workflowId || null,
      engineWorkflowId: params.engineWorkflowId,
      engineRunId: params.engineRunId,
      status: "running" as RunStatus,
      input: redactSensitive(params.input),
      startedAt: new Date(),
    })
    .returning({ id: workflowRunTable.id });

  return run.id;
}

/**
 * Log the start of a step execution.
 * Returns the database ID of the created step log.
 */
export async function logStepStart(
  runId: string,
  params: LogStepStartParams,
): Promise<string> {
  const db = getDb();

  const [stepLog] = await db
    .insert(workflowStepLogTable)
    .values({
      workflowRunId: runId,
      stepId: params.stepId,
      stepName: params.stepName,
      stepType: params.stepType,
      status: "running" as StepStatus,
      input: redactSensitive(params.input),
      startedAt: new Date(),
    })
    .returning({ id: workflowStepLogTable.id });

  return stepLog.id;
}

/**
 * Log successful completion of a step.
 */
export async function logStepComplete(
  runId: string,
  stepId: string,
  output: unknown,
  organizationId?: string,
): Promise<void> {
  const db = getDb();

  await db
    .update(workflowStepLogTable)
    .set({
      status: "completed" as StepStatus,
      output: redactSensitive(output),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowStepLogTable.workflowRunId, runId),
        eq(workflowStepLogTable.stepId, stepId),
      ),
    );

  if (organizationId) {
    void recordUsage(
      "organization",
      organizationId,
      "step_executions",
      1,
      `step-${runId}-${stepId}`,
    );
  }
}

/**
 * Log a step failure.
 */
export async function logStepFailed(
  runId: string,
  stepId: string,
  error: Error | unknown,
  organizationId?: string,
): Promise<void> {
  const db = getDb();

  const baseMessage =
    error instanceof Error
      ? `${error.message}\n${error.stack || ""}`
      : String(error);

  const errorMessage =
    error instanceof VortexError
      ? `[${error.code}] ${baseMessage}`
      : baseMessage;

  await db
    .update(workflowStepLogTable)
    .set({
      status: "failed" as StepStatus,
      error: errorMessage,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowStepLogTable.workflowRunId, runId),
        eq(workflowStepLogTable.stepId, stepId),
      ),
    );

  if (organizationId) {
    void recordUsage(
      "organization",
      organizationId,
      "step_executions",
      1,
      `step-${runId}-${stepId}`,
    );
  }
}

/**
 * Log a step as skipped (e.g., condition not met).
 * @knipignore Part of complete logging API
 */
export async function logStepSkipped(
  runId: string,
  stepId: string,
): Promise<void> {
  const db = getDb();

  await db
    .update(workflowStepLogTable)
    .set({
      status: "skipped" as StepStatus,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowStepLogTable.workflowRunId, runId),
        eq(workflowStepLogTable.stepId, stepId),
      ),
    );
}

/**
 * Mark a workflow run as completed successfully.
 */
export async function markRunComplete(
  runId: string,
  output?: unknown,
  organizationId?: string,
): Promise<void> {
  const db = getDb();

  await db
    .update(workflowRunTable)
    .set({
      status: "completed" as RunStatus,
      output: redactSensitive(output),
      completedAt: new Date(),
    })
    .where(eq(workflowRunTable.id, runId));

  if (organizationId) {
    const [run] = await db
      .select({ startedAt: workflowRunTable.startedAt })
      .from(workflowRunTable)
      .where(eq(workflowRunTable.id, runId));

    if (run?.startedAt) {
      const durationMs = Date.now() - run.startedAt.getTime();
      void recordUsage(
        "organization",
        organizationId,
        "compute_ms",
        durationMs,
        `compute-${runId}`,
      );
    } else {
      logger.warn("Cannot record compute_ms: run missing startedAt", {
        runId,
      });
    }
  }
}

/**
 * Mark a workflow run as failed.
 */
export async function markRunFailed(
  runId: string,
  error: Error | unknown,
  organizationId?: string,
): Promise<void> {
  const db = getDb();

  const baseMessage =
    error instanceof Error
      ? `${error.message}\n${error.stack || ""}`
      : String(error);

  const errorMessage =
    error instanceof VortexError
      ? `[${error.code}] ${baseMessage}`
      : baseMessage;

  await db
    .update(workflowRunTable)
    .set({
      status: "failed" as RunStatus,
      error: errorMessage,
      completedAt: new Date(),
    })
    .where(eq(workflowRunTable.id, runId));

  if (organizationId) {
    const [run] = await db
      .select({ startedAt: workflowRunTable.startedAt })
      .from(workflowRunTable)
      .where(eq(workflowRunTable.id, runId));

    if (run?.startedAt) {
      const durationMs = Date.now() - run.startedAt.getTime();
      void recordUsage(
        "organization",
        organizationId,
        "compute_ms",
        durationMs,
        `compute-${runId}`,
      );
    } else {
      logger.warn("Cannot record compute_ms: run missing startedAt", {
        runId,
      });
    }
  }
}

/**
 * Mark a workflow run as cancelled.
 * @knipignore Part of complete logging API
 */
export async function markRunCancelled(runId: string): Promise<void> {
  const db = getDb();

  await db
    .update(workflowRunTable)
    .set({
      status: "cancelled" as RunStatus,
      completedAt: new Date(),
    })
    .where(eq(workflowRunTable.id, runId));
}
