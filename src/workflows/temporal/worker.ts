/**
 * Temporal Worker Setup
 *
 * This module provides the worker configuration for running Temporal workflows.
 * The worker executes activities and workflows on the "vortex-dsl" task queue.
 */

import { NativeConnection, Worker } from "@temporalio/worker";

import logger from "lib/logger";
import * as activities from "./activities";

export interface TemporalWorkerConfig {
  /** Temporal server address (default: localhost:7233) */
  address?: string;
  /** Namespace to use (default: default) */
  namespace?: string;
  /** Task queue name (default: vortex-dsl) */
  taskQueue?: string;
  /** Maximum concurrent activities (default: 100) */
  maxConcurrentActivities?: number;
  /** Maximum concurrent workflows (default: 100) */
  maxConcurrentWorkflows?: number;
}

/**
 * Create and start a Temporal worker for DSL workflow execution
 */
export async function createTemporalWorker(
  config: TemporalWorkerConfig = {},
): Promise<Worker> {
  const {
    address = process.env.TEMPORAL_ADDRESS || "localhost:7233",
    namespace = process.env.TEMPORAL_NAMESPACE || "default",
    taskQueue = process.env.TEMPORAL_TASK_QUEUE || "vortex-dsl",
    maxConcurrentActivities = 100,
    maxConcurrentWorkflows = 100,
  } = config;

  // Create connection to Temporal server
  const connection = await NativeConnection.connect({
    address,
  });

  // Create worker
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: require.resolve("./workflow"),
    activities,
    maxConcurrentActivityTaskExecutions: maxConcurrentActivities,
    maxConcurrentWorkflowTaskExecutions: maxConcurrentWorkflows,
  });

  return worker;
}

/**
 * Run the Temporal worker (blocking)
 */
export async function runTemporalWorker(
  config: TemporalWorkerConfig = {},
): Promise<void> {
  const worker = await createTemporalWorker(config);

  // Run until shutdown signal
  await worker.run();
}

// Allow running directly
if (require.main === module) {
  runTemporalWorker().catch((err) => {
    logger.error("Temporal worker error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
