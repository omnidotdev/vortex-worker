/**
 * MCP server tenancy and transport policy.
 *
 * MCP server rows are created by org admins through vortex-api, and the worker
 * used to connect every enabled row at boot and any row by id on demand, with
 * no org check. A stdio row's `command` is spawned inside the worker pod, so a
 * tenant could run arbitrary commands next to the worker's secrets, and any
 * workflow could call another org's server by guessing its id.
 *
 * Policy enforced here, on every MCP use:
 * - a workflow may only use a server owned by its own organization
 * - stdio (a local process spawned in the worker) is reserved for the platform
 *   org; tenants may only use remote transports (sse, http)
 * - a tenant's remote URL must pass the SSRF guard (no internal addresses)
 */

import { and, eq } from "drizzle-orm";

import { VORTEX_PLATFORM_ORG_ID } from "lib/config/env.config";
import { MCPError } from "lib/errors";
import logger from "lib/logger";
import { assertSafeResolvedUrl } from "lib/ssrf";
import { db, schema } from "../db";
import { getMCPClient } from "./client";

import type { MCPServerConfig } from "./types";

/** The subset of an `mcp_server` row the policy needs */
export type MCPServerRecord = {
  id: string;
  organizationId: string;
  name: string;
  transport: string | null;
  command: string | null;
  args: unknown;
  env: unknown;
  cwd: string | null;
  url: string | null;
  headers: unknown;
  isEnabled: boolean;
};

const REMOTE_TRANSPORTS = new Set(["sse", "http"]);

export type MCPAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether a workflow in `organizationId` may use `server`.
 * Fails closed on any missing id
 */
export function authorizeMCPServer(
  server: MCPServerRecord | undefined,
  organizationId: string | undefined,
  platformOrgId: string | undefined,
): MCPAccessDecision {
  if (!organizationId) {
    return { allowed: false, reason: "organization required for MCP access" };
  }
  if (!server) return { allowed: false, reason: "MCP server not found" };
  if (server.organizationId !== organizationId) {
    // Same message as a missing row so ids of other orgs are not confirmed
    return { allowed: false, reason: "MCP server not found" };
  }
  if (!server.isEnabled) {
    return { allowed: false, reason: "MCP server is disabled" };
  }

  const transport = server.transport ?? "stdio";
  const isPlatform = !!platformOrgId && server.organizationId === platformOrgId;

  if (!REMOTE_TRANSPORTS.has(transport) && !isPlatform) {
    return {
      allowed: false,
      reason: "only remote (sse or http) MCP servers are supported",
    };
  }

  return { allowed: true };
}

/** Build the client config for an authorized row */
export function toMCPServerConfig(server: MCPServerRecord): MCPServerConfig {
  return {
    id: server.id,
    name: server.name,
    transport: (server.transport as MCPServerConfig["transport"]) ?? "stdio",
    command: server.command ?? undefined,
    args: (server.args as string[]) ?? [],
    env: (server.env as Record<string, string>) ?? {},
    cwd: server.cwd ?? undefined,
    url: server.url ?? undefined,
    headers: (server.headers as Record<string, string>) ?? undefined,
    enabled: server.isEnabled,
  };
}

/** Injectable dependencies (tests) */
export type MCPAccessDeps = {
  loadServer: (
    serverId: string,
    organizationId: string,
  ) => Promise<MCPServerRecord | undefined>;
  client: {
    isConnected: (serverId: string) => boolean;
    connect: (config: MCPServerConfig) => Promise<void>;
  };
  platformOrgId: string | undefined;
  assertSafeUrl: (url: string) => Promise<unknown>;
};

const loadServerFromDb = async (
  serverId: string,
  organizationId: string,
): Promise<MCPServerRecord | undefined> => {
  const [server] = await db
    .select()
    .from(schema.mcpServerTable)
    .where(
      and(
        eq(schema.mcpServerTable.id, serverId),
        eq(schema.mcpServerTable.organizationId, organizationId),
      ),
    )
    .limit(1);

  return server;
};

const defaultDeps = (): MCPAccessDeps => ({
  loadServer: loadServerFromDb,
  client: getMCPClient(),
  platformOrgId: VORTEX_PLATFORM_ORG_ID,
  assertSafeUrl: assertSafeResolvedUrl,
});

/**
 * Authorize `serverId` for `organizationId` and make sure it is connected.
 * Must run before every MCP tool call or tool listing, even when the server
 * is already connected, because the connection pool is shared by all orgs.
 * Throws an MCPError when access is denied or the connection fails
 */
export async function ensureMCPServerForOrg(
  serverId: string,
  organizationId: string | undefined,
  deps: MCPAccessDeps = defaultDeps(),
): Promise<void> {
  if (!serverId) throw new MCPError("MCP server id required");

  const server = organizationId
    ? await deps.loadServer(serverId, organizationId)
    : undefined;
  const decision = authorizeMCPServer(
    server,
    organizationId,
    deps.platformOrgId,
  );

  if (!decision.allowed || !server) {
    logger.warn("MCP server access denied", {
      serverId,
      organizationId,
      reason: decision.allowed ? "not found" : decision.reason,
    });
    throw new MCPError(
      decision.allowed ? "MCP server not found" : decision.reason,
      { serverId },
    );
  }

  if (deps.client.isConnected(serverId)) return;

  const isPlatform =
    !!deps.platformOrgId && server.organizationId === deps.platformOrgId;
  if (!isPlatform && server.url) {
    try {
      await deps.assertSafeUrl(server.url);
    } catch {
      throw new MCPError("MCP server URL is not allowed", { serverId });
    }
  }

  try {
    await deps.client.connect(toMCPServerConfig(server));
  } catch (error) {
    logger.error("Failed to connect to MCP server", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new MCPError("MCP server not available", { serverId });
  }
}
