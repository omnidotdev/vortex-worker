/**
 * Hatchet Executor Adapter
 *
 * Implements the WorkflowExecutor interface using Hatchet as the backend.
 * Hatchet provides distributed, durable workflow execution with retries,
 * scheduling, and observability.
 */

import Hatchet, { HatchetClient } from "@hatchet-dev/typescript-sdk";

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
  private hatchet: ReturnType<typeof Hatchet.init>;
  private v1Client: HatchetClient;

  constructor(_options?: Record<string, unknown>) {
    this.hatchet = Hatchet.init();
    this.v1Client = HatchetClient.init();
  }

  async execute(
    definition: WorkflowDefinition,
    triggerData?: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<{ runId: string }> {
    const workflowId = options?.idempotencyKey || `wf-${Date.now()}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Emit run start event
    this.emitEvent(runId, {
      type: "run:start",
      runId,
      timestamp: new Date(),
    });

    // Push event to Hatchet to trigger workflow execution
    await this.hatchet.event.push("workflow:execute", {
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
      const runDetails = await this.v1Client.runs.get(runId);

      const status = mapHatchetStatus(runDetails.status || "PENDING");
      const startedAt = runDetails.startedAt
        ? new Date(runDetails.startedAt)
        : new Date();
      const completedAt = runDetails.finishedAt
        ? new Date(runDetails.finishedAt)
        : undefined;

      // Map step results from Hatchet response
      const steps: StepResult[] = [];
      if (runDetails.tasks) {
        for (const task of runDetails.tasks) {
          steps.push({
            stepId: task.taskExternalId || task.taskId || "",
            stepName: task.displayName || task.taskId,
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
            output: task.output,
            error: task.errorMessage,
          });
        }
      }

      return {
        runId,
        workflowId: runDetails.workflowName || runId,
        status,
        startedAt,
        completedAt,
        durationMs: completedAt
          ? completedAt.getTime() - startedAt.getTime()
          : undefined,
        steps,
        output: runDetails.output as Record<string, unknown> | undefined,
        error: runDetails.errorMessage
          ? {
              code: "EXECUTION_ERROR",
              message: runDetails.errorMessage,
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
      await this.v1Client.runs.cancel({ ids: [runId] });

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
    // Create event queue for this stream
    const eventQueue: ExecutionEvent[] = [];
    let resolver: (() => void) | null = null;

    const listener = (event: ExecutionEvent) => {
      eventQueue.push(event);
      if (resolver) {
        resolver();
        resolver = null;
      }
    };

    // Register listener
    const listeners = eventEmitters.get(runId) || [];
    listeners.push(listener);
    eventEmitters.set(runId, listeners);

    try {
      while (true) {
        // Yield any queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;

          // Stop streaming on terminal events
          if (
            event.type === "run:complete" ||
            event.type === "run:fail" ||
            event.type === "run:cancel"
          ) {
            return;
          }
        }

        // Wait for next event
        await new Promise<void>((resolve) => {
          resolver = resolve;
        });
      }
    } finally {
      // Cleanup listener
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
      const workflows = await this.v1Client.workflows.list({ limit: 1 });
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
