/**
 * Environment variables with validation.
 *
 * Required variables are validated at startup to fail fast.
 *
 * NOTE: Direct property access (`process.env.X`) is used instead of
 * destructuring to prevent Bun's bundler from stripping `process.env`
 * and turning variables into bare references (ReferenceError at runtime)
 */

const NODE_ENV = process.env.NODE_ENV;
const DATABASE_URL = process.env.DATABASE_URL;
const HATCHET_CLIENT_TOKEN = process.env.HATCHET_CLIENT_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VORTEX_EXECUTOR = process.env.VORTEX_EXECUTOR ?? "hatchet";
// Temporal (optional, only if using temporal executor)
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS;
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE;
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE;
// Warden (AuthZ PDP)
const WARDEN_API_URL = process.env.WARDEN_API_URL;
const WARDEN_SERVICE_KEY = process.env.WARDEN_SERVICE_KEY;
// App API URLs (for reconciliation)
const RUNA_API_URL = process.env.RUNA_API_URL;
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
  // Hatchet is always required — it runs platform workflows (authz, chronicle, tokenRefresh, etc.)
  assertEnv("HATCHET_CLIENT_TOKEN", HATCHET_CLIENT_TOKEN);
  // Temporal is opt-in — validate only if configured
  if (TEMPORAL_ADDRESS) {
    assertEnv("TEMPORAL_ADDRESS", TEMPORAL_ADDRESS);
  }

  assertProdEnv("RESEND_API_KEY", RESEND_API_KEY);
}

// Export validated variables
export {
  NODE_ENV,
  DATABASE_URL,
  HATCHET_CLIENT_TOKEN,
  RESEND_API_KEY,
  VORTEX_EXECUTOR,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
  WARDEN_API_URL,
  WARDEN_SERVICE_KEY,
  RUNA_API_URL,
  CHRONICLE_API_URL,
  MEILISEARCH_URL,
  MEILISEARCH_MASTER_KEY,
  ENCRYPTION_KEY,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET,
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  SLACK_OAUTH_CLIENT_ID,
  SLACK_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  CACHE_URL,
};
