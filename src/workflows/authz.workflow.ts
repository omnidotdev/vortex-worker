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

import { CreateTaskWorkflow } from "@hatchet-dev/typescript-sdk/v1";

import { AUTHZ_API_URL, AUTHZ_SERVICE_KEY } from "../lib/config/env.config";

type AuthzSyncInput = {
  eventType: "authz.tuples.write" | "authz.tuples.delete";
  tuples: Array<{ user: string; relation: string; object: string }>;
  source: string;
  timestamp: string;
};

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10000;

export const authzSyncWorkflow = CreateTaskWorkflow({
  name: "authz-sync",
  description: "Sync authorization tuples to Warden PDP",
  on: {
    event: "authz:sync",
  },
  executionTimeout: "30s",
  retries: 3,
  fn: async (input: AuthzSyncInput, ctx) => {
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (AUTHZ_SERVICE_KEY) {
      headers["X-Service-Key"] = AUTHZ_SERVICE_KEY;
    }

    const response = await fetch(`${AUTHZ_API_URL}/tuples`, {
      method,
      headers,
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
});
