/**
 * Vortex Worker - DSL Workflow Execution Engine
 *
 * Error tracking: OpenTelemetry traces/logs sent to HyperDX via instrumentation.ts
 */

// Import env config first to validate environment variables
import "./lib/config/env.config";

import Hatchet from "@hatchet-dev/typescript-sdk";

import { closeCache, initCache } from "lib/cache";
import logger from "lib/logger";
import { initializeMCPServers } from "./mcp";
import { authzSyncWorkflow } from "./workflows/authz.workflow";
import { authzReconcileWorkflow } from "./workflows/authzReconcile.workflow";
import { chronicleAuditWorkflow } from "./workflows/chronicle.workflow";
import { dslWorkflow } from "./workflows/dsl.workflow";
import { searchBootstrapWorkflow } from "./workflows/searchBootstrap.workflow";
import { tokenRefreshWorkflow } from "./workflows/tokenRefresh.workflow";

async function main() {
  await initCache();
  await initializeMCPServers();

  // Start Hatchet worker
  const hatchet = Hatchet.init();
  const worker = await hatchet.worker("vortex-dsl-worker", {
    workflows: [
      authzReconcileWorkflow,
      authzSyncWorkflow,
      chronicleAuditWorkflow,
      dslWorkflow,
      searchBootstrapWorkflow,
      tokenRefreshWorkflow,
    ],
  });
  await worker.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down worker");
    await closeCache();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("Worker failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
