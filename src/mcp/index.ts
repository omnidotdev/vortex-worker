/**
 * MCP (Model Context Protocol) Integration
 *
 * Provides access to 280+ Activepieces integrations and any
 * MCP-compatible tool server.
 */

export { authorizeMCPServer, ensureMCPServerForOrg } from "./access";
export { MCPIntegrationClient, getMCPClient, resetMCPClient } from "./client";
export { initializeMCPServers } from "./init";

export type {
  MCPContent,
  MCPServerConfig,
  MCPServerInfo,
  MCPServerStatus,
  MCPTool,
  MCPToolProperty,
  MCPToolResult,
} from "./types";
