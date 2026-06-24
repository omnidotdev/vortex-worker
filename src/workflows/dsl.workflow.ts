import { CreateTaskWorkflow } from "@hatchet-dev/typescript-sdk/v1";
import { checkUsage, recordUsage } from "billing";
import { eq } from "drizzle-orm";

import logger from "lib/logger";
import { getDb } from "../db";
import {
  createWorkflowRun,
  logStepComplete,
  logStepFailed,
  logStepStart,
  markRunComplete,
  markRunFailed,
} from "../db/runLogger";
import { workflowRunTable, workflowTable } from "../db/schema";
import {
  createExecutionContext,
  executeStep,
  findRootSteps,
  findTriggerStep,
} from "../dsl/executor";
import { isReactFlowFormat, reactFlowToDsl } from "../dsl/reactFlowToDsl";
import { publish } from "../events/publisher";

import type { WorkflowDefinition } from "../dsl/types";

/**
 * Invert a stepNameToId map to get stepIdToName.
 */
function invertStepNameMap(
  stepNameToId: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, id] of Object.entries(stepNameToId)) {
    result[id] = name;
  }
  return result;
}

export interface DSLWorkflowInput {
  workflowId: string;
  runId: string;
  organizationId?: string;
  triggerData: Record<string, unknown>;
  definition: WorkflowDefinition | Record<string, unknown>;
}

