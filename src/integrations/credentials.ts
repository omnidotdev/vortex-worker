/**
 * Integration credential lookup for workflow execution.
 *
 * Fetches OAuth tokens or API keys from the database for a given
 * integration type and organization.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import logger from "lib/logger";
import { DATABASE_URL } from "../lib/config/env.config";
import { decryptJson, isEncrypted } from "../lib/crypto/encryption";

import type { DecryptedCredentialValue } from "../connectors/types";

// Define the schema types we need (avoiding circular import with vortex-api)
interface Integration {
  id: string;
  organizationId: string;
  definitionId: string | null;
  type: string;
  name: string;
  isEnabled: boolean;
  config: string | Record<string, unknown>; // May be encrypted string or object
  authMethod: string;
  oauthStatus: string | null;
}

interface OAuthToken {
  id: string;
  integrationId: string;
  organizationId: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string;
  expiresAt: string | null;
}

// Lazy-initialize database connection
let db: ReturnType<typeof drizzle> | null = null;

function getDb() {
  if (!db) {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured");
    }
    db = drizzle(DATABASE_URL);
  }
  return db;
}

/** OAuth provider token endpoints */
const TOKEN_URLS: Record<string, string> = {
  github: "https://github.com/login/oauth/access_token",
  discord: "https://discord.com/api/oauth2/token",
  slack: "https://slack.com/api/oauth.v2.access",
  google: "https://oauth2.googleapis.com/token",
};

