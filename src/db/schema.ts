/**
 * Database schema for vortex-worker.
 * Mirrors the tables from vortex-api that the worker needs access to.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * MCP Server table - stores MCP server configurations per workspace.
 */
export const mcpServerTable = pgTable("mcp_server", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  type: text().notNull().default("custom"),
  transport: text().default("stdio"),
  command: text(),
  args: jsonb().notNull().default([]),
  env: jsonb().notNull().default({}),
  cwd: text(),
  url: text(),
  headers: jsonb(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type McpServer = typeof mcpServerTable.$inferSelect;
export type NewMcpServer = typeof mcpServerTable.$inferInsert;

/**
 * Integration table - stores organization integration configurations.
 */
export const integrationTable = pgTable(
  "integration",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    definitionId: text("definition_id"),
    mcpServerId: uuid("mcp_server_id"),
    type: text().notNull(),
    name: text().notNull(),
    isEnabled: boolean("is_enabled").default(false).notNull(),
    config: jsonb().notNull().default({}),
    authMethod: text("auth_method").notNull().default("manual"),
    oauthStatus: text("oauth_status"),
    oauthConnectedAt: timestamp("oauth_connected_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("integration_organization_id_idx").on(table.organizationId),
  ],
);

export type Integration = typeof integrationTable.$inferSelect;

/**
 * OAuth Token table - stores OAuth2 access and refresh tokens.
 */
export const oauthTokenTable = pgTable(
  "oauth_token",
  {
    id: uuid().primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull(),
    organizationId: text("organization_id").notNull(),
    provider: text().notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type").notNull().default("Bearer"),
    scope: text().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("oauth_token_integration_id_idx").on(table.integrationId),
    index("oauth_token_expires_at_idx").on(table.expiresAt),
  ],
);

export type OAuthToken = typeof oauthTokenTable.$inferSelect;

/**
 * Workflow table - stores workflow definitions.
 * Mirrored from vortex-api for subworkflow lookup.
 */
export const workflowTable = pgTable("workflow", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  definition: jsonb().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  version: integer().default(1).notNull(),
});

export type Workflow = typeof workflowTable.$inferSelect;

/**
 * Workflow version history table - stores definition snapshots per version.
 * Mirrored from vortex-api for version lookup in the worker.
 */
export const workflowVersionTable = pgTable(
  "workflow_version",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflowTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    definition: jsonb().notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    changeNote: text("change_note"),
  },
  (table) => [
    index("workflow_version_workflow_id_idx").on(table.workflowId),
    index("workflow_version_workflow_version_idx").on(
      table.workflowId,
      table.version,
    ),
  ],
);

export type WorkflowVersion = typeof workflowVersionTable.$inferSelect;

/**
 * Event routing rule table - maps incoming events to workflows.
 * Mirrored from vortex-api for event routing in the worker.
 */
export const eventRoutingRuleTable = pgTable(
  "event_routing_rule",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflowTable.id, { onDelete: "cascade" }),
    sourcePattern: text("source_pattern"),
    typePattern: text("type_pattern").notNull(),
    condition: text(),
    celCondition: text("cel_condition"),
    batch: jsonb(),
    transform: text(),
    priority: integer().notNull().default(0),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("event_routing_rule_org_idx").on(table.organizationId),
    index("event_routing_rule_workflow_idx").on(table.workflowId),
    index("event_routing_rule_enabled_idx").on(table.enabled),
    index("event_routing_rule_lookup_idx").on(
      table.organizationId,
      table.enabled,
      table.priority,
    ),
  ],
);

export type EventRoutingRule = typeof eventRoutingRuleTable.$inferSelect;

/**
 * Workflow run table - tracks workflow executions.
 */
export const workflowRunTable = pgTable(
  "workflow_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").references(() => workflowTable.id, {
      onDelete: "cascade",
    }),
    engineWorkflowId: text("engine_workflow_id").notNull(),
    engineRunId: text("engine_run_id").notNull(),
    status: text().notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    input: jsonb(),
    output: jsonb(),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workflow_run_workflow_id_idx").on(table.workflowId),
    index("workflow_run_status_idx").on(table.status),
    index("workflow_run_engine_workflow_id_idx").on(table.engineWorkflowId),
  ],
);

export type WorkflowRun = typeof workflowRunTable.$inferSelect;
export type NewWorkflowRun = typeof workflowRunTable.$inferInsert;

/**
 * Workflow step log table - detailed step-level execution tracking.
 */
export const workflowStepLogTable = pgTable(
  "workflow_step_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRunTable.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    stepType: text("step_type").notNull(),
    stepName: text("step_name").notNull(),
    status: text().notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    input: jsonb(),
    output: jsonb(),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("workflow_step_log_run_id_idx").on(table.workflowRunId),
    index("workflow_step_log_step_id_idx").on(table.stepId),
    index("workflow_step_log_status_idx").on(table.status),
  ],
);