export const dslWorkflow = CreateTaskWorkflow({
  name: "dsl-workflow",
  description: "Universal DSL interpreter workflow",
  on: {
    event: "workflow:execute",
  },
  executionTimeout: "1800s",
  fn: async (rawInput, ctx) => {
    const input = rawInput as DSLWorkflowInput;
    const { workflowId, organizationId, triggerData } = input;
    let { definition } = input;
    const runId = input.runId || ctx.workflowRunId();

    // Verify organization ownership before executing
    // workflowId may be a composite engineWorkflowId (event-<uuid>-<ts>)
    // so resolve the actual workflow UUID from the run table first
    if (organizationId && runId) {
      const db = getDb();
      const [run] = await db
        .select({ workflowId: workflowRunTable.workflowId })
        .from(workflowRunTable)
        .where(eq(workflowRunTable.id, runId))
        .limit(1);

      const resolvedWorkflowId = run?.workflowId;

      if (resolvedWorkflowId) {
        const [workflow] = await db
          .select({ organizationId: workflowTable.organizationId })
          .from(workflowTable)
          .where(eq(workflowTable.id, resolvedWorkflowId))
          .limit(1);

        if (workflow && workflow.organizationId !== organizationId) {
          throw new Error(
            "Workflow does not belong to the specified organization",
          );
        }
      }
    }

    // Extract correlation ID from trigger data
    const _requestId = triggerData._requestId as string | undefined;

    // Create child logger with run context for correlated logging
    const runLogger = logger.child({
      ...(_requestId && { requestId: _requestId }),
      workflowId,
      runId,
    });

    // Extract step name mapping from ReactFlow nodes before conversion
    let stepNameToId: Record<string, string> = {};

    // Auto-detect and convert ReactFlow format to DSL format
    // This enables workflows created in the UI to be executed via API/webhook
    if (isReactFlowFormat(definition)) {
      ctx.log("Converting ReactFlow format to DSL format");
      const rfDef = definition as {
        nodes: Array<{
          id: string;
          type?: string;
          data?: {
            stepName?: string;
            label?: string;
            integrationDefinitionId?: string;
            pluginId?: string;
          };
        }>;
        edges: unknown[];
      };

      // Build step name to node ID mapping
      // Generate step names for nodes that don't have them (backwards compatibility)
      const usedNames = new Set<string>();

      ctx.log(`Number of nodes: ${rfDef.nodes.length}`);
      for (const node of rfDef.nodes) {
        ctx.log(
          `Node: id=${node.id}, type=${node.type}, label=${node.data?.label}, stepName=${node.data?.stepName}`,
        );
        // Skip trigger nodes
        if (node.type === "triggerNode") {
          ctx.log(`  -> Skipping trigger node`);
          continue;
        }

        let stepName = node.data?.stepName;

        // Generate step name if missing
        if (!stepName) {
          // Use label, integration name, or fallback
          const baseName =
            node.data?.label ||
            (node.data?.integrationDefinitionId
              ? node.data.integrationDefinitionId.charAt(0).toUpperCase() +
                node.data.integrationDefinitionId.slice(1)
              : null) ||
            (node.data?.pluginId === "builtin:http" ? "HTTP Request" : null) ||
            "Step";

          // Ensure uniqueness
          stepName = baseName;
          let counter = 2;
          while (usedNames.has(stepName)) {
            stepName = `${baseName} ${counter}`;
            counter++;
          }
        }

        usedNames.add(stepName);
        stepNameToId[stepName] = node.id;
        ctx.log(`Step mapping: "${stepName}" -> ${node.id}`);
      }

      definition = reactFlowToDsl(
        rfDef.nodes as Parameters<typeof reactFlowToDsl>[0],
        rfDef.edges as Parameters<typeof reactFlowToDsl>[1],
      );
      ctx.log(
        `Converted definition steps: ${JSON.stringify((definition as WorkflowDefinition).steps.map((s) => ({ id: s.id, type: s.type })))}`,
      );
    }

    const dslDef = definition as WorkflowDefinition;

    // If definition already has stepNameToId (from prior conversion), use it
    if (dslDef.stepNameToId && Object.keys(dslDef.stepNameToId).length > 0) {
      stepNameToId = dslDef.stepNameToId;
    }

    // Create execution context with step name mapping
    const execCtx = createExecutionContext(
      workflowId,
      runId,
      triggerData,
      organizationId,
      stepNameToId,
    );

    // Create inverted map for looking up step names by ID
    const stepIdToName = invertStepNameMap(stepNameToId);

    // Pre-execution billing check (defense-in-depth, API also checks)
    if (organizationId) {
      const usageCheck = await checkUsage(
        "organization",
        organizationId,
        "workflow_executions",
        1,
      );

      if (usageCheck && !usageCheck.allowed) {
        void recordUsage(
          "organization",
          organizationId,
          "rejected_executions",
          1,
        );
        throw new Error(
          `Plan limit reached: workflow executions (${usageCheck.currentUsage}/${usageCheck.limit}). Upgrade your plan to continue.`,
        );
      }
    }

    runLogger.info("Starting workflow execution");

    // Use the API-created run record if available, otherwise create one
    let dbRunId: string;
    if (input.runId) {
      // API already created the run, update it to "running"
      const db = getDb();
      await db
        .update(workflowRunTable)
        .set({ status: "running" as const, startedAt: new Date() })
        .where(eq(workflowRunTable.id, input.runId));
      dbRunId = input.runId;
    } else {
      dbRunId = await createWorkflowRun({
        workflowId,
        engineWorkflowId: "dsl-workflow",
        engineRunId: runId,
        input: { ...triggerData, _requestId },
      });
    }

    // Find trigger step or root steps for manual workflows
    const triggerStep = findTriggerStep(dslDef.steps);
    const initialSteps = triggerStep ? [triggerStep] : findRootSteps(dslDef);

    if (initialSteps.length === 0) {
      await markRunFailed(
        dbRunId,
        new Error("Workflow has no trigger step or root steps"),
        organizationId,
      );
      throw new Error("Workflow has no trigger step or root steps");
    }

    // Execute workflow starting from initial steps (BFS)
    const queue: typeof dslDef.steps = [...initialSteps];
    const visited = new Set<string>();

    try {
      while (queue.length > 0) {
        const step = queue.shift()!;

        if (visited.has(step.id)) {
          continue;
        }
        visited.add(step.id);

        // Get step name for logging (fallback to step type if not found)
        const stepName = stepIdToName[step.id] || step.type;

        ctx.log(`Executing step: ${step.id} (${step.type})`);
        runLogger.debug("Executing step", {
          stepId: step.id,
          stepType: step.type,
        });

        // Log step start (best-effort, DB failure should not abort workflow)
        try {
          await logStepStart(dbRunId, {
            stepId: step.id,
            stepName,
            stepType: step.type,
            input: { type: step.type, name: step.name },
          });
        } catch (e) {
          runLogger.warn("Failed to log step start", { error: e });
        }

        try {
          const { nextSteps, result } = await executeStep(
            dslDef,
            step,
            execCtx,
          );

          // Log step completion (best-effort, DB failure should not abort workflow)
          try {
            await logStepComplete(dbRunId, step.id, result, organizationId);
          } catch (e) {
            runLogger.warn("Failed to log step complete", { error: e });
          }

          ctx.log(
            `Step ${step.id} completed with result: ${JSON.stringify(result)}`,
          );
          runLogger.debug("Step completed", { stepId: step.id });

          queue.push(...nextSteps);
        } catch (stepError) {
          // Log step failure (best-effort, DB failure should not mask the real error)
          try {
            await logStepFailed(dbRunId, step.id, stepError, organizationId);
          } catch (e) {
            runLogger.warn("Failed to log step failure", { error: e });
          }
          runLogger.error("Step failed", {
            stepId: step.id,
            error:
              stepError instanceof Error
                ? stepError.message
                : String(stepError),
          });
          throw stepError;
        }
      }

      // Mark run as complete
      await markRunComplete(dbRunId, execCtx.stepResults, organizationId);
      runLogger.info("Workflow execution completed", {
        completedSteps: Object.keys(execCtx.stepResults).length,
      });

      // Publish vortex.workflow.completed event (best-effort)
      if (organizationId) {
        publish({
          type: "vortex.workflow.completed",
          source: "vortex-worker",
          subject: runId,
          organizationId,
          data: {
            workflowId,
            runId,
            dbRunId,
            completedSteps: Object.keys(execCtx.stepResults).length,
          },
        }).catch((err) => {
          runLogger.warn("Failed to publish workflow.completed event", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return {
        workflowId,
        runId,
        dbRunId,
        completedSteps: Object.keys(execCtx.stepResults).length,
      };
    } catch (error) {
      // Mark run as failed
      await markRunFailed(dbRunId, error, organizationId);
      runLogger.error("Workflow execution failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Publish vortex.workflow.failed event (best-effort)
      if (organizationId) {
        publish({
          type: "vortex.workflow.failed",
          source: "vortex-worker",
          subject: runId,
          organizationId,
          data: {
            workflowId,
            runId,
            dbRunId,
            error: error instanceof Error ? error.message : String(error),
          },
        }).catch((err) => {
          runLogger.warn("Failed to publish workflow.failed event", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      throw error;
    }
  },
});
