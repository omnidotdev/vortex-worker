/**
 * Hatchet client token (JWT) expiry inspection.
 *
 * HATCHET_CLIENT_TOKEN is a JWT with a finite `exp`. When it lapses the worker
 * can no longer authenticate to the Hatchet engine: workflow registration
 * (PutWorkflow) and event dispatch (EventsService/Push) fail with
 * UNAUTHENTICATED and event-triggered execution silently stops (events
 * dead-letter). This module decodes the token locally (no network, no signature
 * verification) so boot and health checks can surface an expired or
 * soon-to-expire token loudly instead of failing cryptically at dispatch time.
 */

export type HatchetTokenStatus = "ok" | "expiring" | "expired" | "unparseable";

export interface HatchetTokenInfo {
  status: HatchetTokenStatus;
  /** Expiry in epoch milliseconds, or null when the token has no parseable exp */
  expiresAtMs: number | null;
}

/** Window before expiry within which the token is reported as "expiring" (14 days) */
export const DEFAULT_WARN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Decode a JWT's `exp` claim as epoch milliseconds without verifying the
 * signature. Returns null when the token is not a well-formed JWT or carries no
 * numeric `exp`.
 */
export function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Inspect a Hatchet client token against the current time. `nowMs` and
 * `warnWindowMs` are injected so the logic stays pure and testable.
 */
export function inspectHatchetToken(
  token: string,
  nowMs: number,
  warnWindowMs: number = DEFAULT_WARN_WINDOW_MS,
): HatchetTokenInfo {
  const expiresAtMs = decodeJwtExpiryMs(token);
  if (expiresAtMs === null) return { status: "unparseable", expiresAtMs: null };
  if (expiresAtMs <= nowMs) return { status: "expired", expiresAtMs };
  if (expiresAtMs - nowMs <= warnWindowMs) {
    return { status: "expiring", expiresAtMs };
  }
  return { status: "ok", expiresAtMs };
}
