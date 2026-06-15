/**
 * Hatchet Executor Adapter
 *
 * Implements the WorkflowExecutor interface using Hatchet as the backend.
 * Hatchet provides distributed, durable workflow execution with retries,
 * scheduling, and observability.
 */

import { getHatchet } from "lib/hatchet";

import type { WorkflowDefinition } from "../../dsl/types";
import type { WorkflowExecutor } from "../interface";
import type {
  ExecuteOptions,
  ExecutionEvent,
  ExecutionResult,
  RunStatus,
  StepResult,
} from "../types";

/** Event emitter for streaming (temporary until proper pub/sub) */
const eventEmitters = new Map<string, ((event: ExecutionEvent) => void)[]>();

/**
 * Map Hatchet task status to Vortex run status
 */
function mapHatchetStatus(status: string): RunStatus {
  switch (status?.toUpperCase()) {
    case "PENDING":
    case "PENDING_ASSIGNMENT":
    case "ASSIGNED":
    case "SCHEDULED":
      return "pending";
    case "RUNNING":
      return "running";
    case "COMPLETED":
    case "SUCCEEDED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "CANCELLING":
      return "cancelled";
    default:
      return "pending";
  }
}

export class HatchetExecutor implements WorkflowExecutor {
  readonly name = "hatchet";

  constructor(_options?: Record<string, unknown>) {}

  async execute(
    definition: WorkflowDefinition,
    triggerData?: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<{ runId: string }> {
    const workflowId = options?.idempotencyKey || `wf-${Date.now()}`;
    const runId = `run-${crypto.randomUUID()}`;

    // Emit run start event
    this.emitEvent(runId, {
      type: "run:start",
      runId,
      timestamp: new Date(),
    });

    // Push event to Hatchet to trigger workflow execution
    await getHatchet().event.push("workflow:execute", {
      workflowId,
      runId,
      triggerData: triggerData || {},
      definition,
    });

    return { runId };
  }

  async getStatus(runId: string): Promise<ExecutionResult> {
    try {
      // Use Hatchet v1 API to get run details
      const runDetails = await getHatchet().runs.get(runId);
      const run = runDetails.run;

      const status = mapHatchetStatus(run.status || "PENDING");
      const startedAt = run.startedAt ? new Date(run.startedAt) : new Date();
      const completedAt = run.finishedAt ? new Date(run.finishedAt) : undefined;

      // Map step results from Hatchet response
      const steps: StepResult[] = [];
      if (runDetails.tasks) {
        for (const task of runDetails.tasks) {
          steps.push({
            stepId: task.stepId || task.metadata.id,
            stepName: task.displayName || task.metadata.id,
            status: mapHatchetStatus(task.status || "PENDING") as
              | "pending"
              | "running"
              | "completed"
              | "failed"
              | "skipped",
            startedAt: task.startedAt ? new Date(task.startedAt) : undefined,
            completedAt: task.finishedAt
              ? new Date(task.finishedAt)
              : undefined,
            output: task.output as Record<string, unknown> | undefined,
            error: task.errorMessage,
          });
        }
      }

      return {
        runId,
        workflowId: run.workflowId || runId,
        status,
        startedAt,
        completedAt,
        durationMs: completedAt
          ? completedAt.getTime() - startedAt.getTime()
          : undefined,
        steps,
        output: run.output as Record<string, unknown> | undefined,
        error: run.errorMessage
          ? {
              code: "EXECUTION_ERROR",
              message: run.errorMessage,
            }
          : undefined,
      };
    } catch (err) {
      // If run not found or API error, throw appropriate error
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(`Failed to get workflow run status: ${message}`);
    }
  }

  async cancel(runId: string): Promise<void> {
    try {
      // Use Hatchet v1 API to cancel the run
      await getHatchet().runs.cancel({ ids: [runId] });

      // Emit cancel event
      this.emitEvent(runId, {
        type: "run:cancel",
        runId,
        timestamp: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(`Failed to cancel workflow run: ${message}`);
    }
  }

  async *stream(runId: string): AsyncIterable<ExecutionEvent> {
    const eventQueue: ExecutionEvent[] = [];
    let resolver: (() => void) | null = null;

    const wake = () => {
      if (resolver) {
        resolver();
        resolver = null;
      }
    };

    const listener = (event: ExecutionEvent) => {
      eventQueue.push(event);
      wake();
    };

    // Register listener for immediate events (execute/cancel)
    const listeners = eventEmitters.get(runId) || [];
    listeners.push(listener);
    eventEmitters.set(runId, listeners);

    // Track previous step states for diffing
    const prevStepStates = new Map<string, string>();
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    // Poll Hatchet API for step-level progress
    const poll = async () => {
      try {
        const result = await this.getStatus(runId);

        for (const step of result.steps) {
          const prev = prevStepStates.get(step.stepId);
          if (prev === step.status) continue;
          prevStepStates.set(step.stepId, step.status);

          if (step.status === "running" && prev !== "running") {
            eventQueue.push({
              type: "step:start",
              runId,
              stepId: step.stepId,
              timestamp: step.startedAt ?? new Date(),
            });
          } else if (step.status === "completed") {
            eventQueue.push({
              type: "step:complete",
              runId,
              stepId: step.stepId,
              timestamp: step.completedAt ?? new Date(),
              data: step.output as Record<string, unknown> | undefined,
            });
          } else if (step.status === "failed") {
            eventQueue.push({
              type: "step:fail",
              runId,
              stepId: step.stepId,
              timestamp: step.completedAt ?? new Date(),
              data: step.error ? { error: step.error } : undefined,
            });
          } else if (step.status === "skipped") {
            eventQueue.push({
              type: "step:skip",
              runId,
              stepId: step.stepId,
              timestamp: new Date(),
            });
          }
        }

        // Terminal run states
        if (result.status === "completed") {
          eventQueue.push({
            type: "run:complete",
            runId,
            timestamp: result.completedAt ?? new Date(),
            data: result.output,
          });
        } else if (result.status === "failed") {
          eventQueue.push({
            type: "run:fail",
            runId,
            timestamp: result.completedAt ?? new Date(),
            data: result.error,
          });
        }

        wake();
      } catch {
        // Ignore transient polling errors
      }
    };

    pollInterval = setInterval(poll, 2000);

    try {
      while (true) {
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;

          if (
            event.type === "run:complete" ||
            event.type === "run:fail" ||
            event.type === "run:cancel"
          ) {
            return;
          }
        }

        // Wait for next event (from listener or poll)
        await Promise.race([
          new Promise<void>((resolve) => {
            resolver = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);
      }
    } finally {
      if (pollInterval) clearInterval(pollInterval);

      const currentListeners = eventEmitters.get(runId) || [];
      const index = currentListeners.indexOf(listener);
      if (index > -1) {
        currentListeners.splice(index, 1);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Verify we can connect to Hatchet by listing workflows
      // This is a lightweight API call that confirms connectivity
      const workflows = await getHatchet().workflows.list({ limit: 1 });
      return workflows !== null;
    } catch {
      return false;
    }
  }

  /** Emit an event to all listeners for a run */
  private emitEvent(runId: string, event: ExecutionEvent): void {
    const listeners = eventEmitters.get(runId) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  /**
   * Emit an event for a run.
   * Called by the Hatchet workflow handler to report step progress.
   */
  static emitRunEvent(runId: string, event: ExecutionEvent): void {
    const listeners = eventEmitters.get(runId) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}
