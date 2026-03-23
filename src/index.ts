/**
 * Vortex Worker - DSL Workflow Execution Engine
 *
 * Error tracking: OpenTelemetry traces/logs sent to HyperDX via instrumentation.ts
 */

// Validate environment variables at startup
import { validateEnv } from "lib/config/env.config";
import Sentry from "lib/sentry";

validateEnv();

import Hatchet from "@hatchet-dev/typescript-sdk";

import { closeCache, initCache } from "lib/cache";
import logger from "lib/logger";
import { executeStep } from "./dsl/executor";
import EventsConsumer from "./events/consumer";
import OutboxSweeper from "./events/outbox";
import { closePublisher, initPublisher } from "./events/publisher";
import routeEvent, { shutdownAccumulators } from "./events/router";
import { startRetryPoller } from "./events/subscription-delivery";
import { getDefaultExecutor } from "./executor";
import { initializeMCPServers } from "./mcp";
import { getPluginRegistry } from "./plugins/registry";
import { startAmqpTriggerRunner, stopAmqpTriggerRunner } from "./triggers/amqp";
import { startCdcTriggerRunner, stopCdcTriggerRunner } from "./triggers/cdc";
import {
  startGraphQLSubscriptionTriggerRunner,
  stopGraphQLSubscriptionTriggerRunner,
} from "./triggers/graphql-subscription";
import { startGrpcTriggerRunner, stopGrpcTriggerRunner } from "./triggers/grpc";
import {
  startKafkaTriggerRunner,
  stopKafkaTriggerRunner,
} from "./triggers/kafka";
import { startMqttTriggerRunner, stopMqttTriggerRunner } from "./triggers/mqtt";
import { startNatsTriggerRunner, stopNatsTriggerRunner } from "./triggers/nats";
import {
  startPollingTriggerRunner,
  stopPollingTriggerRunner,
} from "./triggers/polling";
import {
  startRedisTriggerRunner,
  stopRedisTriggerRunner,
} from "./triggers/redis";
import { initTriggerRegistry } from "./triggers/registry";
import { startS3TriggerRunner, stopS3TriggerRunner } from "./triggers/s3";
import {
  startScheduleQueueFlusher,
  stopScheduleQueueFlusher,
} from "./triggers/schedule-flusher";
import { startSqsTriggerRunner, stopSqsTriggerRunner } from "./triggers/sqs";
import { startSseTriggerRunner, stopSseTriggerRunner } from "./triggers/sse";
import {
  startWebSocketTriggerRunner,
  stopWebSocketTriggerRunner,
} from "./triggers/websocket";
import { authzSyncWorkflow } from "./workflows/authz.workflow";
import { authzReconcileWorkflow } from "./workflows/authzReconcile.workflow";
import { chronicleAuditWorkflow } from "./workflows/chronicle.workflow";
import { dslWorkflow } from "./workflows/dsl.workflow";
import { fnInvokeWorkflow } from "./workflows/fnInvoke.workflow";
import { searchBootstrapWorkflow } from "./workflows/searchBootstrap.workflow";
import { tierSyncWorkflow } from "./workflows/tierSync.workflow";
import { tokenRefreshWorkflow } from "./workflows/tokenRefresh.workflow";

import type { ExecutionContext, Step, WorkflowDefinition } from "./dsl/types";
import type { EventsConfig } from "./events/types";

/**
 * Parse an `iggy://host:port` URL into an EventsConfig.
 */
function parseEventsUrl(url: string): EventsConfig {
  const match = url.match(/^iggy:\/\/([^:]+):(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid EVENTS_URL format, expected iggy://host:port: ${url}`,
    );
  }

  return {
    host: match[1],
    port: Number(match[2]),
    username: process.env.IGGY_USERNAME ?? "iggy",
    password: process.env.IGGY_PASSWORD ?? "iggy",
  };
}

/** Dev-mode fallback for internal API secret */
const DEV_SECRET = "dev-internal-secret";
const resolvedSecret = process.env.INTERNAL_API_SECRET ?? DEV_SECRET;

/** Timing-safe secret comparison */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;

  const { timingSafeEqual } = require("node:crypto");

  return timingSafeEqual(bufA, bufB);
}