export type WorkflowStepLog = typeof workflowStepLogTable.$inferSelect;
export type NewWorkflowStepLog = typeof workflowStepLogTable.$inferInsert;

/**
 * Event log table - mirrored from vortex-api for logging incoming events.
 */
export const eventLogTable = pgTable("event_log", {
  id: uuid().primaryKey().defaultRandom(),
  type: text().notNull(),
  source: text().notNull(),
  subject: text(),
  organizationId: text("organization_id").notNull(),
  data: jsonb().notNull().default({}),
  correlationId: text("correlation_id"),
  schemaId: text("schema_id"),
  timestamp: text().notNull(),
  /** CloudEvents spec version */
  specversion: text().default("1.0"),
  /** URI to the event's JSON Schema definition in the registry */
  dataschema: text(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Outbox table - transactional outbox for reliable event publishing.
 * Mirrored from vortex-api for sweeper reads/updates in the worker.
 */
export const outboxTable = pgTable(
  "outbox",
  {
    id: uuid().primaryKey().defaultRandom(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("outbox_pending_idx").on(table.publishedAt),
    index().on(table.createdAt),
  ],
);

export type OutboxRow = typeof outboxTable.$inferSelect;

/**
 * Plugin table - mirrors vortex-api's plugin registry.
 */
export const pluginTable = pgTable(
  "plugin",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text().notNull(),
    description: text(),
    version: text().notNull(),
    manifest: jsonb().notNull(),
    wasmUrl: text("wasm_url").notNull(),
    wasmHash: text("wasm_hash").notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    isVerified: boolean("is_verified").default(false).notNull(),
    edgeCapable: boolean("edge_capable").default(false),
    config: jsonb().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("plugin_org_id_idx").on(table.organizationId),
    index("plugin_name_idx").on(table.name),
    index("plugin_is_enabled_idx").on(table.isEnabled),
  ],
);

export type Plugin = typeof pluginTable.$inferSelect;

/**
 * Plugin usage table - mirrors vortex-api's usage tracking table.
 */
export const pluginUsageTable = pgTable(
  "plugin_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    workflowId: uuid("workflow_id"),
    runId: uuid("run_id"),
    functionName: text("function_name").notNull(),
    durationMs: integer("duration_ms").notNull(),
    success: boolean().notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("plugin_usage_plugin_id_idx").on(table.pluginId),
    index("plugin_usage_org_id_idx").on(table.organizationId),
    index("plugin_usage_executed_at_idx").on(table.executedAt),
  ],
);

export type PluginUsage = typeof pluginUsageTable.$inferSelect;
export type NewPluginUsage = typeof pluginUsageTable.$inferInsert;

/**
 * Dead letter event table - stores failed routing events for retry/debugging.
 * Mirrored from vortex-api for DLQ writes in the worker.
 */
export const deadLetterEventTable = pgTable(
  "dead_letter_event",
  {
    id: uuid().primaryKey().defaultRandom(),
    originalEventId: text("original_event_id").notNull(),
    eventType: text("event_type").notNull(),
    eventSource: text("event_source").notNull(),
    eventData: jsonb("event_data").notNull(),
    error: text().notNull(),
    errorCode: text("error_code").notNull(),
    routingRuleId: uuid("routing_rule_id")
      .notNull()
      .references(() => eventRoutingRuleTable.id, { onDelete: "cascade" }),
    attempts: integer().notNull().default(1),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("dead_letter_event_org_idx").on(table.organizationId),
    index("dead_letter_event_resolved_idx").on(table.resolvedAt),
    index("dead_letter_event_type_idx").on(table.eventType),
  ],
);

export type DeadLetterEvent = typeof deadLetterEventTable.$inferSelect;

/**
 * Event schema catalog table - mirrors vortex-api's event_schema table.
 * Used by the router for payload validation at routing time.
 */
export const eventSchemaTable = pgTable("event_schema", {
  id: uuid().primaryKey().defaultRandom(),
  /** Dot-separated event name, e.g. "synapse.provider.health_changed" */
  name: text().notNull(),
  /** Service that emits this event, e.g. "synapse-api" */
  source: text().notNull(),
  description: text(),
  /** JSON Schema for the OmniEvent `data` field */
  payloadSchema: jsonb(),
  /** Enforcement level: strict (reject invalid), warn (log), none (skip) */
  enforcement: text().notNull().default("warn"),
  /** Monotonic version number */
  version: integer().notNull().default(1),
  /** Schema evolution mode: backward, forward, full, none */
  compatibilityMode: text("compatibility_mode").notNull().default("backward"),
  /** FK to previous version of this schema (self-referential) */
  previousVersionId: uuid("previous_version_id"),
  /** JSONata expression for migrating data between versions */
  migrationTransform: text("migration_transform"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type EventSchema = typeof eventSchemaTable.$inferSelect;

/**
 * Approval request table - stores gate-step approval/signal/manual requests.
 * Mirrored from vortex-api for gate plugin reads/writes in the worker.
 */
export const approvalRequestTable = pgTable(
  "approval_request",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflowTable.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    gateType: text("gate_type").notNull(),
    title: text(),
    approvers: jsonb().$type<string[]>(),
    status: text().default("pending").notNull(),
    decidedBy: text("decided_by"),
    reason: text(),
    signalName: text("signal_name"),
    signalData: jsonb("signal_data"),
    timeoutMs: text("timeout_ms"),
    timeoutAction: text("timeout_action").default("reject"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("approval_request_org_idx").on(table.organizationId),
    index("approval_request_run_step_idx").on(table.runId, table.stepId),
    index("approval_request_status_idx").on(table.status),
  ],
);

export type ApprovalRequest = typeof approvalRequestTable.$inferSelect;
export type NewApprovalRequest = typeof approvalRequestTable.$inferInsert;

/**
 * Rivet Graph table - stores Rivet AI agent graph definitions.
 * Mirrored from vortex-api for graph lookup in the executor.
 */
export const rivetGraphTable = pgTable(
  "rivet_graph",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text().notNull(),
    description: text(),
    graphJson: jsonb("graph_json").notNull(),
    version: integer().default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("rivet_graph_organization_id_idx").on(table.organizationId),
  ],
);

export type RivetGraph = typeof rivetGraphTable.$inferSelect;

/**
 * Saga run table - tracks distributed transaction executions.
 * Mirrored from vortex-api for saga executor writes in the worker.
 */
export const sagaRunTable = pgTable(
  "saga_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRunTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    status: text().notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("saga_run_workflow_run_id_idx").on(table.workflowRunId),
    index("saga_run_organization_id_idx").on(table.organizationId),
    index("saga_run_status_idx").on(table.status),
  ],
);

export type SagaRun = typeof sagaRunTable.$inferSelect;
export type NewSagaRun = typeof sagaRunTable.$inferInsert;

/**
 * Saga step log table - tracks individual execute/compensate step pairs.
 * Mirrored from vortex-api for saga executor writes in the worker.
 */
export const sagaStepLogTable = pgTable(
  "saga_step_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    sagaRunId: uuid("saga_run_id")
      .notNull()
      .references(() => sagaRunTable.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    executeStatus: text("execute_status").notNull().default("pending"),
    compensateStatus: text("compensate_status").notNull().default("pending"),
    executeInput: jsonb("execute_input").default({}),
    executeOutput: jsonb("execute_output"),
    compensateInput: jsonb("compensate_input"),
    compensateOutput: jsonb("compensate_output"),
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("saga_step_log_saga_run_id_idx").on(table.sagaRunId),
    index("saga_step_log_idempotency_key_idx").on(table.idempotencyKey),
    index("saga_step_log_execute_status_idx").on(table.executeStatus),
  ],
);

export type SagaStepLog = typeof sagaStepLogTable.$inferSelect;
export type NewSagaStepLog = typeof sagaStepLogTable.$inferInsert;

/**
 * Event subscription table - webhook delivery subscriptions.
 * Mirrored from vortex-api for subscription matching in the router.
 */
export const eventSubscriptionTable = pgTable(
  "event_subscription",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text().notNull(),
    description: text(),
    sourcePattern: text("source_pattern"),
    typePattern: text("type_pattern").notNull(),
    targetUrl: text("target_url").notNull(),
    hmacSecret: text("hmac_secret").notNull(),
    signatureHeader: text("signature_header").notNull().default("x-vortex-signature"),
    transform: text(),
    payloadMode: text("payload_mode").notNull().default("data"),
    maxRetries: integer("max_retries").notNull().default(5),
    initialBackoffMs: integer("initial_backoff_ms").notNull().default(1000),
    backoffMultiplier: integer("backoff_multiplier").notNull().default(2),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("event_subscription_org_idx").on(table.organizationId),
    index("event_subscription_org_enabled_idx").on(
      table.organizationId,
      table.enabled,
    ),
  ],
);

export type EventSubscription = typeof eventSubscriptionTable.$inferSelect;

/**
 * Subscription delivery table - tracks webhook delivery attempts.
 * Mirrored from vortex-api for delivery engine writes in the worker.
 */
export const subscriptionDeliveryTable = pgTable(
  "subscription_delivery",
  {
    id: uuid().primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => eventSubscriptionTable.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    organizationId: text("organization_id").notNull(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    httpStatus: integer("http_status"),
    error: text(),
    nextRetryAt: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("subscription_delivery_sub_idx").on(table.subscriptionId),
    index("subscription_delivery_status_retry_idx").on(
      table.status,
      table.nextRetryAt,
    ),
    index("subscription_delivery_org_idx").on(table.organizationId),
  ],
);

export type SubscriptionDelivery = typeof subscriptionDeliveryTable.$inferSelect;
export type NewSubscriptionDelivery = typeof subscriptionDeliveryTable.$inferInsert;
