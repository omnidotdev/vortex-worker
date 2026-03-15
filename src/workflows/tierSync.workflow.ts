/**
 * Tier Sync Workflow
 *
 * Sync tier limits and reseed entitlements when plan data changes.
 * Receives events from the Omni API when plans or plan features are
 * created, updated, or deleted.
 *
 * Flow:
 * 1. Plan/plan_feature mutation triggers event on Omni API
 * 2. Event routes through Vortex to Hatchet as 'tier:sync'
 * 3. This workflow calls Aether's admin endpoint to resync limits
 * 4. Aether reseeds entitlements for all affected subscriptions
 */

import {
  AETHER_API_URL,
  AETHER_SERVICE_API_KEY,
} from "../lib/config/env.config";

import type { Workflow } from "@hatchet-dev/typescript-sdk";

interface TierSyncInput {
  planId?: string;
  appId?: string;
  entityType?: "plan" | "plan_feature";
}

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 60000;

export const tierSyncWorkflow: Workflow = {
  id: "tier-sync",
  description:
    "Sync tier limits and reseed entitlements when plan data changes",
  on: {
    event: "tier:sync",
  },
  steps: [
    {
      name: "sync-tier-limits",
      timeout: "60s",
      retries: 3,
      run: async (ctx) => {
        const input = ctx.workflowInput() as TierSyncInput;

        if (!AETHER_API_URL) {
          ctx.log("AETHER_API_URL not configured, skipping sync");
          return {
            success: false,
            error: "AETHER_API_URL not configured",
          };
        }

        if (!AETHER_SERVICE_API_KEY) {
          ctx.log("AETHER_SERVICE_API_KEY not configured, skipping sync");
          return {
            success: false,
            error: "AETHER_SERVICE_API_KEY not configured",
          };
        }

        ctx.log(
          `Syncing tier limits (planId=${input.planId ?? "all"}, entityType=${input.entityType ?? "unknown"})`,
        );

        const response = await fetch(
          `${AETHER_API_URL}/admin/sync-tier-limits?reseed=true`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-service-api-key": AETHER_SERVICE_API_KEY,
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new Error(
            `Aether sync-tier-limits failed: ${response.status} - ${errorText}`,
          );
        }

        const result = await response.json().catch(() => ({}));

        ctx.log("Successfully synced tier limits and reseeded entitlements");

        return {
          success: true,
          planId: input.planId,
          appId: input.appId,
          entityType: input.entityType,
          result,
        };
      },
    },
  ],
};
