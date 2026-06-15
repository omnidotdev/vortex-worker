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

import { CreateTaskWorkflow } from "@hatchet-dev/typescript-sdk";

import {
  BILLING_API_URL,
  BILLING_SERVICE_API_KEY,
} from "../lib/config/env.config";

interface TierSyncInput {
  planId?: string;
  appId?: string;
  entityType?: "plan" | "plan_feature";
}

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 60000;

export const tierSyncWorkflow = CreateTaskWorkflow({
  name: "tier-sync",
  description:
    "Sync tier limits and reseed entitlements when plan data changes",
  on: {
    event: "tier:sync",
  },
  executionTimeout: "60s",
  retries: 3,
  fn: async (input: TierSyncInput, ctx) => {
    if (!BILLING_API_URL) {
      ctx.log("BILLING_API_URL not configured, skipping sync");
      return {
        success: false,
        error: "BILLING_API_URL not configured",
      };
    }

    if (!BILLING_SERVICE_API_KEY) {
      ctx.log("BILLING_SERVICE_API_KEY not configured, skipping sync");
      return {
        success: false,
        error: "BILLING_SERVICE_API_KEY not configured",
      };
    }

    ctx.log(
      `Syncing tier limits (planId=${input.planId ?? "all"}, entityType=${input.entityType ?? "unknown"})`,
    );

    const response = await fetch(
      `${BILLING_API_URL}/admin/sync-tier-limits?reseed=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-service-api-key": BILLING_SERVICE_API_KEY,
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
});
