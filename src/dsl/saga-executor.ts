/**
 * Saga executor for distributed transactions with compensation on failure.
 *
 * Steps run sequentially by default. If step N fails after retries,
 * compensate steps N-1 down to 0 in reverse order. When `saga.parallel`
 * is true, all execute steps run concurrently and compensation applies
 * to all completed steps on any failure.
 */

import { eq } from "drizzle-orm";

import { ExecutionError, TimeoutError } from "lib/errors";
import logger from "lib/logger";
import { getDb } from "../db";
import { sagaRunTable, sagaStepLogTable } from "../db/schema";
import { publish } from "../events/publisher";

import type { ExecutionContext, SagaStep, SagaStepAction } from "./types";

type SagaRunStatus =
  | "running"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed";

type StepPhaseStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Parse a duration string like "30s", "5m", "1h" into milliseconds.
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return 30_000;

  const value = Number.parseFloat(match[1]);
  const unit = (match[2] || "s").toLowerCase();

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return value * 1_000;
  }
}

/**
 * Sleep for a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a single saga action (HTTP, emit, or integration).
 */
async function executeSagaAction(
  action: SagaStepAction,
  ctx: ExecutionContext,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    switch (action.type) {
      case "http": {
        if (!action.url) {
          throw new ExecutionError("Saga HTTP action requires `url`");
        }

        const response = await fetch(action.url, {
          method: action.method || "POST",
          headers: {
            "Content-Type": "application/json",
            ...action.headers,
          },
          body: action.body ? JSON.stringify(action.body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new ExecutionError(
            `Saga HTTP action failed with status ${response.status}`,
            { url: action.url, status: response.status, body: text },
          );
        }

        const contentType = response.headers.get("content-type") || "";

        return contentType.includes("application/json")
          ? await response.json()
          : await response.text();
      }

      case "emit": {
        if (!action.event) {
          throw new ExecutionError("Saga emit action requires `event`");
        }

        const published = await publish({
          type: action.event,
          source: `vortex-worker/saga/${ctx.workflowId}`,
          organizationId: ctx.organizationId || "",
          data: (action.data as Record<string, unknown>) || {},
        });

        return published ? { eventId: published.id } : { emitted: false };
      }

      case "action": {
        if (!action.integrationId || !action.operation) {
          throw new ExecutionError(
            "Saga action type requires `integrationId` and `operation`",
          );
        }

        // Delegate to the connector executor via dynamic import to avoid circular deps
        const { executeConnectorAction } = await import(
          "../connectors/executor"
        );
        const { getIntegrationCredentials } = await import(
          "../integrations/credentials"
        );

        let auth:
          | import("../connectors/types").DecryptedCredentialValue
          | undefined;

        if (ctx.organizationId) {
          auth = await getIntegrationCredentials(
            ctx.organizationId,
            action.integrationId,
          );
        }

        const result = await executeConnectorAction(
          action.integrationId,
          action.operation,
          (action.config as Record<string, unknown>) || {},
          undefined,
          auth,
        );

        if (!result.success) {
          throw new ExecutionError("Saga integration action failed", {
            integrationId: action.integrationId,
            operation: action.operation,
            error: result.error,
          });
        }

        return result.output || { success: true };
      }

      default:
        throw new ExecutionError(`Unknown saga action type: ${action.type}`);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TimeoutError("Saga action timed out", { timeoutMs });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a single saga step with retries and exponential backoff.
 */
async function executeStepWithRetries(
  action: SagaStepAction,
  ctx: ExecutionContext,
  timeoutMs: number,
  maxRetries: number,
): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeSagaAction(action, ctx, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, 8s...
        const backoffMs = Math.min(1_000 * 2 ** attempt, 30_000);
        logger.debug("Saga step attempt failed, retrying", {
          attempt: attempt + 1,
          maxRetries,
          backoffMs,
          error: lastError.message,
        });
        await sleep(backoffMs);
      }
    }
  }

  throw lastError;
}

/**
 * Update saga run status in the database.
 */
async function updateSagaRunStatus(
  sagaRunId: string,
  status: SagaRunStatus,
  error?: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(sagaRunTable)
    .set({
      status,
      ...(error ? { error } : {}),
      ...(status === "completed" ||
      status === "failed" ||
      status === "compensation_failed"
        ? { completedAt: now }
        : {}),
      updatedAt: now,
    })
    .where(eq(sagaRunTable.id, sagaRunId));
}

/**
 * Update saga step log phase status in the database.
 */
async function updateStepLogPhase(
  stepLogId: string,
  phase: "execute" | "compensate",
  status: StepPhaseStatus,
  data?: { output?: unknown; error?: string },
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = {};

  if (phase === "execute") {
    updates.executeStatus = status;
    if (data?.output !== undefined) updates.executeOutput = data.output;
  } else {
    updates.compensateStatus = status;
    if (data?.output !== undefined) updates.compensateOutput = data.output;
  }

  if (data?.error) updates.error = data.error;
  if (status === "running") updates.startedAt = now;
  if (status === "completed" || status === "failed") updates.completedAt = now;

  await db
    .update(sagaStepLogTable)
    .set(updates)
    .where(eq(sagaStepLogTable.id, stepLogId));
}

/**
 * Execute a saga workflow step.
 *
 * Creates tracking records, executes steps in sequence (or parallel),
 * and triggers compensation on failure.
 */
async function executeSaga(
  step: SagaStep,
  ctx: ExecutionContext,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const { saga } = step;

  // Create the saga run record
  const [sagaRun] = await db
    .insert(sagaRunTable)
    .values({
      workflowRunId: ctx.runId,
      organizationId: ctx.organizationId || "",
      status: "running",
    })
    .returning();

  const sagaRunId = sagaRun.id;

  // Create step log records for each saga step
  const stepLogIds: string[] = [];

  for (const sagaStepDef of saga.steps) {
    const [stepLog] = await db
      .insert(sagaStepLogTable)
      .values({
        sagaRunId,
        stepName: sagaStepDef.name,
        idempotencyKey: `${sagaRunId}:${sagaStepDef.name}`,
        executeStatus: "pending",
        compensateStatus: "pending",
        executeInput: sagaStepDef.execute,
      })
      .returning();

    stepLogIds.push(stepLog.id);
  }

  const outputs: Record<string, unknown> = {};
  // Track which steps completed successfully (for compensation)
  const completedStepIndices: number[] = [];

  try {
    if (saga.parallel) {
      // Parallel execution: run all steps concurrently
      const results = await Promise.allSettled(
        saga.steps.map(async (sagaStepDef, index) => {
          const stepLogId = stepLogIds[index];
          await updateStepLogPhase(stepLogId, "execute", "running");

          const timeoutMs = parseDuration(sagaStepDef.timeout);
          const result = await executeStepWithRetries(
            sagaStepDef.execute,
            ctx,
            timeoutMs,
            sagaStepDef.retries,
          );

          await updateStepLogPhase(stepLogId, "execute", "completed", {
            output: result,
          });

          return { index, name: sagaStepDef.name, result };
        }),
      );

      // Process results: collect successes, find first failure
      let firstError: Error | null = null;

      for (const settledResult of results) {
        if (settledResult.status === "fulfilled") {
          const { index, name, result } = settledResult.value;
          completedStepIndices.push(index);
          outputs[name] = result;
        } else if (!firstError) {
          firstError =
            settledResult.reason instanceof Error
              ? settledResult.reason
              : new Error(String(settledResult.reason));
        }
      }

      // Mark failed step logs
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const err =
            (results[i] as PromiseRejectedResult).reason instanceof Error
              ? (results[i] as PromiseRejectedResult).reason
              : new Error(
                  String((results[i] as PromiseRejectedResult).reason),
                );
          await updateStepLogPhase(stepLogIds[i], "execute", "failed", {
            error: err.message,
          });
        }
      }

      if (firstError) {
        throw firstError;
      }
    } else {
      // Sequential execution: run steps one at a time
      for (let i = 0; i < saga.steps.length; i++) {
        const sagaStepDef = saga.steps[i];
        const stepLogId = stepLogIds[i];

        await updateStepLogPhase(stepLogId, "execute", "running");

        try {
          const timeoutMs = parseDuration(sagaStepDef.timeout);
          const result = await executeStepWithRetries(
            sagaStepDef.execute,
            ctx,
            timeoutMs,
            sagaStepDef.retries,
          );

          await updateStepLogPhase(stepLogId, "execute", "completed", {
            output: result,
          });

          outputs[sagaStepDef.name] = result;
          completedStepIndices.push(i);

          // Make step output available for subsequent steps via context
          ctx.variables[`saga.${sagaStepDef.name}`] = result;
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));

          await updateStepLogPhase(stepLogId, "execute", "failed", {
            error: err.message,
          });

          logger.error("Saga step execution failed", {
            sagaRunId,
            stepName: sagaStepDef.name,
            stepIndex: i,
            error: err.message,
          });

          throw err;
        }
      }
    }

    // All steps completed successfully
    await updateSagaRunStatus(sagaRunId, "completed");

    return {
      sagaRunId,
      status: "completed",
      outputs,
    };
  } catch (executeError) {
    const err =
      executeError instanceof Error
        ? executeError
        : new Error(String(executeError));

    logger.info("Saga execution failed, starting compensation", {
      sagaRunId,
      completedSteps: completedStepIndices.length,
      error: err.message,
    });

    // Begin compensation in reverse order for completed steps
    await updateSagaRunStatus(sagaRunId, "compensating");

    const compensationErrors: string[] = [];

    // Compensate in reverse order of completion
    const sortedIndices = [...completedStepIndices].sort((a, b) => b - a);

    for (const stepIndex of sortedIndices) {
      const sagaStepDef = saga.steps[stepIndex];
      const stepLogId = stepLogIds[stepIndex];

      try {
        await updateStepLogPhase(stepLogId, "compensate", "running");

        const timeoutMs = parseDuration(sagaStepDef.timeout);
        const compensateResult = await executeSagaAction(
          sagaStepDef.compensate,
          ctx,
          timeoutMs,
        );

        await updateStepLogPhase(stepLogId, "compensate", "completed", {
          output: compensateResult,
        });

        logger.debug("Saga step compensated", {
          sagaRunId,
          stepName: sagaStepDef.name,
        });
      } catch (compError) {
        const compErr =
          compError instanceof Error
            ? compError
            : new Error(String(compError));

        compensationErrors.push(
          `${sagaStepDef.name}: ${compErr.message}`,
        );

        await updateStepLogPhase(stepLogId, "compensate", "failed", {
          error: compErr.message,
        });

        logger.error("Saga step compensation failed", {
          sagaRunId,
          stepName: sagaStepDef.name,
          error: compErr.message,
        });
      }
    }

    // Mark steps that were not executed as skipped
    for (let i = 0; i < saga.steps.length; i++) {
      if (!completedStepIndices.includes(i)) {
        // Skip already-failed steps (the one that triggered compensation)
        const currentLog = await db
          .select()
          .from(sagaStepLogTable)
          .where(eq(sagaStepLogTable.id, stepLogIds[i]))
          .limit(1);

        if (currentLog[0]?.executeStatus === "pending") {
          await updateStepLogPhase(stepLogIds[i], "execute", "skipped");
          await updateStepLogPhase(stepLogIds[i], "compensate", "skipped");
        }
      }
    }

    if (compensationErrors.length > 0) {
      const errorMsg = `Saga failed and compensation partially failed: ${compensationErrors.join("; ")}`;
      await updateSagaRunStatus(sagaRunId, "compensation_failed", errorMsg);

      throw new ExecutionError(errorMsg, {
        sagaRunId,
        originalError: err.message,
        compensationErrors,
      });
    }

    await updateSagaRunStatus(sagaRunId, "failed", err.message);

    throw new ExecutionError("Saga failed, compensation completed", {
      sagaRunId,
      originalError: err.message,
    });
  }
}

export default executeSaga;
