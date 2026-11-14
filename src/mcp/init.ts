/**
 * MCP Server Initialization
 *
 * Connects the platform org's enabled MCP servers on startup. Tenant servers
 * are never connected at boot: they connect lazily, per workflow, through
 * `ensureMCPServerForOrg`, which enforces org ownership and remote-only
 * transports
 */

import { and, eq } from "drizzle-orm";

import { VORTEX_PLATFORM_ORG_ID } from "lib/config/env.config";
import logger from "lib/logger";
import { db, schema } from "../db";
import { authorizeMCPServer, toMCPServerConfig } from "./access";
import { getMCPClient } from "./client";

/**
 * Connect the platform org's enabled MCP servers at boot
 */
export async function initializeMCPServers(): Promise<void> {
  const mcpClient = getMCPClient();

  try {
    const servers = await db
      .select()
      .from(schema.mcpServerTable)
      .where(
        and(
          eq(schema.mcpServerTable.isEnabled, true),
          eq(schema.mcpServerTable.organizationId, VORTEX_PLATFORM_ORG_ID),
        ),
      );

    const connectionResults = await Promise.allSettled(
      servers.map(async (server) => {
        const decision = authorizeMCPServer(
          server,
          VORTEX_PLATFORM_ORG_ID,
          VORTEX_PLATFORM_ORG_ID,
        );
        if (!decision.allowed) {
          throw new Error(`${server.id}: ${decision.reason}`);
        }

        await mcpClient.connect(toMCPServerConfig(server));

        return { id: server.id, name: server.name };
      }),
    );

    const successful = connectionResults
      .filter(
        (r): r is PromiseFulfilledResult<{ id: string; name: string }> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);
    const failed = connectionResults
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));

    if (successful.length > 0) {
      logger.info("MCP servers connected", {
        count: successful.length,
        servers: successful,
      });
    }

    if (failed.length > 0) {
      logger.error("Failed to connect to MCP server(s)", {
        count: failed.length,
        reasons: failed,
      });
    }
  } catch (error) {
    logger.error("Failed to initialize MCP servers", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - allow worker to start even if MCP initialization fails
  }
}
