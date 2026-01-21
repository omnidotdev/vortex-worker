/**
 * Temporal Workflow for DSL Execution
 *
 * This workflow interprets and executes Vortex DSL definitions using Temporal's
 * durable execution model. It provides:
 * - Automatic retries with configurable policies
 * - Long-running workflow support (days, weeks, months)
 * - Signal-based gates for human-in-the-loop workflows
 * - Full execution history and replay capability
 */

import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

import type { DelayStep, GateStep, WorkflowDefinition } from "../../dsl/types";
import type * as activities from "./activities";

// Proxy activities with retry policies
const { initializeWorkflow, executeWorkflowStep, getStepById } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "30m",
    retry: {
      maximumAttempts: 3,
      initialInterval: "1s",
      backoffCoefficient: 2,
      maximumInterval: "1m",
    },
  });

/**
 * Input for the DSL workflow
 */
export interface DSLWorkflowInput {
  workflowId?: string;
  vortexRunId?: string;
  triggerData: Record<string, unknown>;
  definition: WorkflowDefinition | Record<string, unknown>;
}

/**
 * Output from the DSL workflow
 */
export interface DSLWorkflowOutput {
  workflowId: string;
  runId: string;
  completedSteps: number;
  results: Record<string, unknown>;
}

/**
 * Signal payload for gate steps
 */
export interface GateSignalPayload {
  approved: boolean;
  approver?: string;
  payload?: unknown;
}

// Define signals for gate handling
export const approvalSignal =
  defineSignal<[string, GateSignalPayload]>("approval");
export const customSignal = defineSignal<[string, unknown]>("signal");

/**
 * Main DSL Workflow
 *
 * Executes a Vortex DSL workflow definition using BFS traversal,
 * handling all step types including delays and gates natively with Temporal.
 */
export async function dslWorkflow(
  input: DSLWorkflowInput,
): Promise<DSLWorkflowOutput> {
  const { triggerData, definition: rawDefinition, vortexRunId } = input;
  const temporalWorkflowId = workflowInfo().workflowId;
  const workflowId = input.workflowId || temporalWorkflowId;
  const runId = vortexRunId || temporalWorkflowId;

  // Track gate approvals received via signals
  const gateApprovals: Map<string, GateSignalPayload> = new Map();
  const customSignals: Map<string, unknown> = new Map();

  // Set up signal handlers
  setHandler(approvalSignal, (gateId: string, payload: GateSignalPayload) => {
    gateApprovals.set(gateId, payload);
  });

  setHandler(customSignal, (signalName: string, payload: unknown) => {
    customSignals.set(signalName, payload);
  });

  // Initialize workflow - normalize definition and create context
  const { definition, context, triggerStepId } = await initializeWorkflow({
    workflowId,
    runId,
    triggerData,
    definition: rawDefinition,
  });

  // BFS execution queue
  const queue: string[] = [triggerStepId];
  const visited = new Set<string>();
  let currentContext = context;

  while (queue.length > 0) {
    const stepId = queue.shift()!;

    if (visited.has(stepId)) {
      continue;
    }
    visited.add(stepId);

    const step = await getStepById(definition, stepId);
    if (!step) {
      continue;
    }

    // Handle special step types natively in Temporal
    if (step.type === "delay") {
      await handleDelay(step as DelayStep);
      // Get next steps after delay
      const nextStepIds = getNextStepIds(definition, stepId);
      queue.push(...nextStepIds);
      continue;
    }

    if (step.type === "gate") {
      const gateStep = step as GateStep;
      const passed = await handleGate(gateStep, gateApprovals, customSignals);

      currentContext.stepResults[stepId] = {
        passed,
        gateType: gateStep.gate.type,
      };

      if (passed) {
        const nextStepIds = getNextStepIds(definition, stepId);
        queue.push(...nextStepIds);
      }
      continue;
    }

    // Execute step via activity
    const result = await executeWorkflowStep({
      definition,
      step,
      context: currentContext,
    });

    // Update context with results
    currentContext = result.updatedContext;

    // Queue next steps
    queue.push(...result.nextStepIds);
  }

  return {
    workflowId,
    runId,
    completedSteps: visited.size,
    results: currentContext.stepResults,
  };
}

/**
 * Handle delay steps using Temporal's native sleep
 *
 * Temporal sleeps are durable - if the worker restarts, the workflow
 * will resume from where it left off with the remaining delay.
 */
async function handleDelay(step: DelayStep): Promise<void> {
  const { duration, unit } = step.delay;
  const ms = convertToMs(duration, unit);

  // Temporal sleep - durable across restarts
  await sleep(ms);
}

/**
 * Handle gate steps using Temporal's signals and conditions
 *
 * Gates wait for external signals (approvals or custom signals)
 * with optional timeout handling.
 */
async function handleGate(
  step: GateStep,
  approvals: Map<string, GateSignalPayload>,
  signals: Map<string, unknown>,
): Promise<boolean> {
  const { gate } = step;
  const timeoutMs = gate.timeout ? parseDuration(gate.timeout) : undefined;

  if (gate.type === "approval") {
    // Wait for approval signal
    const approved = await condition(() => approvals.has(step.id), timeoutMs);

    if (!approved) {
      // Timeout occurred
      return gate.timeoutAction === "approve";
    }

    const approval = approvals.get(step.id);
    return approval?.approved ?? false;
  }

  if (gate.type === "signal") {
    const signalName = gate.signalName || step.id;

    // Wait for custom signal
    const received = await condition(() => signals.has(signalName), timeoutMs);

    if (!received) {
      // Timeout - check timeout action
      return (
        gate.timeoutAction === "continue" || gate.timeoutAction === "approve"
      );
    }

    return true;
  }

  // Unknown gate type - pass through
  return true;
}

/**
 * Get next step IDs from workflow definition
 */
function getNextStepIds(
  definition: WorkflowDefinition,
  currentStepId: string,
  sourceHandle?: string,
): string[] {
  const outgoingEdges = definition.edges.filter((e) => {
    if (e.source !== currentStepId) return false;
    if (sourceHandle && e.sourceHandle !== sourceHandle) return false;
    return true;
  });

  return outgoingEdges.map((e) => e.target);
}

/**
 * Convert duration to milliseconds
 */
function convertToMs(duration: number, unit: string): number {
  const multipliers: Record<string, number> = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };

  return duration * (multipliers[unit] ?? 1000);
}

/**
 * Parse duration string (e.g., "30m", "1h", "7d") to milliseconds
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    // Try parsing as number (assume milliseconds)
    const ms = parseInt(duration, 10);
    return Number.isNaN(ms) ? 30000 : ms;
  }

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return num * (multipliers[unit] ?? 1000);
}
