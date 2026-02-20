/**
 * Temporal activities for DSL workflow execution.
 *
 * Each activity is a single durable execution unit. Temporal retries failed
 * activities automatically according to the retry policy set in the workflow.
 */

import logger from "lib/logger";
import {
  createExecutionContext,
  executeStep,
  findNextSteps,
  findTriggerStep,
} from "../dsl/executor";
import { WorkflowDefinition } from "../dsl/types";

import type { DSLWorkflowInput } from "./dsl.workflow";

/**
 * Execute a complete DSL workflow as a single Temporal activity.
 *
 * Wraps the DSL executor so Temporal provides durable dispatch with
 * replay-on-failure guarantees at the workflow boundary.
 */
export async function executeDslWorkflow(
  input: DSLWorkflowInput,
): Promise<{ status: "completed" | "failed"; error?: string }> {
  const { workflowId, runId, organizationId, triggerData, definition } = input;

  logger.info("Temporal activity: executing DSL workflow", {
    workflowId,
    runId,
  });

  try {
    const parsedDef = WorkflowDefinition.safeParse(definition);
    if (!parsedDef.success) {
      throw new Error(
        `Invalid workflow definition: ${parsedDef.error.message}`,
      );
    }

    const context = createExecutionContext(
      workflowId,
      runId,
      triggerData,
      organizationId,
      parsedDef.data.stepNameToId ?? {},
    );

    const triggerStep = findTriggerStep(parsedDef.data.steps);
    if (!triggerStep) {
      throw new Error("No trigger step found in workflow definition");
    }

    // BFS execution — same as dsl.workflow.ts
    const queue = findNextSteps(parsedDef.data, triggerStep.id);
    while (queue.length > 0) {
      const step = queue.shift()!;

      const { nextSteps } = await executeStep(parsedDef.data, step, context);
      queue.push(...nextSteps);
    }

    return { status: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Temporal activity: DSL workflow failed", {
      workflowId,
      runId,
      error: message,
    });
    return { status: "failed", error: message };
  }
}
