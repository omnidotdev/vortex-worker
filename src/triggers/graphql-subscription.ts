/**
 * GraphQL Subscription Trigger Runner
 *
 * Scans for active workflows with `trigger.type === "graphql_subscription"` and
 * opens a WebSocket subscription for each one. When an event arrives the
 * workflow is dispatched via Hatchet's event bus.
 */

import Hatchet from "@hatchet-dev/typescript-sdk";
import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "graphql-ws";

import logger from "lib/logger";

import type { Workflow } from "db/schema";

// Scan interval for detecting new/removed graphql-subscription-triggered workflows (60s)
const SCAN_INTERVAL_MS = 60 * 1_000;

// Track active subscriptions keyed by workflow ID — value is the dispose fn
const activeSubscriptions = new Map<string, () => void>();

let scanInterval: ReturnType<typeof setInterval> | null = null;

let hatchet: ReturnType<typeof Hatchet.init> | null = null;

function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!hatchet) {
    hatchet = Hatchet.init();
  }
  return hatchet;
}

type GraphQLSubscriptionTriggerConfig = {
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  operationName?: string;
};

/**
 * Normalize an HTTP(S) URL to WS(S) for use with graphql-ws.
 */
function normalizeWsUrl(endpoint: string): string {
  return endpoint
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");
}

/**
 * Parse graphql_subscription trigger config from workflow definition steps.
 */
function extractGraphQLSubscriptionConfig(
  definition: unknown,
): GraphQLSubscriptionTriggerConfig | null {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { type: string; config: Record<string, unknown> };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  if (triggerStep?.trigger?.type !== "graphql_subscription") return null;

  const config = triggerStep.trigger
    .config as Partial<GraphQLSubscriptionTriggerConfig>;

  if (!config.endpoint || !config.query) return null;

  return {
    endpoint: config.endpoint as string,
    query: config.query as string,
    variables: config.variables,
    headers: config.headers,
    operationName: config.operationName,
  };
}

/**
 * Dispatch a workflow when a GraphQL subscription event arrives.
 */
