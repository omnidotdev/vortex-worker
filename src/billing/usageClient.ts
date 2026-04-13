/**
 * Aether usage metering client.
 *
 * Records usage events (step executions, compute time, plugin invocations)
 * to the Aether billing service. Designed for fire-and-forget usage —
 * all errors are swallowed and logged so metering never blocks execution.
 */

import {
  BILLING_API_URL,
  BILLING_SERVICE_API_KEY,
} from "lib/config/env.config";
import logger from "lib/logger";

const APP_ID = "vortex";
const REQUEST_TIMEOUT_MS = 5_000;

type UsageRecordResponse = {
  id: string;
  meterKey: string;
  delta: number;
  recordedAt: string;
};

/**
 * Make an authenticated request to the Aether billing API.
 * Returns null on any error for graceful degradation.
 */
async function aetherFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T | null> {
  if (!BILLING_API_URL || !BILLING_SERVICE_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(`${BILLING_API_URL}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-service-api-key": BILLING_SERVICE_API_KEY,
        ...options?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("Aether usage API returned non-OK status", {
        path,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    logger.warn("Failed to record usage to Aether", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Record a usage event to Aether.
 * @param entityType - Billing entity type (e.g. "organization")
 * @param entityId - ID of the billing entity
 * @param meterKey - Usage meter identifier (e.g. "step_executions", "compute_ms")
 * @param delta - Amount to increment
 * @param idempotencyKey - Optional key to prevent duplicate recording
 */
type UsageCheckResponse = {
  allowed: boolean;
  currentUsage: number;
  limit: number;
};

/**
 * Check whether additional usage is allowed under the current plan.
 * Returns null on any error for graceful degradation (allows execution
 * to proceed if Aether is unreachable).
 *
 * @param entityType - Billing entity type (e.g. "organization")
 * @param entityId - ID of the billing entity
 * @param meterKey - Usage meter identifier
 * @param additionalUsage - How many units to check against the limit
 */
export async function checkUsage(
  entityType: string,
  entityId: string,
  meterKey: string,
  additionalUsage?: number,
): Promise<UsageCheckResponse | null> {
  const params = new URLSearchParams();
  if (additionalUsage !== undefined) {
    params.set("additionalUsage", String(additionalUsage));
  }

  const qs = params.toString();
  const path = `/usage/${APP_ID}/${entityType}/${entityId}/${meterKey}/check${qs ? `?${qs}` : ""}`;

  return aetherFetch<UsageCheckResponse>(path);
}

export async function recordUsage(
  entityType: string,
  entityId: string,
  meterKey: string,
  delta: number,
  idempotencyKey?: string,
): Promise<UsageRecordResponse | null> {
  return aetherFetch<UsageRecordResponse>(
    `/usage/${APP_ID}/${entityType}/${entityId}/${meterKey}/record`,
    {
      method: "POST",
      body: JSON.stringify({
        delta,
        ...(idempotencyKey && { idempotencyKey }),
      }),
    },
  );
}
