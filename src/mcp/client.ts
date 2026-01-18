/**
 * MCP Integration Client
 *
 * Manages connections to MCP servers and provides a unified
 * interface for discovering and calling tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  MCPContent,
  MCPServerConfig,
  MCPServerInfo,
  MCPServerStatus,
  MCPTool,
  MCPToolResult,
} from "./types";

export class MCPIntegrationClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  private serverInfo: Map<string, MCPServerInfo> = new Map();

  /**
   * Connect to an MCP server
   */
  async connect(config: MCPServerConfig): Promise<void> {
    // Disconnect existing connection if any
    if (this.clients.has(config.id)) {
      await this.disconnect(config.id);
    }

    this.updateStatus(config, "connecting");

    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });

      const client = new Client(
        { name: "vortex-worker", version: "1.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);

      this.clients.set(config.id, client);
      this.transports.set(config.id, transport);

      // Fetch available tools
      const tools = await this.fetchTools(config.id);

      this.serverInfo.set(config.id, {
        config,
        status: "connected",
        tools,
        connectedAt: new Date(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.serverInfo.set(config.id, {
        config,
        status: "error",
        tools: [],
        error: errorMessage,
      });
      throw new Error(
        `Failed to connect to MCP server ${config.id}: ${errorMessage}`,
      );
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    const transport = this.transports.get(serverId);

    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
      this.clients.delete(serverId);
    }

    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors
      }
      this.transports.delete(serverId);
    }

    const info = this.serverInfo.get(serverId);
    if (info) {
      this.serverInfo.set(serverId, {
        ...info,
        status: "disconnected",
        tools: [],
      });
    }
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const serverIds = Array.from(this.clients.keys());
    await Promise.all(serverIds.map((id) => this.disconnect(id)));
  }

  /**
   * List available tools from an MCP server
   */
  async listTools(serverId: string): Promise<MCPTool[]> {
    const info = this.serverInfo.get(serverId);
    if (info?.tools) {
      return info.tools;
    }
    return this.fetchTools(serverId);
  }

  /**
   * Fetch tools from an MCP server
   */
  private async fetchTools(serverId: string): Promise<MCPTool[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`MCP server ${serverId} not connected`);
    }

    const result = await client.listTools();

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as MCPTool["inputSchema"],
    }));
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const client = this.clients.get(serverId);
    if (!client) {
      return {
        success: false,
        error: `MCP server ${serverId} not connected`,
      };
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      const contentArray = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      const content: MCPContent[] = contentArray.map((c) => {
        if (c.type === "text") {
          return { type: "text" as const, text: c.text ?? "" };
        }
        if (c.type === "image") {
          return {
            type: "image" as const,
            data: c.data ?? "",
            mimeType: c.mimeType ?? "image/png",
          };
        }
        return { type: "resource" as const };
      });

      return {
        success: !result.isError,
        content,
        isError: result.isError ?? false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get information about a connected server
   */
  getServerInfo(serverId: string): MCPServerInfo | undefined {
    return this.serverInfo.get(serverId);
  }

  /**
   * Get all connected servers
   */
  getConnectedServers(): MCPServerInfo[] {
    return Array.from(this.serverInfo.values()).filter(
      (info) => info.status === "connected",
    );
  }

  /**
   * Check if a server is connected
   */
  isConnected(serverId: string): boolean {
    return this.serverInfo.get(serverId)?.status === "connected";
  }

  private updateStatus(config: MCPServerConfig, status: MCPServerStatus): void {
    const existing = this.serverInfo.get(config.id);
    this.serverInfo.set(config.id, {
      config,
      status,
      tools: existing?.tools || [],
      error: undefined,
    });
  }
}

// Singleton instance
let mcpClient: MCPIntegrationClient | null = null;

/**
 * Get the global MCP client instance
 */
export const getMCPClient = (): MCPIntegrationClient => {
  if (!mcpClient) {
    mcpClient = new MCPIntegrationClient();
  }
  return mcpClient;
};

/**
 * Reset the global MCP client (for testing)
 */
export const resetMCPClient = async (): Promise<void> => {
  if (mcpClient) {
    await mcpClient.disconnectAll();
    mcpClient = null;
  }
};
