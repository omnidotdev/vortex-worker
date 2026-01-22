import {
  createExecutionContext,
  executeStep,
  findTriggerStep,
} from "../dsl/executor";
import { isReactFlowFormat, reactFlowToDsl } from "../dsl/reactFlowToDsl";

import type { Workflow } from "@hatchet-dev/typescript-sdk";
import type { WorkflowDefinition } from "../dsl/types";

interface DSLWorkflowInput {
  workflowId: string;
  organizationId?: string;
  triggerData: Record<string, unknown>;
  definition: WorkflowDefinition | Record<string, unknown>;
}

export const dslWorkflow: Workflow = {
  id: "dsl-workflow",
  description: "Universal DSL interpreter workflow",
  on: {
    event: "workflow:execute",
  },
  steps: [
    {
      name: "execute-dsl",
      run: async (ctx) => {
        const input = ctx.workflowInput() as DSLWorkflowInput;
        const { workflowId, organizationId, triggerData } = input;
        let { definition } = input;
        const runId = ctx.workflowRunId();

        // Debug log the incoming definition
        ctx.log(`Definition has nodes: ${Array.isArray((definition as Record<string, unknown>).nodes)}`);
        ctx.log(`Definition has steps: ${Array.isArray((definition as Record<string, unknown>).steps)}`);
        ctx.log(`isReactFlowFormat: ${isReactFlowFormat(definition)}`);

        // Auto-detect and convert ReactFlow format to DSL format
        // This enables workflows created in the UI to be executed via API/webhook
        if (isReactFlowFormat(definition)) {
          ctx.log("Converting ReactFlow format to DSL format");
          const rfDef = definition as { nodes: unknown[]; edges: unknown[] };
          definition = reactFlowToDsl(
            rfDef.nodes as Parameters<typeof reactFlowToDsl>[0],
            rfDef.edges as Parameters<typeof reactFlowToDsl>[1],
          );
          ctx.log(`Converted definition steps: ${JSON.stringify((definition as WorkflowDefinition).steps.map(s => ({ id: s.id, type: s.type })))}`);
        }

        const dslDef = definition as WorkflowDefinition;

        // Create execution context
        const execCtx = createExecutionContext(workflowId, runId, triggerData, organizationId);

        // Find trigger step
        const triggerStep = findTriggerStep(dslDef.steps);
        if (!triggerStep) {
          throw new Error("Workflow has no trigger step");
        }

        // Execute workflow starting from trigger (BFS)
        const queue: typeof dslDef.steps = [triggerStep];
        const visited = new Set<string>();

        while (queue.length > 0) {
          const step = queue.shift()!;

          if (visited.has(step.id)) {
            continue;
          }
          visited.add(step.id);

          ctx.log(`Executing step: ${step.id} (${step.type})`);

          const { nextSteps, result } = await executeStep(
            dslDef,
            step,
            execCtx,
          );

          ctx.log(
            `Step ${step.id} completed with result: ${JSON.stringify(result)}`,
          );

          queue.push(...nextSteps);
        }

        return {
          workflowId,
          runId,
          completedSteps: Object.keys(execCtx.stepResults).length,
        };
      },
    },
  ],
};
