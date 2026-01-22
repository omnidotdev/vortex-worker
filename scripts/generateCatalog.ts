#!/usr/bin/env bun
/**
 * Generate Integration Catalog from Installed Activepieces Pieces
 *
 * Scans installed @activepieces/piece-* packages and extracts full metadata
 * including actions, triggers, and auth requirements.
 *
 * Usage:
 *   bun run scripts/generateCatalog.ts
 *
 * Output:
 *   ../vortex-api/src/data/integrations/catalog.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Piece } from "@activepieces/pieces-framework";
import { discoverPieces, loadConnector } from "../src/connectors/registry";

const OUTPUT_PATH = join(
  import.meta.dir,
  "../../vortex-api/src/data/integrations/catalog.json",
);

interface CatalogAction {
  name: string;
  displayName: string;
  description: string;
  requireAuth: boolean;
}

interface CatalogTrigger {
  name: string;
  displayName: string;
  description: string;
  type: "polling" | "webhook" | "app_webhook";
}

interface CatalogAuthField {
  name: string;
  displayName: string;
  description?: string;
  type: "string" | "password" | "url";
  required: boolean;
}

interface CatalogAuth {
  type: "secret_text" | "basic_auth" | "oauth2" | "custom_auth" | "none";
  displayName: string;
  description?: string;
  /** For OAuth2 */
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** For custom_auth */
  fields?: CatalogAuthField[];
}

interface CatalogEntry {
  id: string;
  packageId: string;
  displayName: string;
  description: string;
  logoUrl: string;
  authors: string[];
  categories: string[];
  auth?: CatalogAuth;
  actions: CatalogAction[];
  triggers: CatalogTrigger[];
  version?: string;
}

interface Catalog {
  $schema: string;
  generatedAt: string;
  total: number;
  entries: CatalogEntry[];
}

/**
 * Extract auth configuration from Activepieces piece.
 */
function extractAuth(piece: Piece): CatalogAuth | undefined {
  const auth = piece.auth;
  if (!auth) return undefined;

  const authDef = Array.isArray(auth) ? auth[0] : auth;
  if (!authDef) return undefined;

  const baseAuth = {
    displayName:
      (authDef as { displayName?: string }).displayName ?? "Authentication",
    description: (authDef as { description?: string }).description,
  };

  const propType = (authDef as { type?: string }).type;

  switch (propType) {
    case "SECRET_TEXT":
      return { ...baseAuth, type: "secret_text" };
    case "BASIC_AUTH":
      return { ...baseAuth, type: "basic_auth" };
    case "OAUTH2":
      return {
        ...baseAuth,
        type: "oauth2",
        authorizationUrl: (authDef as { authUrl?: string }).authUrl,
        tokenUrl: (authDef as { tokenUrl?: string }).tokenUrl,
        scopes: (authDef as { scope?: string[] }).scope,
      };
    case "CUSTOM_AUTH":
      return {
        ...baseAuth,
        type: "custom_auth",
        fields: Object.entries((authDef as { props?: object }).props ?? {}).map(
          ([name, prop]) => ({
            name,
            displayName: (prop as { displayName?: string }).displayName ?? name,
            description: (prop as { description?: string }).description,
            type:
              (prop as { type?: string }).type === "SECRET_TEXT"
                ? ("password" as const)
                : ("string" as const),
            required: (prop as { required?: boolean }).required ?? false,
          }),
        ),
      };
    default:
      return { ...baseAuth, type: "none" };
  }
}

/**
 * Extract action metadata from Activepieces piece.
 */
function extractActions(piece: Piece): CatalogAction[] {
  try {
    const actions = piece.actions();
    return Object.entries(actions).map(([name, action]) => ({
      name,
      displayName: action.displayName,
      description: action.description,
      requireAuth: action.requireAuth ?? true,
    }));
  } catch {
    return [];
  }
}

/**
 * Extract trigger metadata from Activepieces piece.
 */
function extractTriggers(piece: Piece): CatalogTrigger[] {
  try {
    const triggers = piece.triggers();
    return Object.entries(triggers).map(([name, trigger]) => {
      const triggerType =
        trigger.type === "WEBHOOK"
          ? "webhook"
          : trigger.type === "APP_WEBHOOK"
            ? "app_webhook"
            : "polling";

      return {
        name,
        displayName: trigger.displayName,
        description: trigger.description,
        type: triggerType as "polling" | "webhook" | "app_webhook",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Convert package ID to a simple ID.
 * @example "@activepieces/piece-discord" -> "discord"
 */
function toSimpleId(packageId: string): string {
  return packageId.replace("@activepieces/piece-", "");
}

/**
 * Main function.
 */
async function main() {
  console.log("Discovering installed Activepieces pieces...\n");

  const packageIds = await discoverPieces();
  console.log(`Found ${packageIds.length} pieces. Loading metadata...\n`);

  const entries: CatalogEntry[] = [];
  const errors: string[] = [];

  let loaded = 0;
  for (const packageId of packageIds) {
    try {
      const connector = await loadConnector(packageId);
      if (!connector) {
        errors.push(`${packageId}: Failed to load`);
        continue;
      }

      const { piece, metadata } = connector;
      const pieceMetadata = piece.metadata();

      entries.push({
        id: toSimpleId(packageId),
        packageId,
        displayName: metadata.displayName,
        description: metadata.description,
        logoUrl: metadata.logoUrl,
        authors: metadata.authors,
        categories: metadata.categories,
        auth: extractAuth(piece),
        actions: extractActions(piece),
        triggers: extractTriggers(piece),
        version: pieceMetadata.version,
      });

      loaded++;
      if (loaded % 50 === 0) {
        console.log(`  Loaded ${loaded} / ${packageIds.length}...`);
      }
    } catch (error) {
      errors.push(
        `${packageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\nLoaded ${entries.length} pieces successfully.`);

  if (errors.length > 0) {
    console.log(`\n${errors.length} errors:`);
    for (const err of errors.slice(0, 10)) {
      console.log(`  - ${err}`);
    }
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more`);
    }
  }

  // Sort alphabetically by display name
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Group by category for summary
  const byCategory = entries.reduce(
    (acc, entry) => {
      for (const cat of entry.categories.length
        ? entry.categories
        : ["other"]) {
        acc[cat] = (acc[cat] || 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log("\nBy category:");
  for (const [cat, count] of Object.entries(byCategory).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${cat}: ${count}`);
  }

  // Count actions and triggers
  const totalActions = entries.reduce((sum, e) => sum + e.actions.length, 0);
  const totalTriggers = entries.reduce((sum, e) => sum + e.triggers.length, 0);
  console.log(`\nTotal actions: ${totalActions}`);
  console.log(`Total triggers: ${totalTriggers}`);

  // Write output
  const catalog: Catalog = {
    $schema: "./catalog.schema.json",
    generatedAt: new Date().toISOString(),
    total: entries.length,
    entries,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(catalog, null, 2));

  console.log(`\nWrote catalog to: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Error generating catalog:", error);
  process.exit(1);
});
