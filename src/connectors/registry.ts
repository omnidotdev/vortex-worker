/**
 * Connector Registry
 *
 * Manages available connectors (Activepieces pieces).
 * Loads pieces from node_modules and extracts metadata.
 */

import type { Piece } from "@activepieces/pieces-framework";
import type {
  ConnectorAction,
  ConnectorAuth,
  ConnectorMetadata,
  ConnectorProperty,
  ConnectorPropertyType,
  ConnectorTrigger,
  LoadedConnector,
} from "./types";

/**
 * Map of connector ID to loaded connector.
 */
const loadedConnectors = new Map<string, LoadedConnector>();

/**
 * List of available Activepieces piece packages.
 * Add new connectors here as dependencies are added.
 */
const AVAILABLE_PIECES: string[] = [
  // Communication
  "@activepieces/piece-discord",
  "@activepieces/piece-slack",
  "@activepieces/piece-telegram-bot",
  // Developer tools
  "@activepieces/piece-github",
  "@activepieces/piece-gitlab",
  "@activepieces/piece-linear",
  // Productivity
  "@activepieces/piece-google-sheets",
  "@activepieces/piece-notion",
  "@activepieces/piece-airtable",
  // CRM & Marketing
  "@activepieces/piece-hubspot",
  "@activepieces/piece-mailchimp",
  // Payments
  "@activepieces/piece-stripe",
  // AI
  "@activepieces/piece-openai",
];

/**
 * Extract auth configuration from Activepieces piece.
 */
function extractAuth(piece: Piece): ConnectorAuth | undefined {
  const auth = piece.auth;
  if (!auth) return undefined;

  // Handle array of auth methods (pick first for now)
  const authDef = Array.isArray(auth) ? auth[0] : auth;
  if (!authDef) return undefined;

  const baseAuth = {
    displayName: authDef.displayName ?? "Authentication",
    description: authDef.description,
  };

  // Determine auth type from the property type
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
                ? "password"
                : "string",
            required: (prop as { required?: boolean }).required ?? false,
          }),
        ),
      };
    default:
      return { ...baseAuth, type: "none" };
  }
}

/**
 * Map Activepieces property type to our type.
 */
function mapPropertyType(apType: string): ConnectorPropertyType {
  const typeMap: Record<string, ConnectorPropertyType> = {
    SHORT_TEXT: "short_text",
    LONG_TEXT: "long_text",
    NUMBER: "number",
    CHECKBOX: "checkbox",
    DROPDOWN: "dropdown",
    MULTI_SELECT_DROPDOWN: "multi_select_dropdown",
    DATE_TIME: "date_time",
    FILE: "file",
    JSON: "json",
    DYNAMIC: "dynamic",
    ARRAY: "array",
    OBJECT: "object",
  };
  return typeMap[apType] ?? "short_text";
}

/**
 * Extract property definitions from Activepieces props object.
 */
function extractProps(props: Record<string, unknown>): ConnectorProperty[] {
  return Object.entries(props).map(([name, prop]) => {
    const p = prop as {
      displayName?: string;
      description?: string;
      type?: string;
      required?: boolean;
      defaultValue?: unknown;
      options?: { options?: Array<{ label: string; value: unknown }> };
      refreshers?: string[];
    };

    return {
      name,
      displayName: p.displayName ?? name,
      description: p.description,
      type: mapPropertyType(p.type ?? "SHORT_TEXT"),
      required: p.required ?? false,
      defaultValue: p.defaultValue,
      options: p.options?.options?.map((o) => ({
        label: o.label,
        value: o.value as string | number | boolean,
      })),
      dynamicOptions: typeof p.options === "function",
      refreshers: p.refreshers,
    };
  });
}

/**
 * Extract action metadata from Activepieces piece.
 */
function extractActions(piece: Piece): ConnectorAction[] {
  const actions = piece.actions();
  return Object.entries(actions).map(([name, action]) => ({
    name,
    displayName: action.displayName,
    description: action.description,
    props: extractProps(action.props as Record<string, unknown>),
    requireAuth: action.requireAuth ?? true,
  }));
}

/**
 * Extract trigger metadata from Activepieces piece.
 */
function extractTriggers(piece: Piece): ConnectorTrigger[] {
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
      type: triggerType,
      props: extractProps(trigger.props as Record<string, unknown>),
      sampleData: trigger.sampleData,
    };
  });
}

/**
 * Extract metadata from an Activepieces piece.
 */
function extractMetadata(packageId: string, piece: Piece): ConnectorMetadata {
  const meta = piece.metadata();
  return {
    id: packageId,
    displayName: meta.displayName,
    description: meta.description ?? "",
    logoUrl: meta.logoUrl,
    authors: meta.authors ?? [],
    categories: (meta.categories ?? []) as string[],
    auth: extractAuth(piece),
    actions: extractActions(piece),
    triggers: extractTriggers(piece),
    minimumSupportedRelease: meta.minimumSupportedRelease,
  };
}

/**
 * Load a connector from its npm package.
 */
export async function loadConnector(
  packageId: string,
): Promise<LoadedConnector | null> {
  // Check cache
  const cached = loadedConnectors.get(packageId);
  if (cached) return cached;

  try {
    // Dynamic import of the Activepieces piece
    const module = await import(packageId);

    // Activepieces pieces export a default piece instance
    const piece: Piece = module.default ?? module[Object.keys(module)[0]];
    if (!piece) {
      console.warn(`[Connectors] No piece exported from ${packageId}`);
      return null;
    }

    const metadata = extractMetadata(packageId, piece);
    const connector: LoadedConnector = { metadata, piece };

    loadedConnectors.set(packageId, connector);

    return connector;
  } catch {
    // Connector package not installed or failed to load - this is expected
    // when not all connectors are installed
    return null;
  }
}

/**
 * Load all available connectors.
 */
export async function loadAllConnectors(): Promise<LoadedConnector[]> {
  const results = await Promise.all(AVAILABLE_PIECES.map(loadConnector));
  return results.filter((c): c is LoadedConnector => c !== null);
}

/**
 * Get a loaded connector by ID.
 */
export function getConnector(packageId: string): LoadedConnector | undefined {
  return loadedConnectors.get(packageId);
}

/**
 * List all loaded connectors.
 */
export function listConnectors(): LoadedConnector[] {
  return Array.from(loadedConnectors.values());
}

/**
 * List connector metadata (without loading pieces into memory).
 */
export function listConnectorIds(): string[] {
  return AVAILABLE_PIECES;
}

/**
 * Check if a connector ID is valid.
 */
export function isConnector(id: string): boolean {
  return id.startsWith("@activepieces/piece-");
}

/**
 * Get action from a loaded connector.
 */
export function getConnectorAction(
  connectorId: string,
  actionName: string,
): ConnectorAction | undefined {
  const connector = loadedConnectors.get(connectorId);
  if (!connector) return undefined;
  return connector.metadata.actions.find((a) => a.name === actionName);
}

/**
 * Get trigger from a loaded connector.
 */
export function getConnectorTrigger(
  connectorId: string,
  triggerName: string,
): ConnectorTrigger | undefined {
  const connector = loadedConnectors.get(connectorId);
  if (!connector) return undefined;
  return connector.metadata.triggers.find((t) => t.name === triggerName);
}
