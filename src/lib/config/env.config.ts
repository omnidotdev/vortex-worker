/**
 * Environment variables with validation.
 *
 * Required variables are validated at startup to fail fast.
 */

const {
  NODE_ENV,
  DATABASE_URL,
  HATCHET_CLIENT_TOKEN,
  RESEND_API_KEY,
  VORTEX_EXECUTOR = "hatchet",
  // Temporal (optional, only if using temporal executor)
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
  // Warden (AuthZ PDP)
  WARDEN_API_URL,
} = process.env;

export const isDevEnv = NODE_ENV === "development";
export const isProdEnv = NODE_ENV === "production";

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

// Validate required environment variables
assertEnv("DATABASE_URL", DATABASE_URL);

// Validate executor-specific requirements
if (VORTEX_EXECUTOR === "hatchet") {
  assertEnv("HATCHET_CLIENT_TOKEN", HATCHET_CLIENT_TOKEN);
} else if (VORTEX_EXECUTOR === "temporal") {
  assertEnv("TEMPORAL_ADDRESS", TEMPORAL_ADDRESS);
}

// Validate production-only requirements
assertProdEnv("RESEND_API_KEY", RESEND_API_KEY);

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
};
