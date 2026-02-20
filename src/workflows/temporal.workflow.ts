/**
 * Temporal workflow for DSL execution.
 *
 * IMPORTANT: This file is bundled by the Temporal SDK in a separate deterministic
 * context. It cannot import Node.js built-ins directly. All I/O must go through
 * proxyActivities.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { executeDslWorkflow } from "./temporal.activities";
import type { DSLWorkflowInput } from "./dsl.workflow";

const { executeDslWorkflow: runDsl } = proxyActivities<{
  executeDslWorkflow: typeof executeDslWorkflow;
}>({
  startToCloseTimeout: "2 hours",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

/** Execute a Vortex DSL workflow with Temporal durability guarantees */
export async function dslWorkflow(input: DSLWorkflowInput) {
  return await runDsl(input);
}