async function dispatchFromGraphQLSubscription(
  workflowId: string,
  organizationId: string,
  definition: unknown,
  eventData: unknown,
): Promise<void> {
  const db = getDb();
  const engineWorkflowId = `gql-${workflowId}-${Date.now()}`;
  const engineRunId = `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const [run] = await db
      .insert(workflowRunTable)
      .values({
        workflowId,
        engineWorkflowId,
        engineRunId,
        status: "pending",
        input: {
          trigger: "graphql_subscription",
          data: eventData,
          receivedAt: new Date().toISOString(),
        },
      })
      .returning();

    await getHatchet().event.push("workflow:execute", {
      workflowId: run.engineWorkflowId,
      runId: run.id,
      organizationId,
      triggerData: {
        trigger: "graphql_subscription",
        data: eventData,
        receivedAt: new Date().toISOString(),
      },
      definition,
    });

    await db
      .update(workflowRunTable)
      .set({ status: "running" })
      .where(eq(workflowRunTable.id, run.id));
  } catch (err) {
    logger.error("Failed to dispatch graphql-subscription-triggered workflow", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start a GraphQL subscription for a single workflow.
 */
function startGraphQLSubscription(workflow: {
  id: string;
  organizationId: string;
  definition: unknown;
  gqlConfig: GraphQLSubscriptionTriggerConfig;
}): () => void {
  const wsUrl = normalizeWsUrl(workflow.gqlConfig.endpoint);

  const client = createClient({
    url: wsUrl,
    connectionParams: workflow.gqlConfig.headers
      ? { headers: workflow.gqlConfig.headers }
      : undefined,
  });

  const unsubscribe = client.subscribe(
    {
      query: workflow.gqlConfig.query,
      variables: workflow.gqlConfig.variables,
      operationName: workflow.gqlConfig.operationName,
    },
    {
      next: (data) => {
        dispatchFromGraphQLSubscription(
          workflow.id,
          workflow.organizationId,
          workflow.definition,
          data.data,
        ).catch((err) => {
          logger.error("Error dispatching graphql subscription event", {
            workflowId: workflow.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      error: (err) => {
        logger.error("GraphQL subscription error", {
          workflowId: workflow.id,
          endpoint: wsUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      },
      complete: () => {
        logger.info("GraphQL subscription completed", {
          workflowId: workflow.id,
          endpoint: wsUrl,
        });
      },
    },
  );

  logger.info("GraphQL subscription started", {
    workflowId: workflow.id,
    endpoint: wsUrl,
  });

  return () => {
    unsubscribe();
    void client.dispose();
  };
}

/**
 * Build a map of active subscriptions from a list of workflows.
 * Exported for testing.
 */
export async function buildActiveSubscriptions(
  workflows: Pick<Workflow, "id" | "organizationId" | "definition">[],
): Promise<Map<string, () => void>> {
  const result = new Map<string, () => void>();

  for (const w of workflows) {
    const gqlConfig = extractGraphQLSubscriptionConfig(w.definition);
    if (!gqlConfig) continue;

    const dispose = startGraphQLSubscription({
      id: w.id,
      organizationId: w.organizationId,
      definition: w.definition,
      gqlConfig,
    });

    result.set(w.id, dispose);
  }

  return result;
}

/**
 * Scan for active workflows with graphql_subscription triggers and reconcile subscriptions.
 */
async function scanGraphQLSubscriptionWorkflows(): Promise<void> {
  const db = getDb();

  try {
    const workflows = await db.query.workflowTable.findMany({
      where: eq(workflowTable.isActive, true),
      columns: {
        id: true,
        organizationId: true,
        definition: true,
      },
    });

    // Find workflows with graphql_subscription triggers that have valid configs
    const gqlWorkflows = workflows.flatMap((w) => {
      const gqlConfig = extractGraphQLSubscriptionConfig(w.definition);
      if (!gqlConfig) return [];
      return [{ ...w, gqlConfig }];
    });

    const activeWorkflowIds = new Set(gqlWorkflows.map((w) => w.id));

    // Stop subscriptions for removed/disabled workflows
    for (const [id, dispose] of activeSubscriptions) {
      if (!activeWorkflowIds.has(id)) {
        try {
          dispose();
        } catch (err) {
          logger.error("Error stopping GraphQL subscription", {
            workflowId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        activeSubscriptions.delete(id);
        logger.info("GraphQL subscription stopped (workflow deactivated)", {
          workflowId: id,
        });
      }
    }

    // Start subscriptions for new workflows
    for (const workflow of gqlWorkflows) {
      if (activeSubscriptions.has(workflow.id)) continue;

      const dispose = startGraphQLSubscription(workflow);
      activeSubscriptions.set(workflow.id, dispose);
    }
  } catch (err) {
    logger.error("Error scanning graphql_subscription workflows", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the GraphQL subscription trigger runner.
 */
export function startGraphQLSubscriptionTriggerRunner(): void {
  if (scanInterval) {
    logger.warn("GraphQL subscription trigger runner already running");
    return;
  }

  logger.info("GraphQL subscription trigger runner started");

  scanGraphQLSubscriptionWorkflows();
  scanInterval = setInterval(
    scanGraphQLSubscriptionWorkflows,
    SCAN_INTERVAL_MS,
  );
}

/**
 * Stop the GraphQL subscription trigger runner and dispose all subscriptions.
 */
export function stopGraphQLSubscriptionTriggerRunner(): Promise<void> {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  for (const [id, dispose] of activeSubscriptions) {
    try {
      dispose();
    } catch (err) {
      logger.error("Error stopping GraphQL subscription during shutdown", {
        workflowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  activeSubscriptions.clear();

  logger.info("GraphQL subscription trigger runner stopped");

  return Promise.resolve();
}
