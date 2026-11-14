/**
 * Environment exposed to workflow templates as `{{ env.X }}`.
 *
 * Templates used to resolve against the worker's whole `process.env`, which let
 * any tenant workflow read every worker secret (database URL, encryption key,
 * service keys). The worker env is now never exposed to tenant workflows, and
 * platform-org system workflows (seeded by vortex-api, e.g. the email-send and
 * Fractal notification flows) see only the explicit whitelist below. Tenants
 * that need credentials in a workflow use their own org-scoped secrets and
 * connections instead.
 */

/**
 * Worker env keys that platform-org system workflow templates may reference.
 * Never add worker infrastructure secrets (DATABASE_URL, ENCRYPTION_KEY,
 * HATCHET_CLIENT_TOKEN, BILLING_SERVICE_API_KEY, INTERNAL_API_SECRET, ...): a
 * template only needs the outbound endpoints and keys its own steps call
 */
export const PLATFORM_TEMPLATE_ENV_KEYS: readonly string[] = Object.freeze([
  "AUTH_API_URL",
  "EMAIL_RENDER_SECRET",
  "FRACTAL_APP_URL",
  "FRACTAL_SENDER_EMAIL_ADDRESS",
  "HERALD_API_KEY",
  "HERALD_API_URL",
  "HERALD_SENDER_EMAIL_ADDRESS",
  "MANTLE_API_URL",
  "MANTLE_SERVICE_KEY",
  "ORG_SYNC_SERVICE_TOKEN",
  "SENDER_EMAIL_ADDRESS",
  "VORTEX_API_KEY",
  "VORTEX_API_URL",
]);

/**
 * Build the `env` object a workflow's templates resolve against.
 *
 * Returns an empty object for every org except the platform org, and fails
 * closed when either id is missing.
 */
export function resolveTemplateEnv(
  organizationId: string | undefined,
  platformOrgId: string | undefined,
  source: Record<string, string | undefined> = process.env,
): Readonly<Record<string, string>> {
  if (!organizationId || !platformOrgId || organizationId !== platformOrgId) {
    return Object.freeze({});
  }

  const env: Record<string, string> = {};
  for (const key of PLATFORM_TEMPLATE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  return Object.freeze(env);
}
