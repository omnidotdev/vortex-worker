/**
 * Local Executor Adapter
 *
 * Implements the WorkflowExecutor interface using in-process execution.
 * Useful for development, testing, and simple deployments that don't
 * need distributed workflow orchestration.
 *
 * Features:
 * - No external dependencies (runs in-process)
 * - Synchronous option for testing
 * - Full event streaming support
 * - Memory-based run storage
 */

import {
  createExecutionContext,
  executeStep,
  findTriggerStep,
} from "../../dsl/executor";

import type { Step, WorkflowDefinition } from "../../dsl/types";
import type { WorkflowExecutor } from "../interface";
import type {
  ExecuteOptions,
  ExecutionEvent,
  ExecutionResult,
  StepResult,
} from "../types";

/** In-memory store for run results */
const runStore = new Map<
  string,
  {
    workflowId: string;
    definition: WorkflowDefinition;
    triggerData: Record<string, unknown>;
    status: ExecutionResult["status"];
    startedAt: Date;
    completedAt?: Date;
    steps: StepResult[];
    output?: Record<string, unknown>;
    error?: ExecutionResult["error"];
  }
>();

/** Event emitters for streaming */
const eventEmitters = new Map<string, ((event: ExecutionEvent) => void)[]>();

export class LocalExecutor implements WorkflowExecutor {
  readonly name = "local";

  async execute(
    definition: WorkflowDefinition,
    triggerData?: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<{ runId: string }> {
    const workflowId = options?.idempotencyKey || `wf-${Date.now()}`;
    const runId = `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Initialize run in store
    runStore.set(runId, {
      workflowId,
      definition,
      triggerData: triggerData || {},
      status: "pending",
      startedAt: new Date(),
      steps: [],
    });

    // Emit run start event
    this.emitEvent(runId, {
      type: "run:start",
      runId,
      timestamp: new Date(),
    });

    // Execute synchronously or asynchronously based on options
    if (options?.waitForCompletion) {
      await this.executeWorkflow(runId);
    } else {
      // Fire and forget - execute in background
      this.executeWorkflow(runId).catch((error) => {
        console.error(`Workflow ${runId} failed:`, error);
      });
    }

    return { runId };
  }

  async getStatus(runId: string): Promise<ExecutionResult> {
    const run = runStore.get(runId);

    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }

    return {
      runId,
      workflowId: run.workflowId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.completedAt
        ? run.completedAt.getTime() - run.startedAt.getTime()
        : undefined,
      steps: run.steps,
      output: run.output,
      error: run.error,
    };
  }

  async cancel(runId: string): Promise<void> {
    const run = runStore.get(runId);

    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }

    // Mark as cancelled
    run.status = "cancelled";
    run.completedAt = new Date();

    // Emit cancel event
    this.emitEvent(runId, {
      type: "run:cancel",
      runId,
      timestamp: new Date(),
    });
  }

  async *stream(runId: string): AsyncIterable<ExecutionEvent> {
    const run = runStore.get(runId);

    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
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

        // Check if run is already complete
        const currentRun = runStore.get(runId);
        if (
          currentRun &&
          (currentRun.status === "completed" ||
            currentRun.status === "failed" ||
            currentRun.status === "cancelled")
        ) {
          return;
        }

        // Wait for next event with timeout
        await Promise.race([
          new Promise<void>((resolve) => {
            resolver = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
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
    return true; // Local executor is always healthy
  }

  /** Execute a workflow synchronously */
  private async executeWorkflow(runId: string): Promise<void> {
    const run = runStore.get(runId);
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }

    try {
      // Update status to running
      run.status = "running";

      // Create execution context
      const execCtx = createExecutionContext(
        run.workflowId,
        runId,
        run.triggerData,
      );

      // Find trigger step
      const triggerStep = findTriggerStep(run.definition.steps);
      if (!triggerStep) {
        throw new Error("Workflow has no trigger step");
      }

      // Execute workflow using BFS
      const queue: Step[] = [triggerStep];
      const visited = new Set<string>();

      while (queue.length > 0) {
        // Check if cancelled (re-fetch from store to get current status)
        const currentRun = runStore.get(runId);
        if (currentRun?.status === "cancelled") {
          return;
        }

        const step = queue.shift()!;

        if (visited.has(step.id)) {
          continue;
        }
        visited.add(step.id);

        // Record step start
        const stepResult: StepResult = {
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          status: "running",
          startedAt: new Date(),
        };
        run.steps.push(stepResult);

        // Emit step start event
        this.emitEvent(runId, {
          type: "step:start",
          runId,
          stepId: step.id,
          timestamp: new Date(),
        });

        try {
          // Execute the step
          const { nextSteps, result } = await executeStep(
            run.definition,
            step,
            execCtx,
          );

          // Update step result
          stepResult.status = "completed";
          stepResult.completedAt = new Date();
          stepResult.durationMs =
            stepResult.completedAt.getTime() - stepResult.startedAt!.getTime();
          stepResult.output = result;

          // Emit step complete event
          this.emitEvent(runId, {
            type: "step:complete",
            runId,
            stepId: step.id,
            timestamp: new Date(),
            data: result,
          });

          // Queue next steps
          queue.push(...nextSteps);
        } catch (stepError) {
          // Step failed
          stepResult.status = "failed";
          stepResult.completedAt = new Date();
          stepResult.error =
            stepError instanceof Error ? stepError.message : String(stepError);

          // Emit step fail event
          this.emitEvent(runId, {
            type: "step:fail",
            runId,
            stepId: step.id,
            timestamp: new Date(),
            data: { error: stepResult.error },
          });

          throw stepError;
        }
      }

      // Workflow completed successfully
      run.status = "completed";
      run.completedAt = new Date();
      run.output = execCtx.stepResults as Record<string, unknown>;

      // Emit run complete event
      this.emitEvent(runId, {
        type: "run:complete",
        runId,
        timestamp: new Date(),
        data: { completedSteps: run.steps.length },
      });
    } catch (error) {
      // Workflow failed
      run.status = "failed";
      run.completedAt = new Date();
      run.error = {
        code: "EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };

      // Emit run fail event
      this.emitEvent(runId, {
        type: "run:fail",
        runId,
        timestamp: new Date(),
        data: { error: run.error },
      });
    }
  }

  /** Emit an event to all listeners for a run */
  private emitEvent(runId: string, event: ExecutionEvent): void {
    const listeners = eventEmitters.get(runId) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** Clear all stored runs (useful for testing) */
  static clearRuns(): void {
    runStore.clear();
    eventEmitters.clear();
  }
}
