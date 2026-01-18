/**
 * Database schema for vortex-worker.
 * Mirrors the tables from vortex-api that the worker needs access to.
 */

import {
  boolean,
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
  workspaceId: uuid("workspace_id").notNull(),
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
