/**
 * Database schema for vortex-worker.
 * Mirrors the tables from vortex-api that the worker needs access to.
 */

import {
  boolean,
  index,
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
  command: text().notNull(),
  args: jsonb().notNull().default([]),
  env: jsonb().notNull().default({}),
  cwd: text(),
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
});

export type Workflow = typeof workflowTable.$inferSelect;

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
