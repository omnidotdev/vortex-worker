/**
 * Vortex Connector Types
 *
 * Connectors are service integrations powered by Activepieces pieces.
 * They provide pre-built actions and triggers for 280+ services.
 *
 * @see https://github.com/activepieces/activepieces (MIT License)
 */

import type { Piece } from "@activepieces/pieces-framework";
import type { PluginCallResult, PluginContext } from "../plugins/types";

/**
 * Supported authentication types for connectors.
 */
export type ConnectorAuthType =
  | "secret_text" // API key or token
  | "basic_auth" // Username + password
  | "oauth2" // OAuth 2.0 flow
  | "custom_auth" // Custom fields
  | "none"; // No auth required

/**
 * Connector authentication configuration.
 */
export interface ConnectorAuth {
  /** Auth type */
  type: ConnectorAuthType;
  /** Display name for the auth (e.g., "API Key", "Bot Token") */
  displayName: string;
  /** Description/instructions for setup */
  description?: string;
  /** For OAuth2: authorization URL */
  authorizationUrl?: string;
  /** For OAuth2: token URL */
  tokenUrl?: string;
  /** For OAuth2: required scopes */
  scopes?: string[];
  /** For custom auth: field definitions */
  fields?: ConnectorAuthField[];
}

/**
 * Custom auth field definition.
 */
export interface ConnectorAuthField {
  name: string;
  displayName: string;
  description?: string;
  type: "string" | "password" | "url";
  required: boolean;
}

/**
 * Stored authentication credentials for a connector.
 * Per-workspace, encrypted at rest.
 */
export interface ConnectorCredential {
  /** Unique ID */
  id: string;
  /** Workspace/organization ID */
  organizationId: string;
  /** Connector ID (e.g., "@activepieces/piece-discord") */
  connectorId: string;
  /** Display name for this connection */
  name: string;
  /** Auth type */
  type: ConnectorAuthType;
  /** Encrypted credential value */
  value: EncryptedCredentialValue;
  /** When the credential was created */
  createdAt: Date;
  /** When the credential was last updated */
  updatedAt: Date;
  /** For OAuth2: when the token expires */
  expiresAt?: Date;
}

/**
 * Encrypted credential value (stored in database).
 */
export type EncryptedCredentialValue =
  | {
      type: "secret_text";
      /** Encrypted token/key */
      secret: string;
    }
  | {
      type: "basic_auth";
      /** Encrypted username */
      username: string;
      /** Encrypted password */
      password: string;
    }
  | {
      type: "oauth2";
      /** Encrypted access token */
      accessToken: string;
      /** Encrypted refresh token */
      refreshToken?: string;
      /** Token type (usually "Bearer") */
      tokenType: string;
      /** Scopes granted */
      scope?: string;
    }
  | {
      type: "custom_auth";
      /** Encrypted field values */
      fields: Record<string, string>;
    };

/**
 * Connector action definition (from Activepieces piece).
 */
export interface ConnectorAction {
  /** Action name (unique within connector) */
  name: string;
  /** Display name */
  displayName: string;
  /** Description */
  description: string;
  /** Input property definitions */
  props: ConnectorProperty[];
  /** Whether auth is required */
  requireAuth: boolean;
}

/**
 * Connector trigger definition.
 */
export interface ConnectorTrigger {
  /** Trigger name */
  name: string;
  /** Display name */
  displayName: string;
  /** Description */
  description: string;
  /** Trigger strategy */
  type: "polling" | "webhook" | "app_webhook";
  /** Input property definitions */
  props: ConnectorProperty[];
  /** Sample data for UI */
  sampleData: unknown;
}

/**
 * Property definition for connector inputs.
 */
export interface ConnectorProperty {
  name: string;
  displayName: string;
  description?: string;
  type: ConnectorPropertyType;
  required: boolean;
  defaultValue?: unknown;
  /** For dropdowns: static options */
  options?: ConnectorPropertyOption[];
  /** For dropdowns: whether options are loaded dynamically */
  dynamicOptions?: boolean;
  /** Properties this depends on for dynamic loading */
  refreshers?: string[];
}

export type ConnectorPropertyType =
  | "short_text"
  | "long_text"
  | "number"
  | "checkbox"
  | "dropdown"
  | "multi_select_dropdown"
  | "date_time"
  | "file"
  | "json"
  | "dynamic"
  | "array"
  | "object";

export interface ConnectorPropertyOption {
  label: string;
  value: string | number | boolean;
}

/**
 * Connector metadata extracted from Activepieces piece.
 */
export interface ConnectorMetadata {
  /** Package name (e.g., "@activepieces/piece-discord") */
  id: string;
  /** Display name */
  displayName: string;
  /** Description */
  description: string;
  /** Logo URL */
  logoUrl: string;
  /** Authors */
  authors: string[];
  /** Categories */
  categories: string[];
  /** Auth configuration */
  auth?: ConnectorAuth;
  /** Available actions */
  actions: ConnectorAction[];
  /** Available triggers */
  triggers: ConnectorTrigger[];
  /** Minimum supported Activepieces version */
  minimumSupportedRelease?: string;
}

/**
 * Loaded connector ready for execution.
 */
export interface LoadedConnector {
  /** Connector metadata */
  metadata: ConnectorMetadata;
  /** Underlying Activepieces piece */
  piece: Piece;
}

/**
 * Context for executing connector actions/triggers.
 * Extends PluginContext with connector-specific data.
 */
export interface ConnectorContext extends PluginContext {
  /** Decrypted auth credentials */
  auth?: DecryptedCredentialValue;
  /** User-configured property values */
  propsValue: Record<string, unknown>;
  /** Key-value store for the flow */
  store: ConnectorStore;
  /** Server context for dynamic property loading */
  server: ConnectorServerContext;
}

/**
 * Decrypted credential value (in memory only, never stored).
 */
export type DecryptedCredentialValue =
  | {
      type: "secret_text";
      secret: string;
    }
  | {
      type: "basic_auth";
      username: string;
      password: string;
    }
  | {
      type: "oauth2";
      accessToken: string;
      refreshToken?: string;
      tokenType: string;
      scope?: string;
    }
  | {
      type: "custom_auth";
      fields: Record<string, string>;
    };

/**
 * Key-value store interface for connectors.
 */
export interface ConnectorStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<void>;
}

/**
 * Server context for connector operations.
 */
export interface ConnectorServerContext {
  /** Vortex API URL */
  apiUrl: string;
  /** Public webhook URL for this workflow */
  publicUrl: string;
}

/**
 * Result of executing a connector action.
 * Compatible with PluginCallResult for unified handling.
 */
export type ConnectorCallResult = PluginCallResult;
