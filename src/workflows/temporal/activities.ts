/**
 * Temporal Activities for DSL Workflow Execution
 *
 * Activities are the building blocks that execute individual steps.
 * They wrap the existing DSL executor logic to run within Temporal's activity context.
 */

import {
  createExecutionContext,
  executeStep,
  findRootSteps,
  findTriggerStep,
} from "../../dsl/executor";
import { isReactFlowFormat, reactFlowToDsl } from "../../dsl/reactFlowToDsl";

import type {
  ExecutionContext,
  Step,
  WorkflowDefinition,
} from "../../dsl/types";

/**
 * Input for initializing workflow execution
 */
export interface InitializeInput {
  workflowId?: string;
  runId: string;
  triggerData: Record<string, unknown>;
  definition: WorkflowDefinition | Record<string, unknown>;
}

/**
 * Result of initialization
 */
export interface InitializeResult {
  definition: WorkflowDefinition;
  context: ExecutionContext;
  triggerStepId: string;
  /** Initial step IDs when no trigger step exists (manual workflows) */
  initialStepIds?: string[];
}

/**
 * Input for executing a single step
 */
export interface ExecuteStepInput {
  definition: WorkflowDefinition;
  step: Step;
  context: ExecutionContext;
}

/**
 * Result of step execution
 */
export interface ExecuteStepResult {
  stepId: string;
  result: unknown;
  nextStepIds: string[];
  updatedContext: ExecutionContext;
}

/**
 * Initialize workflow execution context and normalize definition
 */
export async function initializeWorkflow(
  input: InitializeInput,
): Promise<InitializeResult> {
  const { runId, triggerData } = input;
  const workflowId = input.workflowId || runId;
  let { definition } = input;

  // Auto-detect and convert ReactFlow format to DSL format
  if (isReactFlowFormat(definition)) {
    const rfDef = definition as { nodes: unknown[]; edges: unknown[] };
    definition = reactFlowToDsl(
      rfDef.nodes as Parameters<typeof reactFlowToDsl>[0],
      rfDef.edges as Parameters<typeof reactFlowToDsl>[1],
    );
  }

  const dslDef = definition as WorkflowDefinition;

  // Find trigger step or root steps for manual workflows
  const triggerStep = findTriggerStep(dslDef.steps);
  const initialSteps = triggerStep
    ? [triggerStep]
    : findRootSteps(dslDef);

  if (initialSteps.length === 0) {
    throw new Error("Workflow has no trigger step or root steps");
  }

  // Create execution context
  const context = createExecutionContext(workflowId, runId, triggerData);

  return {
    definition: dslDef,
    context,
    triggerStepId: triggerStep?.id ?? initialSteps[0].id,
    ...(!triggerStep && {
      initialStepIds: initialSteps.map((s) => s.id),
    }),
  };
}

/**
 * Execute a single workflow step
 *
 * This activity wraps the existing DSL executor logic.
 * Each step type (action, condition, delay, etc.) is executed here.
 */
export async function executeWorkflowStep(
  input: ExecuteStepInput,
): Promise<ExecuteStepResult> {
  const { definition, step, context } = input;

  // Execute the step using existing DSL executor logic
  const { nextSteps, result } = await executeStep(definition, step, context);

  return {
    stepId: step.id,
    result,
    nextStepIds: nextSteps.map((s) => s.id),
    updatedContext: context,
  };
}

/**
 * Get step by ID from workflow definition
 */
export async function getStepById(
  definition: WorkflowDefinition,
  stepId: string,
): Promise<Step | null> {
  return definition.steps.find((s) => s.id === stepId) ?? null;
}

/**
 * Evaluate a condition expression and return the result
 */
export async function evaluateCondition(
  expression: string,
  context: ExecutionContext,
): Promise<boolean> {
  // Import the evaluateExpression function from executor
  // For now, use a simple implementation
  const trimmed = expression.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Handle template expressions
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    const path = trimmed.slice(2, -2).trim();
    const value = getValueByPath(context, path);
    return Boolean(value);
  }

  // Simple comparisons
  const comparisonMatch = trimmed.match(
    /(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)/,
  );
  if (comparisonMatch) {
    const [, left, op, right] = comparisonMatch;
    const leftVal = resolveExpressionValue(left.trim(), context);
    const rightVal = resolveExpressionValue(right.trim(), context);

    switch (op) {
      case "===":
      case "==":
        return leftVal === rightVal;
      case "!==":
      case "!=":
        return leftVal !== rightVal;
      case ">":
        return Number(leftVal) > Number(rightVal);
      case "<":
        return Number(leftVal) < Number(rightVal);
      case ">=":
        return Number(leftVal) >= Number(rightVal);
      case "<=":
        return Number(leftVal) <= Number(rightVal);
    }
  }

  return Boolean(trimmed);
}

/**
 * Signal handler for gate steps that wait for external signals
 */
export async function waitForSignal(
  _signalName: string,
  _timeoutMs?: number,
): Promise<{ received: boolean; payload?: unknown }> {
  // This is a placeholder - actual signal handling is done in the workflow
  // using Temporal's signal feature
  return { received: true };
}

// Helper functions

function getValueByPath(ctx: ExecutionContext, path: string): unknown {
  const parts = path.split(".");
  const root = parts[0];

  const accessibleContext: Record<string, unknown> = {
    trigger: ctx.triggerData,
    variables: ctx.variables,
    steps: {} as Record<string, unknown>,
    stepResults: ctx.stepResults,
  };

  for (const [stepId, result] of Object.entries(ctx.stepResults)) {
    const stepResult = result as Record<string, unknown>;
    (accessibleContext.steps as Record<string, unknown>)[stepId] =
      stepResult.output || stepResult;
  }

  let current: unknown = accessibleContext[root];
  if (current === undefined) {
    current = (ctx as unknown as Record<string, unknown>)[root];
  }

  for (let i = 1; i < parts.length; i++) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[parts[i]];
    } else {
      return undefined;
    }
  }

  return current;
}

function resolveExpressionValue(value: string, ctx: ExecutionContext): unknown {
  // Handle template expressions
  if (value.startsWith("{{") && value.endsWith("}}")) {
    const path = value.slice(2, -2).trim();
    return getValueByPath(ctx, path);
  }

  // Try to parse as JSON (numbers, booleans, strings)
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
