/**
 * OAuth Token Refresh Workflow
 *
 * Periodically refreshes OAuth tokens that are about to expire.
 * Runs every 15 minutes via Hatchet cron trigger.
 *
 * Flow:
 * 1. Query for tokens expiring within 30 minutes
 * 2. For each token with a refresh token, attempt refresh
 * 3. Update token in database or mark as expired
 */

import { CreateTaskWorkflow } from "@hatchet-dev/typescript-sdk";
import { and, eq, isNotNull, lt } from "drizzle-orm";

import { db } from "../db";
import { integrationTable, oauthTokenTable } from "../db/schema";
import {
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  ENCRYPTION_KEY,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  SLACK_OAUTH_CLIENT_ID,
  SLACK_OAUTH_CLIENT_SECRET,
} from "../lib/config/env.config";

/** Window before expiration to trigger refresh (30 minutes) */
const REFRESH_WINDOW_MINUTES = 30;

/** OAuth provider token endpoints */
const TOKEN_URLS: Record<string, string> = {
  github: "https://github.com/login/oauth/access_token",
  discord: "https://discord.com/api/oauth2/token",
  slack: "https://slack.com/api/oauth.v2.access",
  google: "https://oauth2.googleapis.com/token",
};

/** Get OAuth credentials for a provider */
function getCredentials(
  provider: string,
): { clientId: string; clientSecret: string } | null {
  const credentials: Record<
    string,
    { clientId?: string; clientSecret?: string }
  > = {
    github: {
      clientId: GITHUB_OAUTH_CLIENT_ID,
      clientSecret: GITHUB_OAUTH_CLIENT_SECRET,
    },
    discord: {
      clientId: DISCORD_OAUTH_CLIENT_ID,
      clientSecret: DISCORD_OAUTH_CLIENT_SECRET,
    },
    slack: {
      clientId: SLACK_OAUTH_CLIENT_ID,
      clientSecret: SLACK_OAUTH_CLIENT_SECRET,
    },
    google: {
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    },
  };

  const creds = credentials[provider];
  if (!creds?.clientId || !creds?.clientSecret) {
    return null;
  }

  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

/** Simple encryption/decryption for tokens */
function decrypt(ciphertext: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY not configured");
  }

  const { createDecipheriv } = require("node:crypto");
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }

  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");
  const key = Buffer.from(ENCRYPTION_KEY, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function encrypt(plaintext: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY not configured");
  }

  const { createCipheriv, randomBytes } = require("node:crypto");
  const key = Buffer.from(ENCRYPTION_KEY, "base64");
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export const tokenRefreshWorkflow = CreateTaskWorkflow({
  name: "oauth-token-refresh",
  description: "Refresh expiring OAuth tokens",
  on: {
    cron: "*/15 * * * *", // Every 15 minutes
  },
  executionTimeout: "5m",
  fn: async (_input, ctx) => {
    const cutoff = new Date(Date.now() + REFRESH_WINDOW_MINUTES * 60 * 1000);

    // Find tokens expiring soon that have refresh tokens
    const expiringTokens = await db
      .select({
        id: oauthTokenTable.id,
        integrationId: oauthTokenTable.integrationId,
        provider: oauthTokenTable.provider,
        refreshToken: oauthTokenTable.refreshToken,
      })
      .from(oauthTokenTable)
      .where(
        and(
          lt(oauthTokenTable.expiresAt, cutoff.toISOString()),
          isNotNull(oauthTokenTable.refreshToken),
        ),
      );

    ctx.log(`Found ${expiringTokens.length} tokens to refresh`);

    let refreshed = 0;
    let failed = 0;

    for (const token of expiringTokens) {
      if (!token.refreshToken) continue;

      const credentials = getCredentials(token.provider);
      if (!credentials) {
        ctx.log(`No credentials configured for provider: ${token.provider}`);
        failed++;
        continue;
      }

      const tokenUrl = TOKEN_URLS[token.provider];
      if (!tokenUrl) {
        ctx.log(`No token URL for provider: ${token.provider}`);
        failed++;
        continue;
      }

      try {
        // Decrypt refresh token
        const refreshTokenValue = decrypt(token.refreshToken);

        // Make refresh request
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshTokenValue,
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          }).toString(),
        });

        if (!response.ok) {
          const errorText = await response.text();
          ctx.log(
            `Token refresh failed for ${token.provider}: ${response.status} - ${errorText}`,
          );

          // Mark integration as expired
          await db
            .update(integrationTable)
            .set({
              oauthStatus: "expired",
              updatedAt: new Date().toISOString(),
            })
            .where(eq(integrationTable.id, token.integrationId));

          failed++;
          continue;
        }

        const data = await response.json();

        // Calculate new expiration
        let expiresAt: string | null = null;
        if (data.expires_in) {
          expiresAt = new Date(
            Date.now() + data.expires_in * 1000,
          ).toISOString();
        }

        // Update token
        await db
          .update(oauthTokenTable)
          .set({
            accessToken: encrypt(data.access_token),
            refreshToken: data.refresh_token
              ? encrypt(data.refresh_token)
              : token.refreshToken,
            expiresAt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(oauthTokenTable.id, token.id));

        ctx.log(`Refreshed token for integration ${token.integrationId}`);
        refreshed++;
      } catch (err) {
        ctx.log(
          `Error refreshing token: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        failed++;
      }
    }

    return {
      total: expiringTokens.length,
      refreshed,
      failed,
    };
  },
});
