/**
 * MCP Server Initialization
 *
 * Fetches enabled MCP servers from the database and connects to them on startup.
 */

import { eq } from "drizzle-orm";

import { db, schema } from "../db";
import { getMCPClient } from "./client";

import type { MCPServerConfig } from "./types";

/**
 * Initialize MCP servers by connecting to all enabled servers from the database.
 */
export async function initializeMCPServers(): Promise<void> {
  const mcpClient = getMCPClient();

  try {
    // Fetch all enabled MCP servers from the database
    const servers = await db
      .select()
      .from(schema.mcpServerTable)
      .where(eq(schema.mcpServerTable.isEnabled, true));

    console.log(`Found ${servers.length} enabled MCP server(s) to connect`);

    // Connect to each server
    const connectionResults = await Promise.allSettled(
      servers.map(async (server) => {
        const config: MCPServerConfig = {
          id: server.id,
          name: server.name,
          command: server.command,
          args: server.args as string[],
          env: server.env as Record<string, string>,
          cwd: server.cwd ?? undefined,
          enabled: server.isEnabled,
        };

        console.log(`Connecting to MCP server: ${server.name} (${server.id})`);
        await mcpClient.connect(config);
        console.log(`Connected to MCP server: ${server.name}`);

        return { id: server.id, name: server.name };
      }),
    );

    // Log results
    const successful = connectionResults.filter(
      (r) => r.status === "fulfilled",
    );
    const failed = connectionResults.filter((r) => r.status === "rejected");

    if (successful.length > 0) {
      console.log(`Successfully connected to ${successful.length} MCP server(s)`);
    }

    if (failed.length > 0) {
      console.error(`Failed to connect to ${failed.length} MCP server(s):`);
      for (const result of failed) {
        if (result.status === "rejected") {
          console.error(`  - ${result.reason}`);
        }
      }
    }
  } catch (error) {
    console.error("Failed to initialize MCP servers:", error);
    // Don't throw - allow worker to start even if MCP initialization fails
  }
}

/**
 * Connect to a specific MCP server by ID.
 * Useful for on-demand connection when a workflow needs a specific server.
 */
export async function connectMCPServer(serverId: string): Promise<boolean> {
  const mcpClient = getMCPClient();

  // Check if already connected
  if (mcpClient.isConnected(serverId)) {
    return true;
  }

  try {
    // Fetch server config from database
    const [server] = await db
      .select()
      .from(schema.mcpServerTable)
      .where(eq(schema.mcpServerTable.id, serverId))
      .limit(1);

    if (!server) {
      console.error(`MCP server not found: ${serverId}`);
      return false;
    }

    if (!server.isEnabled) {
      console.error(`MCP server is disabled: ${serverId}`);
      return false;
    }

    const config: MCPServerConfig = {
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args as string[],
      env: server.env as Record<string, string>,
      cwd: server.cwd ?? undefined,
      enabled: server.isEnabled,
    };

    await mcpClient.connect(config);
    console.log(`Connected to MCP server on-demand: ${server.name}`);
    return true;
  } catch (error) {
    console.error(`Failed to connect to MCP server ${serverId}:`, error);
    return false;
  }
}
