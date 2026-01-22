/**
 * Vortex Connectors
 *
 * Service integrations powered by Activepieces pieces.
 * Provides 280+ pre-built connectors for services like Discord, Slack, GitHub, etc.
 *
 * Architecture:
 * - Registry: Loads and manages available connectors from npm packages
 * - Executor: Runs connector actions/triggers with proper context
 * - Types: Shared type definitions
 *
 * @example
 * ```typescript
 * import {
 *   loadConnector,
 *   executeConnectorAction,
 *   listConnectors,
 * } from "./connectors";
 *
 * // Load the Discord connector
 * await loadConnector("@activepieces/piece-discord");
 *
 * // Execute an action
 * const result = await executeConnectorAction(
 *   "@activepieces/piece-discord",
 *   "send_message_webhook",
 *   {
 *     webhook_url: "https://discord.com/api/webhooks/...",
 *     content: "Hello from Vortex!",
 *   }
 * );
 * ```
 */

// Executor - run connector actions/triggers
export {
  executeConnectorAction,
  executeConnectorTrigger,
  isConnectorId,
} from "./executor";
// Registry - load and list connectors
export {
  getConnector,
  getConnectorAction,
  getConnectorTrigger,
  isConnector,
  listConnectorIds,
  listConnectors,
  loadAllConnectors,
  loadConnector,
} from "./registry";

// Types
export type {
  ConnectorAction,
  ConnectorAuth,
  ConnectorAuthField,
  ConnectorAuthType,
  ConnectorCallResult,
  ConnectorContext,
  ConnectorCredential,
  ConnectorMetadata,
  ConnectorProperty,
  ConnectorPropertyOption,
  ConnectorPropertyType,
  ConnectorServerContext,
  ConnectorStore,
  ConnectorTrigger,
  DecryptedCredentialValue,
  EncryptedCredentialValue,
  LoadedConnector,
} from "./types";
