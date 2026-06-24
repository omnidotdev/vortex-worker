/**
 * Environment variables with validation.
 *
 * Required variables are validated at startup to fail fast.
 *
 * NOTE: Direct property access (`process.env.X`) is used instead of
 * destructuring to prevent Bun's bundler from stripping `process.env`
 * and turning variables into bare references (ReferenceError at runtime)
 */

import { inspectHatchetToken } from "lib/hatchetToken";

const NODE_ENV = process.env.NODE_ENV;
const DATABASE_URL = process.env.DATABASE_URL;
const HATCHET_CLIENT_TOKEN = process.env.HATCHET_CLIENT_TOKEN;
const VORTEX_EXECUTOR = process.env.VORTEX_EXECUTOR ?? "hatchet";
// Temporal (optional, only if using temporal executor)
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS;
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE;
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE;
// AuthZ PDP
const AUTHZ_API_URL = process.env.AUTHZ_API_URL;
const AUTHZ_SERVICE_KEY = process.env.AUTHZ_SERVICE_KEY;
// App API URLs (for reconciliation)
const RUNA_API_URL = process.env.RUNA_API_URL;
// Aether (Billing & entitlements)
const BILLING_API_URL = process.env.BILLING_API_URL;
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY;
// Chronicle (Audit logging)
const CHRONICLE_API_URL = process.env.CHRONICLE_API_URL;
// Meilisearch (unified search service)
const MEILISEARCH_URL = process.env.MEILISEARCH_URL;
const MEILISEARCH_MASTER_KEY = process.env.MEILISEARCH_MASTER_KEY;
// Encryption key for tokens
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
// OAuth provider credentials
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;
const DISCORD_OAUTH_CLIENT_ID = process.env.DISCORD_OAUTH_CLIENT_ID;
const DISCORD_OAUTH_CLIENT_SECRET = process.env.DISCORD_OAUTH_CLIENT_SECRET;
const SLACK_OAUTH_CLIENT_ID = process.env.SLACK_OAUTH_CLIENT_ID;
const SLACK_OAUTH_CLIENT_SECRET = process.env.SLACK_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
// Cache (optional, enables distributed caching)
const CACHE_URL = process.env.CACHE_URL;
// Internal API secret (shared with edge worker)
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
// Vortex service URLs
const VORTEX_API_URL = process.env.VORTEX_API_URL ?? "http://localhost:3001";
const VORTEX_PUBLIC_URL =
  process.env.VORTEX_PUBLIC_URL ?? "http://localhost:3001";
const VORTEX_CALLBACK_BASE_URL =
  process.env.VORTEX_CALLBACK_BASE_URL ?? "http://localhost:3000";
// Platform (system) organization. Only its workflows may use the in-process
// "native" code sandbox; any other org is downgraded to the isolated Worker
// sandbox. Defaults to the seeded platform org so it works without extra config.
const VORTEX_PLATFORM_ORG_ID =
  process.env.VORTEX_PLATFORM_ORG_ID ?? "33880602-cf32-4d8d-8db3-a4a9994c5d45";
// Logging
const LOG_LEVEL_RAW = process.env.LOG_LEVEL;

export const isDevEnv = NODE_ENV === "development";
export const isProdEnv = NODE_ENV === "production";

/** Log level threshold (default: "debug" in dev, "info" in production) */
export const LOG_LEVEL = LOG_LEVEL_RAW ?? (isDevEnv ? "debug" : "info");

/**
 * Assert that a required environment variable is set.
 */
function assertEnv(
  name: string,
  value: string | undefined,
): asserts value is string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

/**
 * Assert that required environment variables are set in production.
 */
function assertProdEnv(name: string, value: string | undefined): void {
  if (isProdEnv && !value) {
    throw new Error(
      `Missing required environment variable for production: ${name}`,
    );
  }
}

/** Validate required env vars. Call once at startup */
export function validateEnv(): void {
  assertEnv("DATABASE_URL", DATABASE_URL);
  // Hatchet is always required, it runs platform workflows (authz, chronicle, tokenRefresh, etc.)
  assertEnv("HATCHET_CLIENT_TOKEN", HATCHET_CLIENT_TOKEN);
  // The Hatchet token is a JWT with a finite exp. An expired token makes the
  // worker fail Hatchet auth (UNAUTHENTICATED) and silently stop executing
  // event-triggered workflows, so surface it loudly at boot instead of leaving
  // a cryptic dispatch-time failure. Do NOT throw: booting lets /ready report
  // the condition and keeps the pod inspectable.
  const tokenInfo = inspectHatchetToken(HATCHET_CLIENT_TOKEN, Date.now());
  if (tokenInfo.status === "expired") {
    console.error(
      `HATCHET_CLIENT_TOKEN EXPIRED at ${new Date(tokenInfo.expiresAtMs ?? 0).toISOString()}; worker cannot authenticate to Hatchet and will not execute workflows. Rotate it: hatchet-admin token create, then update vortex-secrets/hatchet-client-token`,
    );
  } else if (tokenInfo.status === "expiring") {
    console.warn(
      `HATCHET_CLIENT_TOKEN expires soon (${new Date(tokenInfo.expiresAtMs ?? 0).toISOString()}); rotate it before it lapses to avoid a workflow-execution outage`,
    );
  } else if (tokenInfo.status === "unparseable") {
    console.warn(
      "HATCHET_CLIENT_TOKEN is not a decodable JWT; cannot verify its expiry",
    );
  }
  // Temporal is opt-in, validate only if configured
  if (TEMPORAL_ADDRESS) {
    assertEnv("TEMPORAL_ADDRESS", TEMPORAL_ADDRESS);
  }

  assertProdEnv("IGGY_PASSWORD", process.env.IGGY_PASSWORD);
  assertProdEnv("VORTEX_API_URL", process.env.VORTEX_API_URL);
  assertProdEnv("VORTEX_PUBLIC_URL", process.env.VORTEX_PUBLIC_URL);
  assertProdEnv(
    "VORTEX_CALLBACK_BASE_URL",
    process.env.VORTEX_CALLBACK_BASE_URL,
  );
}

// Export validated variables
export {
  AUTHZ_API_URL,
  AUTHZ_SERVICE_KEY,
  BILLING_API_URL,
  BILLING_SERVICE_API_KEY,
  CACHE_URL,
  CHRONICLE_API_URL,
  DATABASE_URL,
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  ENCRYPTION_KEY,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  HATCHET_CLIENT_TOKEN,
  INTERNAL_API_SECRET,
  MEILISEARCH_MASTER_KEY,
  MEILISEARCH_URL,
  NODE_ENV,
  RUNA_API_URL,
  SLACK_OAUTH_CLIENT_ID,
  SLACK_OAUTH_CLIENT_SECRET,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
  VORTEX_API_URL,
  VORTEX_CALLBACK_BASE_URL,
  VORTEX_EXECUTOR,
  VORTEX_PLATFORM_ORG_ID,
  VORTEX_PUBLIC_URL,
};

// Startup warnings for optional integrations
if (!AUTHZ_API_URL)
  console.warn("AUTHZ_API_URL not set, authorization disabled");
if (!BILLING_API_URL) console.warn("BILLING_API_URL not set, billing disabled");
if (!CHRONICLE_API_URL)
  console.warn("CHRONICLE_API_URL not set, audit logging disabled");
