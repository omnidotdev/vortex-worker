/**
 * AuthZ Sync Workflow
 *
 * Handles durable synchronization of authorization tuples to Warden PDP.
 * Receives events from Gatekeeper (IDP), Backfeed, Runa, and other apps.
 *
 * Flow:
 * 1. App triggers webhook on vortex-api with tuple data
 * 2. Vortex-api pushes 'authz:sync' event to Hatchet
 * 3. This workflow executes with retry logic
 * 4. Tuples are forwarded to Warden API
 */

import { AUTHZ_API_URL } from "../lib/config/env.config";

import type { Workflow } from "@hatchet-dev/typescript-sdk";

interface AuthzSyncInput {
  eventType: "authz.tuples.write" | "authz.tuples.delete";
  tuples: Array<{ user: string; relation: string; object: string }>;
  source: string;
  timestamp: string;
}

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10000;

export const authzSyncWorkflow: Workflow = {
  id: "authz-sync",
  description: "Sync authorization tuples to Warden PDP",
  on: {
    event: "authz:sync",
  },
  steps: [
    {
      name: "sync-to-warden",
      timeout: "30s",
      retries: 3,
      run: async (ctx) => {
        const input = ctx.workflowInput() as AuthzSyncInput;
        const { eventType, tuples, source } = input;

        if (!AUTHZ_API_URL) {
          ctx.log("AUTHZ_API_URL not configured, skipping sync");
          return {
            success: false,
            error: "AUTHZ_API_URL not configured",
            tupleCount: tuples.length,
            source,
          };
        }

        if (!tuples || tuples.length === 0) {
          ctx.log("No tuples to sync");
          return {
            success: true,
            tupleCount: 0,
            source,
          };
        }

        const method = eventType === "authz.tuples.write" ? "POST" : "DELETE";

        ctx.log(
          `Syncing ${tuples.length} tuples from ${source} to Warden (${method})`,
        );

        const response = await fetch(`${AUTHZ_API_URL}/tuples`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tuples }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errorText = await response
            .text()
            .catch((err) => (err instanceof Error ? err.message : String(err)));
          throw new Error(
            `Warden ${method} failed: ${response.status} - ${errorText}`,
          );
        }

        ctx.log(`Successfully synced ${tuples.length} tuples to Warden`);

        return {
          success: true,
          tupleCount: tuples.length,
          operation: eventType,
          source,
        };
      },
    },
  ],
};
