/**
 * AuthZ Reconciliation Workflow
 *
 * Periodically reconciles authorization tuples between app databases and Warden PDP.
 * Runs daily via Hatchet cron trigger.
 *
 * Flow:
 * 1. Call each app's /authz/reconcile endpoint
 * 2. Log results for observability
 * 3. Alert on errors (via workflow failure)
 *
 * Currently supports: Vortex, Runa
 * TODO: Add Backfeed, Gaia when they have reconcile endpoints
 */

import { CreateTaskWorkflow } from "@hatchet-dev/typescript-sdk/v1";

import {
  AUTHZ_SERVICE_KEY,
  RUNA_API_URL,
  VORTEX_API_URL,
} from "../lib/config/env.config";

/** Request timeout for reconcile calls */
const REQUEST_TIMEOUT_MS = 60000; // 60s - reconcile can be slow

interface ReconcileResult {
  app: string;
  success: boolean;
  expected?: number;
  actual?: number;
  written?: number;
  deleted?: number;
  errors?: string[];
  error?: string;
}

/**
 * Call an app's reconcile endpoint.
 */
async function reconcileApp(
  app: string,
  apiUrl: string,
  serviceKey: string,
  path = "/authz/reconcile",
): Promise<ReconcileResult> {
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": serviceKey,
      },
      body: JSON.stringify({ deleteOrphans: false }), // Conservative: don't auto-delete
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 404 means the app doesn't expose a reconcile endpoint yet -- treat
      // as a skip, not a failure, so the cron doesn't fail unnecessarily
      if (response.status === 404) {
        return {
          app,
          success: true,
          error: "endpoint not implemented (skipped)",
        };
      }
      const errorText = await response.text().catch(() => "Unknown error");
      return {
        app,
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = (await response.json()) as {
      success: boolean;
      expected?: number;
      actual?: number;
      written?: number;
      deleted?: number;
      errors?: string[];
    };

    return {
      app,
      success: data.success,
      expected: data.expected,
      actual: data.actual,
      written: data.written,
      deleted: data.deleted,
      errors: data.errors,
    };
  } catch (err) {
    return {
      app,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const authzReconcileWorkflow = CreateTaskWorkflow({
  name: "authz-reconcile",
  description: "Reconcile authorization tuples across all apps",
  on: {
    cron: "0 3 * * *", // Daily at 3 AM UTC
  },
  executionTimeout: "5m",
  retries: 2,
  fn: async (_input, ctx) => {
    const results: ReconcileResult[] = [];

    // Reconcile Vortex
    if (VORTEX_API_URL && AUTHZ_SERVICE_KEY) {
      ctx.log("Reconciling Vortex...");
      const vortexResult = await reconcileApp(
        "vortex",
        VORTEX_API_URL,
        AUTHZ_SERVICE_KEY,
        "/api/v1/authz/reconcile",
      );
      results.push(vortexResult);

      if (vortexResult.success) {
        ctx.log(
          `Vortex: expected=${vortexResult.expected}, actual=${vortexResult.actual}, written=${vortexResult.written}`,
        );
      } else {
        ctx.log(`Vortex reconcile failed: ${vortexResult.error}`);
      }
    } else {
      ctx.log("Skipping Vortex: VORTEX_API_URL or AUTHZ_SERVICE_KEY not set");
    }

    // Reconcile Runa
    if (RUNA_API_URL && AUTHZ_SERVICE_KEY) {
      ctx.log("Reconciling Runa...");
      const runaResult = await reconcileApp(
        "runa",
        RUNA_API_URL,
        AUTHZ_SERVICE_KEY,
      );
      results.push(runaResult);

      if (runaResult.success) {
        ctx.log(
          `Runa: expected=${runaResult.expected}, actual=${runaResult.actual}, written=${runaResult.written}`,
        );
      } else {
        ctx.log(`Runa reconcile failed: ${runaResult.error}`);
      }
    } else {
      ctx.log("Skipping Runa: RUNA_API_URL or AUTHZ_SERVICE_KEY not set");
    }

    // TODO: Add more apps as they implement /authz/reconcile
    // - Backfeed
    // - Gaia

    // Check for any failures
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      const failedApps = failures.map((f) => f.app).join(", ");
      throw new Error(`Reconciliation failed for: ${failedApps}`);
    }

    // Summary
    const totalWritten = results.reduce((sum, r) => sum + (r.written ?? 0), 0);
    ctx.log(`Reconciliation complete. Total tuples written: ${totalWritten}`);

    return {
      success: true,
      results,
      totalWritten,
      reconciledAt: new Date().toISOString(),
    } as unknown as undefined;
  },
});
