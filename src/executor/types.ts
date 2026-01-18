/**
 * Vortex Executor Types
 *
 * Shared types for workflow execution across all backend adapters.
 */

/** Status of a workflow run */
export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Status of an individual step */
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** Result of a single step execution */
export interface StepResult {
  stepId: string;
  stepName?: string;
  stepType?: string;
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

/** Error details for failed runs */
export interface ExecutionError {
  code: string;
  message: string;
  stepId?: string;
  stack?: string;
}

/** Complete result of a workflow execution */
export interface ExecutionResult {
  runId: string;
  workflowId: string;
  status: RunStatus;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: ExecutionError;
  steps: StepResult[];
}

/** Event types for streaming execution updates */
export type ExecutionEventType =
  | "run:start"
  | "run:complete"
  | "run:fail"
  | "run:cancel"
  | "step:start"
  | "step:complete"
  | "step:fail"
  | "step:skip";

/** Event emitted during workflow execution */
export interface ExecutionEvent {
  type: ExecutionEventType;
  runId: string;
  stepId?: string;
  timestamp: Date;
  data?: unknown;
}

/** Options for workflow execution */
export interface ExecuteOptions {
  /** Unique ID for idempotency - prevents duplicate executions */
  idempotencyKey?: string;

  /** Custom timeout in milliseconds (overrides workflow default) */
  timeout?: number;

  /** Execution priority (if supported by backend) */
  priority?: "low" | "normal" | "high";

  /** Custom metadata to attach to the run */
  metadata?: Record<string, string>;

  /** Whether to wait for completion (sync) or return immediately (async) */
  waitForCompletion?: boolean;
}

/** Configuration for executor backends */
export interface ExecutorConfig {
  /** Backend type */
  type: "hatchet" | "local" | "trigger-dev" | "temporal";

  /** Backend-specific configuration */
  options?: Record<string, unknown>;
}
