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
                (node.data?.pluginId === "builtin:http"
                  ? "HTTP Request"
                  : null) ||
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
        if (
          dslDef.stepNameToId &&
          Object.keys(dslDef.stepNameToId).length > 0
        ) {
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
