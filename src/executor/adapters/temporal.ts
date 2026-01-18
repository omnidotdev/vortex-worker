/**
 * Temporal Executor Adapter
 *
 * Implements the WorkflowExecutor interface using Temporal as the backend.
 * Temporal provides strongly-consistent, durable workflow execution with
 * native support for long-running workflows, saga patterns, and versioning.
 *
 * Key advantages over Hatchet:
 * - Native support for workflows lasting months/years
 * - Built-in saga/compensation patterns
 * - Stronger consistency guarantees
 * - Temporal Web UI for observability
 * - Mature ecosystem
 */

import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";

import type { WorkflowDefinition } from "../../dsl/types";
import { RunNotFoundError, type WorkflowExecutor } from "../interface";
import type {
  ExecuteOptions,
  ExecutionEvent,
  ExecutionResult,
  RunStatus,
  StepResult,
} from "../types";

/** Temporal connection configuration */
interface TemporalConfig {
  /** Temporal server address (default: localhost:7233) */
  address?: string;
  /** Temporal namespace (default: default) */
  namespace?: string;
  /** Task queue for DSL workflows */
  taskQueue?: string;
}

/** In-memory store for mapping vortex runId to Temporal workflowId */
const runMapping = new Map<
  string,
  { workflowId: string; workflowName: string }
>();

/** Event emitters for streaming (temporary until proper pub/sub) */
const eventEmitters = new Map<string, ((event: ExecutionEvent) => void)[]>();

export class TemporalExecutor implements WorkflowExecutor {
  readonly name = "temporal";
  private client: Client | null = null;
  private config: TemporalConfig;
  private connectionPromise: Promise<void> | null = null;

  constructor(options?: Record<string, unknown>) {
    this.config = {
      address:
        (options?.address as string) ||
        process.env.TEMPORAL_ADDRESS ||
        "localhost:7233",
      namespace:
        (options?.namespace as string) ||
        process.env.TEMPORAL_NAMESPACE ||
        "default",
      taskQueue:
        (options?.taskQueue as string) ||
        process.env.TEMPORAL_TASK_QUEUE ||
        "vortex-dsl",
    };
  }

  /** Lazily connect to Temporal server */
  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;

    if (!this.connectionPromise) {
      this.connectionPromise = this.connect();
    }

    await this.connectionPromise;
    return this.client!;
  }

  private async connect(): Promise<void> {
    const connection = await Connection.connect({
      address: this.config.address,
    });

    this.client = new Client({
      connection,
      namespace: this.config.namespace,
    });
  }

  async execute(
    definition: WorkflowDefinition,
    triggerData?: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<{ runId: string }> {
    const client = await this.ensureConnected();

    const vortexRunId = `vortex-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const temporalWorkflowId = options?.idempotencyKey || vortexRunId;

    // Store mapping
    runMapping.set(vortexRunId, {
      workflowId: temporalWorkflowId,
      workflowName: "dslWorkflow",
    });

    // Emit run start event
    this.emitEvent(vortexRunId, {
      type: "run:start",
      runId: vortexRunId,
      timestamp: new Date(),
    });

    try {
      // Start workflow execution
      const handle = await client.workflow.start("dslWorkflow", {
        taskQueue: this.config.taskQueue!,
        workflowId: temporalWorkflowId,
        args: [
          {
            definition,
            triggerData: triggerData || {},
            vortexRunId,
          },
        ],
      });

      // If waitForCompletion, block until done
      if (options?.waitForCompletion) {
        await handle.result();
        return { runId: vortexRunId };
      }

      return { runId: vortexRunId };
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        // Idempotent - workflow already running with this ID
        return { runId: vortexRunId };
      }
      throw err;
    }
  }

  async getStatus(runId: string): Promise<ExecutionResult> {
    const client = await this.ensureConnected();

    const mapping = runMapping.get(runId);
    if (!mapping) {
      throw new RunNotFoundError(runId);
    }

    const handle = client.workflow.getHandle(mapping.workflowId);
    const description = await handle.describe();

    // Map Temporal status to Vortex status
    const status = this.mapTemporalStatus(description.status.name);

    // Try to get result if completed
    let output: Record<string, unknown> | undefined;
    let error: ExecutionResult["error"] | undefined;

    if (status === "completed") {
      try {
        output = await handle.result();
      } catch (e) {
        // Result not available
      }
    } else if (status === "failed") {
      error = {
        code: "WORKFLOW_FAILED",
        message: description.status.name,
      };
    }

    // Get step results from workflow history (simplified)
    const steps: StepResult[] = [];
    // In production, you'd parse the workflow history for step details

    return {
      runId,
      workflowId: mapping.workflowId,
      status,
      startedAt: description.startTime,
      completedAt: description.closeTime ?? undefined,
      durationMs: description.closeTime
        ? description.closeTime.getTime() - description.startTime.getTime()
        : undefined,
      steps,
      output,
      error,
    };
  }

  async cancel(runId: string): Promise<void> {
    const client = await this.ensureConnected();

    const mapping = runMapping.get(runId);
    if (!mapping) {
      throw new RunNotFoundError(runId);
    }

    const handle = client.workflow.getHandle(mapping.workflowId);
    await handle.cancel();

    // Emit cancel event
    this.emitEvent(runId, {
      type: "run:cancel",
      runId,
      timestamp: new Date(),
    });
  }

  async *stream(runId: string): AsyncIterable<ExecutionEvent> {
    const mapping = runMapping.get(runId);
    if (!mapping) {
      throw new RunNotFoundError(runId);
    }

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

        // Poll Temporal for status updates
        try {
          const status = await this.getStatus(runId);
          if (
            status.status === "completed" ||
            status.status === "failed" ||
            status.status === "cancelled"
          ) {
            const eventType =
              status.status === "completed"
                ? "run:complete"
                : status.status === "failed"
                  ? "run:fail"
                  : "run:cancel";
            yield {
              type: eventType,
              runId,
              timestamp: new Date(),
              data: status.output,
            };
            return;
          }
        } catch {
          // Ignore polling errors
        }

        // Wait for next event or poll interval
        await new Promise<void>((resolve) => {
          resolver = resolve;
          setTimeout(resolve, 1000); // Poll every second
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
      const client = await this.ensureConnected();
      // Simple health check - try to get workflow service info
      // This will fail if the connection is not healthy
      await client.workflowService.getSystemInfo({});
      return true;
    } catch {
      return false;
    }
  }

  /** Map Temporal workflow status to Vortex run status */
  private mapTemporalStatus(temporalStatus: string): RunStatus {
    switch (temporalStatus) {
      case "RUNNING":
        return "running";
      case "COMPLETED":
        return "completed";
      case "FAILED":
      case "TIMED_OUT":
        return "failed";
      case "CANCELED":
      case "TERMINATED":
        return "cancelled";
      default:
        return "pending";
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
   * Called by the Temporal workflow to report step progress.
   */
  static emitRunEvent(runId: string, event: ExecutionEvent): void {
    const listeners = eventEmitters.get(runId) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}
