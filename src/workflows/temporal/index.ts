/**
 * Temporal Workflow Exports
 *
 * This module exports the Temporal workflow and activities for DSL execution.
 */

// Export activities for use with Temporal Worker
export * as activities from "./activities";

// Export workflow for registration with Temporal
export { dslWorkflow, approvalSignal, customSignal } from "./workflow";
export type {
  DSLWorkflowInput,
  DSLWorkflowOutput,
  GateSignalPayload,
} from "./workflow";
