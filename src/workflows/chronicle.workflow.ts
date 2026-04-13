/**
 * Chronicle Audit Workflow
 *
 * Handles durable event emission to Chronicle audit logging service.
 * Receives events from all Omni products (Runa, Backfeed, Gatekeeper, etc.)
 * for compliance tracking, forensics, and user activity feeds.
 *
 * Flow:
 * 1. App emits 'audit:log' event via Hatchet
 * 2. This workflow executes with retry logic
 * 3. Events are forwarded to Chronicle API
 *
 * Event Types:
 * - entity.created / entity.updated / entity.deleted
 * - user.login / user.logout
 * - permission.granted / permission.revoked
 * - Custom product-specific events
 */

import { CHRONICLE_API_URL } from "../lib/config/env.config";

import type { Workflow } from "@hatchet-dev/typescript-sdk";

/**
 * Audit event structure from apps (Runa, Backfeed, etc.).
 */
interface AppAuditEvent {
  /** Event type (e.g., "task.created", "user.login") */
  eventType: string;
  /** Actor who performed the action */
  actor: {
    id: string;
    type: "user" | "system" | "service";
    email?: string;
    name?: string;
  };
  /** Resource being acted upon */
  resource: {
    id: string;
    type: string;
    name?: string;
  };
  /** Organization context */
  organizationId: string;
  /** Workspace context (optional) */
  workspaceId?: string;
  /** Source product (e.g., "runa", "backfeed", "gatekeeper") */
  source: string;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Additional event-specific metadata */
  metadata?: Record<string, unknown>;
  /** Request context for forensics */
  context?: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  };
}

/**
 * Chronicle event structure (matches Chronicle API schema).
 */
interface ChronicleEvent {
  organizationId: string;
  workspaceId?: string;
  product: string;
  actorId?: string;
  actorName?: string;
  actorEmail?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

interface AuditLogInput {
  /** Single event or batch of events */
  events: AppAuditEvent[];
}

/**
 * Transform app event format to Chronicle format.
 */
function transformToChronicleEvent(event: AppAuditEvent): ChronicleEvent {
  return {
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    product: event.source,
    actorId: event.actor?.id,
    actorName: event.actor?.name,
    actorEmail: event.actor?.email,
    action: event.eventType,
    resourceType: event.resource?.type,
    resourceId: event.resource?.id,
    resourceName: event.resource?.name,
    ipAddress: event.context?.ipAddress,
    userAgent: event.context?.userAgent,
    metadata: event.metadata,
  };
}

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10000;

/** Maximum events per batch */
const MAX_BATCH_SIZE = 100;

export const chronicleAuditWorkflow: Workflow = {
  id: "chronicle-audit",
  description: "Log audit events to Chronicle service",
  on: {
    event: "audit:log",
  },
  steps: [
    {
      name: "log-to-chronicle",
      timeout: "30s",
      retries: 3,
      run: async (ctx) => {
        const input = ctx.workflowInput() as AuditLogInput;
        const { events } = input;

        if (!CHRONICLE_API_URL) {
          ctx.log("CHRONICLE_API_URL not configured, skipping audit log");
          return {
            success: false,
            error: "CHRONICLE_API_URL not configured",
            eventCount: events?.length ?? 0,
          };
        }

        if (!events || events.length === 0) {
          ctx.log("No events to log");
          return {
            success: true,
            eventCount: 0,
          };
        }

        if (events.length > MAX_BATCH_SIZE) {
          ctx.log(
            `Warning: Batch size ${events.length} exceeds max ${MAX_BATCH_SIZE}, truncating`,
          );
        }

        const batch = events.slice(0, MAX_BATCH_SIZE);
        const sources = [...new Set(batch.map((e) => e.source))];

        ctx.log(
          `Logging ${batch.length} events from ${sources.join(", ")} to Chronicle`,
        );

        // Transform events from app format to Chronicle format
        const chronicleEvents = batch.map(transformToChronicleEvent);

        const response = await fetch(`${CHRONICLE_API_URL}/ingest/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: chronicleEvents }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new Error(
            `Chronicle POST failed: ${response.status} - ${errorText}`,
          );
        }

        const result = (await response.json()) as { count: number };

        ctx.log(`Successfully logged ${result.count} events to Chronicle`);

        return {
          success: true,
          eventCount: batch.length,
          insertedCount: result.count,
          sources,
        };
      },
    },
  ],
};
