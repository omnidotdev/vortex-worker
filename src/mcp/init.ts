/**
 * MCP Server Initialization
 *
 * Fetches enabled MCP servers from the database and connects to them on startup.
 */

import { eq } from "drizzle-orm";

import logger from "lib/logger";
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

    // Connect to each server
    const connectionResults = await Promise.allSettled(
      servers.map(async (server) => {
        const config: MCPServerConfig = {
          id: server.id,
          name: server.name,
          transport:
            (server.transport as MCPServerConfig["transport"]) ?? "stdio",
          command: server.command ?? undefined,
          args: server.args as string[],
          env: server.env as Record<string, string>,
          cwd: server.cwd ?? undefined,
          url: server.url ?? undefined,
          headers: (server.headers as Record<string, string>) ?? undefined,
          enabled: server.isEnabled,
        };
        await mcpClient.connect(config);

        return { id: server.id, name: server.name };
      }),
    );

    // Log results
    const successful = connectionResults.filter(
      (r) => r.status === "fulfilled",
    );
    const failed = connectionResults.filter((r) => r.status === "rejected");

    if (successful.length > 0) {
      const servers = successful
        .filter(
          (r): r is PromiseFulfilledResult<{ id: string; name: string }> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      logger.info("MCP servers connected", { count: successful.length, servers });
    }

    if (failed.length > 0) {
      const reasons = failed
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason));
      logger.error("Failed to connect to MCP server(s)", {
        count: failed.length,
        reasons,
      });
    }
  } catch (error) {
    logger.error("Failed to initialize MCP servers", {
      error: error instanceof Error ? error.message : String(error),
    });
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
      logger.error("MCP server not found", { serverId });
      return false;
    }

    if (!server.isEnabled) {
      logger.error("MCP server is disabled", { serverId });
      return false;
    }

    const config: MCPServerConfig = {
      id: server.id,
      name: server.name,
      transport: (server.transport as MCPServerConfig["transport"]) ?? "stdio",
      command: server.command ?? undefined,
      args: server.args as string[],
      env: server.env as Record<string, string>,
      cwd: server.cwd ?? undefined,
      url: server.url ?? undefined,
      headers: (server.headers as Record<string, string>) ?? undefined,
      enabled: server.isEnabled,
    };

    await mcpClient.connect(config);
    return true;
  } catch (error) {
    logger.error("Failed to connect to MCP server", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
