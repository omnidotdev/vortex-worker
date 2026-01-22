/**
 * Vortex Worker - DSL Workflow Execution Engine
 *
 * Error tracking: OpenTelemetry traces/logs sent to HyperDX via instrumentation.ts
 */

// Import env config first to validate environment variables
import "./lib/config/env.config";

import Hatchet from "@hatchet-dev/typescript-sdk";

import { initializeMCPServers } from "./mcp";
import { authzSyncWorkflow } from "./workflows/authz.workflow";
import { chronicleAuditWorkflow } from "./workflows/chronicle.workflow";
import { dslWorkflow } from "./workflows/dsl.workflow";
import { searchBootstrapWorkflow } from "./workflows/searchBootstrap.workflow";
import { tokenRefreshWorkflow } from "./workflows/tokenRefresh.workflow";

async function main() {
  await initializeMCPServers();

  // Start Hatchet worker
  const hatchet = Hatchet.init();
  const worker = await hatchet.worker("vortex-dsl-worker", {
    workflows: [
      authzSyncWorkflow,
      chronicleAuditWorkflow,
      dslWorkflow,
      searchBootstrapWorkflow,
      tokenRefreshWorkflow,
    ],
  });
  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