async function main() {
  await initCache();
  await initializeMCPServers();

  // Initialize plugin registry (load enabled plugins into memory)
  await getPluginRegistry().init();

  // Initialize trigger adapter registry (built-in + external plugins)
  await initTriggerRegistry();

  // Track Hatchet readiness for health checks
  let hatchetReady = false;

  // Start Hatchet worker with retry for transient gRPC failures (background)
  // Runs in the background so the health server and trigger runners start immediately
  const MAX_HATCHET_RETRIES = 5;

  let hatchetInstance: ReturnType<typeof Hatchet.init> | undefined;

  // Intentionally fire-and-forget — Hatchet init runs in background
  void (async () => {
    for (let attempt = 1; attempt <= MAX_HATCHET_RETRIES; attempt++) {
      try {
        hatchetInstance = Hatchet.init();
        const worker = await hatchetInstance.worker("vortex-dsl-worker", {
          workflows: [
            authzReconcileWorkflow,
            authzSyncWorkflow,
            chronicleAuditWorkflow,
            dslWorkflow,
            fnInvokeWorkflow,
            searchBootstrapWorkflow,
            tierSyncWorkflow,
            tokenRefreshWorkflow,
          ],
        });
        hatchetReady = true;
        logger.info("Hatchet worker registered");
        // Run in background — do not await (start() blocks until connection closes)
        worker.start().catch((err) => {
          hatchetReady = false;
          logger.error("Hatchet worker error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      } catch (err) {
        logger.error(
          `Hatchet worker init failed (attempt ${attempt}/${MAX_HATCHET_RETRIES})`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        if (attempt === MAX_HATCHET_RETRIES) {
          logger.error(
            `Hatchet worker failed after ${MAX_HATCHET_RETRIES} attempts`,
          );
          return;
        }
        // Exponential backoff: 2s, 4s, 8s, 16s
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * 2 ** (attempt - 1)),
        );
      }
    }
  })();

  // Start Temporal worker if configured (background)
  if (process.env.TEMPORAL_ADDRESS) {
    (async () => {
      try {
        const { createTemporalWorker } = await import(
          "./workflows/temporal/worker"
        );
        const temporalWorker = await createTemporalWorker();
        temporalWorker.run().catch((err) => {
          logger.error("Temporal worker error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        logger.info("Temporal worker started", {
          address: process.env.TEMPORAL_ADDRESS,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "vortex-dsl",
        });
      } catch (err) {
        logger.error("Failed to start Temporal worker", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // Start Kafka trigger runner
  startKafkaTriggerRunner();

  // Start SQS trigger runner
  startSqsTriggerRunner();

  // Start GraphQL subscription trigger runner
  startGraphQLSubscriptionTriggerRunner();

  // Start AMQP trigger runner
  startAmqpTriggerRunner();

  // Start MQTT trigger runner
  startMqttTriggerRunner();

  // Start NATS trigger runner
  startNatsTriggerRunner();

  // Start WebSocket trigger runner
  startWebSocketTriggerRunner();

  // Start polling trigger runner
  startPollingTriggerRunner();

  // Start S3 trigger runner
  startS3TriggerRunner();

  // Start CDC trigger runner
  startCdcTriggerRunner();

  // Start Redis pub/sub trigger runner
  startRedisTriggerRunner();

  // Start gRPC stream trigger runner
  startGrpcTriggerRunner();

  // Start SSE trigger runner
  startSseTriggerRunner();

  // Start schedule queue flusher (delivers queued events when windows open)
  startScheduleQueueFlusher();

  // Start subscription delivery retry poller
  const retryPollerInterval = startRetryPoller();

  // Start events consumer if streaming layer is configured
  let eventsConsumer: EventsConsumer | null = null;
  let outboxSweeper: OutboxSweeper | null = null;

  const eventsUrl = process.env.EVENTS_URL;
  if (eventsUrl) {
    const config = parseEventsUrl(eventsUrl);
    eventsConsumer = new EventsConsumer(config, routeEvent);
    await eventsConsumer.start();
    await initPublisher(config);

    // Start outbox sweeper after publisher is initialized
    outboxSweeper = new OutboxSweeper();
    outboxSweeper.start();
  } else {
    logger.warn("EVENTS_URL not set, event routing from Iggy is disabled");
  }

  // Create executor instance for health checks
  const executor = await getDefaultExecutor();

  // Start HTTP server for health checks and internal API
  const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "8080");
  const healthServer = Bun.serve({
    port: HEALTH_PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        // Liveness: always 200 as long as the process is running
        // Hatchet readiness is reported but does not block liveness
        const executorHealthy = await executor.healthCheck();

        return Response.json({
          status: executorHealthy && hatchetReady ? "ok" : "degraded",
          timestamp: Date.now(),
          service: "vortex-worker",
          hatchet: hatchetReady ? "connected" : "initializing",
          executor: executorHealthy ? "ok" : "unreachable",
        });
      }

      if (req.method === "POST" && url.pathname === "/execute-step") {
        // Validate internal secret
        const auth = req.headers.get("authorization");
        if (
          !auth?.startsWith("Bearer ") ||
          !secretsMatch(auth.slice(7), resolvedSecret)
        ) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const body = (await req.json()) as {
            stepType: string;
            config: unknown;
            input: unknown;
            orgId: string;
          };
          const step = {
            id: "edge-step",
            type: body.stepType,
            name: "edge-step",
            config: body.config,
            position: { x: 0, y: 0 },
          } as unknown as Step;
          const ctx: ExecutionContext = {
            workflowId: "edge",
            runId: crypto.randomUUID(),
            organizationId: body.orgId,
            triggerData: {},
            variables: (body.input as Record<string, unknown>) ?? {},
            stepResults: {},
            stepNameToId: {},
          };
          const dummyDef = {
            name: "edge",
            version: "1.0",
            steps: [step],
            edges: [],
          } as unknown as WorkflowDefinition;
          const { result } = await executeStep(dummyDef, step, ctx);
          return Response.json({ result });
        } catch (err) {
          logger.error("execute-step failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return Response.json(
            { error: err instanceof Error ? err.message : "Internal error" },
            { status: 500 },
          );
        }
      }

      // Push an event to Hatchet via the worker's live gRPC connection.
      // Used by vortex-api when direct gRPC from API → Hatchet is unreliable.
      if (req.method === "POST" && url.pathname === "/push-event") {
        const auth = req.headers.get("authorization");
        if (
          !auth?.startsWith("Bearer ") ||
          !secretsMatch(auth.slice(7), resolvedSecret)
        ) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const body = (await req.json()) as {
            key: string;
            payload: Record<string, unknown>;
          };

          if (!body.key || !body.payload) {
            return Response.json(
              { error: "Missing key or payload" },
              { status: 400 },
            );
          }

          if (!hatchetInstance) {
            return Response.json(
              { error: "Hatchet not initialized yet" },
              { status: 503 },
            );
          }

          {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 8_000);
            try {
              await Promise.race([
                hatchetInstance.event.push(body.key, body.payload),
                new Promise((_, reject) => {
                  ac.signal.addEventListener("abort", () =>
                    reject(new Error("Hatchet push timed out after 8s")),
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }

          return Response.json({ ok: true });
        } catch (err) {
          logger.error("push-event failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return Response.json(
            { error: err instanceof Error ? err.message : "Internal error" },
            { status: 500 },
          );
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });
  logger.info("Worker health server running", { port: HEALTH_PORT });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down worker");
    healthServer.stop();
    // Temporal worker shuts down via its own error handling
    eventsConsumer?.stop();
    outboxSweeper?.stop();
    closePublisher();
    clearInterval(retryPollerInterval);
    stopScheduleQueueFlusher();
    await shutdownAccumulators();
    await Promise.all([
      stopAmqpTriggerRunner(),
      stopKafkaTriggerRunner(),
      stopSqsTriggerRunner(),
      stopGraphQLSubscriptionTriggerRunner(),
      stopMqttTriggerRunner(),
      stopNatsTriggerRunner(),
      stopWebSocketTriggerRunner(),
      stopPollingTriggerRunner(),
      stopS3TriggerRunner(),
      stopCdcTriggerRunner(),
      stopRedisTriggerRunner(),
      stopGrpcTriggerRunner(),
      stopSseTriggerRunner(),
    ]);
    await closeCache();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  Sentry.captureException(err);
  logger.error(
    `Worker failed to start: ${err instanceof Error ? err.message : String(err)}`,
    { stack: err instanceof Error ? err.stack : undefined },
  );
  process.exit(1);
});
