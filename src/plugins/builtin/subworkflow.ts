/**
 * Built-in Subworkflow Plugin
 *
 * Execute another workflow as a step.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { createWorkflowRun } from "../../db/runLogger";
import { workflowRunTable, workflowTable } from "../../db/schema";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Execute a subworkflow.
 */
const executeSubworkflow = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      workflowId,
      inputs: subInputs,
      waitForCompletion = true,
      timeout,
    } = inputs as {
      workflowId: string;
      inputs: Record<string, unknown>;
      waitForCompletion?: boolean;
      timeout?: number;
    };

    if (!workflowId) {
      return {
        success: false,
        error: "workflowId is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Look up the target workflow by ID
    const db = getDb();
    const [targetWorkflow] = await db
      .select()
      .from(workflowTable)
      .where(eq(workflowTable.id, workflowId))
      .limit(1);

    if (!targetWorkflow) {
      return {
        success: false,
        error: `Subworkflow not found: ${workflowId}`,
        durationMs: performance.now() - startTime,
      };
    }

    if (!targetWorkflow.isActive) {
      return {
        success: false,
        error: `Subworkflow is disabled: ${workflowId}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Generate a unique run ID for the child workflow
    const childRunId = `run-${crypto.randomUUID()}`;

    // Create a workflow run record for tracking
    const dbRunId = await createWorkflowRun({
      workflowId,
      engineWorkflowId: "dsl-workflow",
      engineRunId: childRunId,
      input: subInputs,
    });

    // Initialize Hatchet client and trigger the child workflow
    const hatchet = Hatchet.init();
    await hatchet.event.push("workflow:execute", {
      workflowId,
      runId: childRunId,
      organizationId: targetWorkflow.organizationId,
      triggerData: subInputs || {},
      definition: targetWorkflow.definition,
      parentRunId: context?.runId,
    });

    // If fire-and-forget mode, return immediately
    if (!waitForCompletion) {
      return {
        success: true,
        output: {
          workflowId,
          runId: childRunId,
          dbRunId,
          triggered: true,
          waitForCompletion: false,
          status: "triggered",
        },
        durationMs: performance.now() - startTime,
      };
    }

    // Wait for child workflow to complete by polling the run status
    const pollStartTime = Date.now();
    const timeoutMs = timeout || 5 * 60 * 1000; // Default 5 minutes
    const pollIntervalMs = 1000; // Poll every second

    while (Date.now() - pollStartTime < timeoutMs) {
      const [runStatus] = await db
        .select()
        .from(workflowRunTable)
        .where(eq(workflowRunTable.id, dbRunId))
        .limit(1);

      if (!runStatus) {
        return {
          success: false,
          error: `Workflow run record not found: ${dbRunId}`,
          durationMs: performance.now() - startTime,
        };
      }

      if (runStatus.status === "completed") {
        return {
          success: true,
          output: {
            workflowId,
            runId: childRunId,
            dbRunId,
            status: "completed",
            output: runStatus.output,
          },
          durationMs: performance.now() - startTime,
        };
      }

      if (runStatus.status === "failed") {
        return {
          success: false,
          error: `Subworkflow failed: ${runStatus.error || "Unknown error"}`,
          durationMs: performance.now() - startTime,
        };
      }

      if (runStatus.status === "cancelled") {
        return {
          success: false,
          error: "Subworkflow was cancelled",
          durationMs: performance.now() - startTime,
        };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout reached
    return {
      success: false,
      error: `Subworkflow timed out after ${timeoutMs}ms`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const subworkflowPlugin: BuiltinPlugin = {
  id: "builtin:subworkflow",
  name: "Subworkflow",
  description: "Execute another workflow",
  actions: {
    execute: {
      name: "execute",
      description: "Execute a subworkflow",
      handler: executeSubworkflow,
    },
  },
};
