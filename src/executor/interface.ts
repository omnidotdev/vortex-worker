/**
 * Vortex Workflow Executor Interface
 *
 * This interface defines the contract that all workflow execution backends
 * must implement. It enables swapping between Hatchet, Trigger.dev, Local,
 * or any future backend without changing application code.
 *
 * @example
 * ```typescript
 * const executor = getExecutor({ type: "hatchet" });
 * const { runId } = await executor.execute(workflowDefinition, triggerData);
 * const status = await executor.getStatus(runId);
 * ```
 */

import type { WorkflowDefinition } from "../dsl/types";
import type { ExecuteOptions, ExecutionEvent, ExecutionResult } from "./types";

/**
 * Core interface for workflow execution backends.
 *
 * All backends (Hatchet, Trigger.dev, Local) must implement this interface
 * to be used interchangeably.
 */
export interface WorkflowExecutor {
  /** Unique identifier for this executor backend */
  readonly name: string;

  /**
   * Execute a workflow definition.
   *
   * Returns immediately with a run ID. The workflow executes asynchronously
   * unless `options.waitForCompletion` is true.
   *
   * @param definition - The workflow DSL definition
   * @param triggerData - Data passed to the trigger step
   * @param options - Execution options (timeout, priority, etc.)
   * @returns Run ID for tracking execution
   *
   * @example
   * ```typescript
   * const { runId } = await executor.execute(
   *   workflowDef,
   *   { userId: "123", event: "signup" },
   *   { priority: "high" }
   * );
   * ```
   */
  execute(
    definition: WorkflowDefinition,
    triggerData?: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<{ runId: string }>;

  /**
   * Get the current status and results of a workflow run.
   *
   * @param runId - The run ID returned from execute()
   * @returns Current execution status and step results
   *
   * @throws {RunNotFoundError} If the run ID doesn't exist
   */
  getStatus(runId: string): Promise<ExecutionResult>;

  /**
   * Cancel a running workflow.
   *
   * If the workflow has already completed, this is a no-op.
   * Steps that are currently executing may complete before cancellation.
   *
   * @param runId - The run ID to cancel
   *
   * @throws {RunNotFoundError} If the run ID doesn't exist
   */
  cancel(runId: string): Promise<void>;

  /**
   * Stream execution events in real-time.
   *
   * Yields events as they occur during workflow execution.
   * The stream completes when the workflow finishes (success, failure, or cancel).
   *
   * @param runId - The run ID to stream events for
   * @returns Async iterable of execution events
   *
   * @example
   * ```typescript
   * for await (const event of executor.stream(runId)) {
   *   console.log(`${event.type}: ${event.stepId}`);
   * }
   * ```
   */
  stream(runId: string): AsyncIterable<ExecutionEvent>;

  /**
   * Check if the executor backend is healthy and connected.
   *
   * @returns True if the backend is ready to accept workflows
   */
  healthCheck(): Promise<boolean>;
}

/**
 * Error thrown when a run ID is not found.
 */
export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Error thrown when execution fails.
 */
export class ExecutionFailedError extends Error {
  readonly runId: string;
  readonly stepId?: string;

  constructor(message: string, runId: string, stepId?: string) {
    super(message);
    this.name = "ExecutionFailedError";
    this.runId = runId;
    this.stepId = stepId;
  }
}