/** Get OAuth credentials for a provider */
function getProviderCredentials(
  provider: string,
): { clientId: string; clientSecret: string } | null {
  const envMap: Record<string, { id?: string; secret?: string }> = {
    github: {
      id: process.env.GITHUB_OAUTH_CLIENT_ID,
      secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
    },
    discord: {
      id: process.env.DISCORD_OAUTH_CLIENT_ID,
      secret: process.env.DISCORD_OAUTH_CLIENT_SECRET,
    },
    slack: {
      id: process.env.SLACK_OAUTH_CLIENT_ID,
      secret: process.env.SLACK_OAUTH_CLIENT_SECRET,
    },
    google: {
      id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
  };

  const creds = envMap[provider];
  if (!creds?.id || !creds?.secret) return null;

  return { clientId: creds.id, clientSecret: creds.secret };
}

/**
 * Fetch integration credentials for a given organization and integration type.
 *
 * @param organizationId - The organization ID
 * @param integrationType - The integration type (e.g., "discord", "slack", "github")
 * @returns The auth credentials in DecryptedCredentialValue format, or undefined if not found
 */
export async function getIntegrationCredentials(
  organizationId: string,
  integrationType: string,
): Promise<DecryptedCredentialValue | undefined> {
  const database = getDb();

  // Query integration table using raw SQL
  const integrationResult = await database.execute(sql`
    SELECT id, organization_id as "organizationId", definition_id as "definitionId",
            type, name, is_enabled as "isEnabled", config, auth_method as "authMethod",
            oauth_status as "oauthStatus"
     FROM integration
     WHERE organization_id = ${organizationId} AND type = ${integrationType} AND is_enabled = true
     LIMIT 1
  `);

  const integrations = integrationResult.rows as unknown as Integration[];

  if (integrations.length === 0) {
    logger.debug("No enabled integration found", {
      organizationId,
      integrationType,
    });
    return undefined;
  }

  const integration = integrations[0];

  // For OAuth integrations, fetch the token
  if (integration.authMethod === "oauth") {
    const tokenResult = await database.execute(sql`
      SELECT id, integration_id as "integrationId", organization_id as "organizationId",
              provider, access_token as "accessToken", refresh_token as "refreshToken",
              token_type as "tokenType", scope, expires_at as "expiresAt"
       FROM oauth_token
       WHERE integration_id = ${integration.id}
       ORDER BY created_at DESC
       LIMIT 1
    `);

    const tokens = tokenResult.rows as unknown as OAuthToken[];

    if (tokens.length === 0) {
      logger.debug("No OAuth token found", { integrationId: integration.id });
      return undefined;
    }

    const token = tokens[0];

    // Check if token is expired and attempt refresh
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
      logger.debug("OAuth token expired, attempting refresh", {
        integrationId: integration.id,
      });

      if (!token.refreshToken) {
        logger.warn("No refresh token available for expired OAuth token", {
          integrationId: integration.id,
        });
        return undefined;
      }

      // Look up provider credentials and token URL
      const providerCredentials = getProviderCredentials(token.provider);
      const tokenUrl = TOKEN_URLS[token.provider];

      if (!providerCredentials || !tokenUrl) {
        logger.warn("Cannot refresh token: missing provider config", {
          integrationId: integration.id,
          provider: token.provider,
        });
        return undefined;
      }

      try {
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token.refreshToken,
            client_id: providerCredentials.clientId,
            client_secret: providerCredentials.clientSecret,
          }).toString(),
        });

        if (!response.ok) {
          logger.error("OAuth token refresh failed", {
            integrationId: integration.id,
            provider: token.provider,
            status: response.status,
          });
          return undefined;
        }

        const data = (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };

        // Calculate new expiration
        const expiresAt = data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : null;

        // Update token in database
        await database.execute(sql`
          UPDATE oauth_token
          SET access_token = ${data.access_token},
              refresh_token = COALESCE(${data.refresh_token ?? null}, refresh_token),
              expires_at = ${expiresAt},
              updated_at = NOW()
          WHERE id = ${token.id}
        `);

        logger.info("OAuth token refreshed", {
          integrationId: integration.id,
          provider: token.provider,
        });

        return {
          type: "oauth2",
          accessToken: data.access_token,
          refreshToken: data.refresh_token || token.refreshToken || undefined,
          tokenType: token.tokenType || "Bearer",
          scope: token.scope || undefined,
        };
      } catch (err) {
        logger.error("OAuth token refresh error", {
          integrationId: integration.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }

    return {
      type: "oauth2",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || undefined,
      tokenType: token.tokenType || "Bearer",
      scope: token.scope || undefined,
    };
  }

  // For API key or custom auth, use the config field
  // Config may be encrypted - decrypt if needed
  let config: Record<string, unknown> = {};
  const rawConfig = integration.config;

  if (typeof rawConfig === "string" && isEncrypted(rawConfig)) {
    try {
      config = decryptJson<Record<string, unknown>>(rawConfig);
      logger.debug("Decrypted config", { integrationId: integration.id });
    } catch (err) {
      logger.error("Failed to decrypt config", {
        integrationId: integration.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  } else if (typeof rawConfig === "object" && rawConfig !== null) {
    config = rawConfig as Record<string, unknown>;
  }

  // Check for Twilio-style Basic Auth (accountSid + authToken)
  const accountSid =
    (config.accountSid as string) || (config.account_sid as string);
  const authToken =
    (config.authToken as string) || (config.auth_token as string);
  if (accountSid && authToken) {
    return {
      type: "basic_auth",
      username: accountSid,
      password: authToken,
    };
  }

  // Check for generic username/password Basic Auth
  const username = config.username as string;
  const password = config.password as string;
  if (username && password) {
    return {
      type: "basic_auth",
      username,
      password,
    };
  }

  // Check common API key field names and return as secret_text
  const apiKey =
    (config.apiKey as string) ||
    (config.api_key as string) ||
    (config.botToken as string) ||
    (config.bot_token as string) ||
    (config.secretKey as string) ||
    (config.secret_key as string);

  if (apiKey) {
    return {
      type: "secret_text",
      secret: apiKey.trim(), // Ensure no whitespace
    };
  }

  // Return custom fields for other auth types
  if (Object.keys(config).length > 0) {
    // Convert config to string fields for custom_auth
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      fields[key] = String(value);
    }
    return {
      type: "custom_auth",
      fields,
    };
  }

  logger.debug("No credentials found in integration config", {
    integrationId: integration.id,
  });
  return undefined;
}
