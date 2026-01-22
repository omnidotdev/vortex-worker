/**
 * Connector Executor
 *
 * Executes Activepieces piece actions and triggers within Vortex.
 * Provides the runtime context that pieces expect.
 */

import { getConnector, loadConnector } from "./registry";

import type { Store, StoreScope } from "@activepieces/pieces-framework";
import type { ExecutionType } from "@activepieces/shared";
import type { PluginContext } from "../plugins/types";
import type {
  ConnectorCallResult,
  ConnectorContext,
  ConnectorStore,
  DecryptedCredentialValue,
} from "./types";

/**
 * Create a store implementation for connector execution.
 */
function createStore(
  _workflowId: string,
  _runId: string,
): ConnectorStore & Store {
  // In-memory store for now - should be backed by Redis/DB in production
  const flowStore = new Map<string, unknown>();
  const projectStore = new Map<string, unknown>();

  const store: ConnectorStore & Store = {
    async get<T>(key: string, scope?: StoreScope): Promise<T | null> {
      const targetStore = scope === "COLLECTION" ? projectStore : flowStore;
      return (targetStore.get(key) as T) ?? null;
    },
    async put<T>(key: string, value: T, scope?: StoreScope): Promise<T> {
      const targetStore = scope === "COLLECTION" ? projectStore : flowStore;
      targetStore.set(key, value);
      return value;
    },
    async delete(key: string, scope?: StoreScope): Promise<void> {
      const targetStore = scope === "COLLECTION" ? projectStore : flowStore;
      targetStore.delete(key);
    },
  };

  return store;
}

/**
 * Convert decrypted credentials to Activepieces auth format.
 */
function toActivepiecesAuth(
  auth: DecryptedCredentialValue | undefined,
): unknown {
  if (!auth) return undefined;

  switch (auth.type) {
    case "secret_text":
      return auth.secret;
    case "basic_auth":
      return {
        username: auth.username,
        password: auth.password,
      };
    case "oauth2":
      return {
        access_token: auth.accessToken,
        refresh_token: auth.refreshToken,
        token_type: auth.tokenType,
        scope: auth.scope,
      };
    case "custom_auth":
      return auth.fields;
    default:
      return undefined;
  }
}

/**
 * Build Activepieces ActionContext from Vortex context.
 * Returns 'any' because the Activepieces types are complex union types
 * and we only implement the subset that pieces actually use.
 */
// biome-ignore lint/suspicious/noExplicitAny: Activepieces context types are complex unions
function buildActionContext(connectorContext: ConnectorContext): any {
  const store = createStore(
    connectorContext.workflowId,
    connectorContext.runId,
  );

  // Build a minimal ActionContext that Activepieces pieces expect
  // Using 'as any' casts because the Activepieces types are complex and
  // we only need to provide the subset of context that pieces actually use
  const context = {
    // Execution type - always BEGIN for now (RESUME for paused flows)
    executionType: "BEGIN" as ExecutionType,

    // Auth credentials
    // biome-ignore lint/suspicious/noExplicitAny: Activepieces auth type varies by piece
    auth: toActivepiecesAuth(connectorContext.auth) as any,

    // User-configured property values
    propsValue: connectorContext.propsValue,

    // Key-value store
    store,

    // Project context
    project: {
      id: connectorContext.workflowId,
      externalId: async () => connectorContext.workflowId,
    },

    // Flow context
    flows: {
      current: {
        id: connectorContext.workflowId,
        version: { id: "1" },
      },
      list: async () => ({
        data: [],
        cursor: null,
        next: null,
        previous: null,
      }),
    },

    // Step context
    step: {
      name: connectorContext.stepId,
    },

    // Server context for API calls
    server: {
      apiUrl: connectorContext.server.apiUrl,
      publicUrl: connectorContext.server.publicUrl,
      token: "", // Not needed for action execution
    },

    // Run context with flow control hooks
    run: {
      id: connectorContext.runId,
      stop: () => {
        throw new Error("Flow stopped");
      },
      pause: () => {
        throw new Error("Flow pausing not yet supported");
      },
      respond: () => {
        // No-op for async flows
      },
    },

    // Connections manager (for accessing other credentials)
    connections: {
      get: async () => null,
    },

    // Tags manager
    tags: {
      add: async () => {},
    },

    // File service
    files: {
      write: async ({
        fileName,
        data: _data,
      }: {
        fileName: string;
        data: Buffer;
      }) => {
        // TODO: Implement file storage
        return `file://${fileName}`;
      },
    },

    // Output context
    output: {
      update: async () => {},
    },

    // Agent context (for AI tools)
    agent: {
      tools: async () => ({}),
    },

    // Generate resume URL for human-in-the-loop
    generateResumeUrl: () => {
      return `${connectorContext.server.publicUrl}/resume/${connectorContext.runId}`;
    },
    // biome-ignore lint/suspicious/noExplicitAny: Activepieces types are complex union types
  } as any;

  return context;
}

