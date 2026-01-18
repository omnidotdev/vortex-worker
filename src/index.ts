/**
 * Vortex Worker - DSL Workflow Execution Engine
 *
 * TODO: Integrate FOSS error tracking for production
 * Options:
 * - GlitchTip: Sentry-compatible, self-hosted (https://glitchtip.com)
 * - Highlight.io: Open source, self-hosted option (https://highlight.io)
 * - OpenTelemetry: Add error collection to existing tracing
 * - Structured logging: JSON logs aggregated via Loki/ELK stack
 */

// Import env config first to validate environment variables
import "./lib/config/env.config";

import Hatchet from "@hatchet-dev/typescript-sdk";

import { initializeMCPServers } from "./mcp";
import { authzSyncWorkflow } from "./workflows/authz.workflow";
import { dslWorkflow } from "./workflows/dsl.workflow";

async function main() {
  // Initialize MCP servers from database
  console.log("Initializing MCP servers...");
  await initializeMCPServers();

  // Start Hatchet worker
  const hatchet = Hatchet.init();
  const worker = await hatchet.worker("vortex-dsl-worker", {
    workflows: [dslWorkflow, authzSyncWorkflow],
  });
  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