/**
 * Execute a connector action.
 */
export async function executeConnectorAction(
  connectorId: string,
  actionName: string,
  inputs: Record<string, unknown>,
  pluginContext?: PluginContext,
  auth?: DecryptedCredentialValue,
): Promise<ConnectorCallResult> {
  const startTime = performance.now();

  try {
    // Load connector if not already loaded
    let connector = getConnector(connectorId);
    if (!connector) {
      const loaded = await loadConnector(connectorId);
      if (!loaded) {
        return {
          success: false,
          error: `Connector not found: ${connectorId}`,
          durationMs: performance.now() - startTime,
        };
      }
      connector = loaded;
    }

    // Get the action
    const action = connector.piece.getAction(actionName);
    if (!action) {
      return {
        success: false,
        error: `Action not found: ${actionName} in connector ${connectorId}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Build connector context
    const connectorContext: ConnectorContext = {
      workflowId: pluginContext?.workflowId ?? "unknown",
      runId: pluginContext?.runId ?? "unknown",
      stepId: pluginContext?.stepId ?? actionName,
      config: pluginContext?.config ?? {},
      secrets: pluginContext?.secrets ?? {},
      auth,
      propsValue: inputs,
      store: createStore(
        pluginContext?.workflowId ?? "unknown",
        pluginContext?.runId ?? "unknown",
      ),
      server: {
        apiUrl: process.env.VORTEX_API_URL ?? "http://localhost:3001",
        publicUrl: process.env.VORTEX_PUBLIC_URL ?? "http://localhost:3001",
      },
    };

    // Build Activepieces context
    const actionContext = buildActionContext(connectorContext);

    // Execute the action
    const result = await action.run(actionContext);

    return {
      success: true,
      output: result as Record<string, unknown>,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
}

/**
 * Execute a connector trigger's test/run function.
 * Used for polling triggers to fetch new events.
 */
export async function executeConnectorTrigger(
  connectorId: string,
  triggerName: string,
  inputs: Record<string, unknown>,
  pluginContext?: PluginContext,
  auth?: DecryptedCredentialValue,
): Promise<ConnectorCallResult> {
  const startTime = performance.now();

  try {
    let connector = getConnector(connectorId);
    if (!connector) {
      const loaded = await loadConnector(connectorId);
      if (!loaded) {
        return {
          success: false,
          error: `Connector not found: ${connectorId}`,
          durationMs: performance.now() - startTime,
        };
      }
      connector = loaded;
    }

    const trigger = connector.piece.getTrigger(triggerName);
    if (!trigger) {
      return {
        success: false,
        error: `Trigger not found: ${triggerName} in connector ${connectorId}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Build context similar to actions
    const connectorContext: ConnectorContext = {
      workflowId: pluginContext?.workflowId ?? "unknown",
      runId: pluginContext?.runId ?? "unknown",
      stepId: pluginContext?.stepId ?? triggerName,
      config: pluginContext?.config ?? {},
      secrets: pluginContext?.secrets ?? {},
      auth,
      propsValue: inputs,
      store: createStore(
        pluginContext?.workflowId ?? "unknown",
        pluginContext?.runId ?? "unknown",
      ),
      server: {
        apiUrl: process.env.VORTEX_API_URL ?? "http://localhost:3001",
        publicUrl: process.env.VORTEX_PUBLIC_URL ?? "http://localhost:3001",
      },
    };

    const actionContext = buildActionContext(connectorContext);

    // Run the trigger's test or run function
    const triggerContext = {
      ...actionContext,
      webhookUrl: `${connectorContext.server.publicUrl}/webhooks/${connectorContext.workflowId}`,
      payload: { body: {}, headers: {}, queryParams: {} },
    };

    // Use test() if available, otherwise run()
    const testFn = trigger.test ?? trigger.run;
    // biome-ignore lint/suspicious/noExplicitAny: Trigger context type varies by trigger strategy
    const events = await testFn(triggerContext as any);

    return {
      success: true,
      output: { events: events as unknown[] },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
}

/**
 * Check if a plugin ID is a connector (Activepieces piece).
 */
export function isConnectorId(pluginId: string): boolean {
  return pluginId.startsWith("@activepieces/piece-");
}
