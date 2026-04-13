/**
 * Built-in MCP Plugin
 *
 * Handles Model Context Protocol tool invocations.
 */

import { getMCPClient } from "../../mcp";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Call an MCP tool on a connected server.
 */
const callTool = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      serverId,
      tool,
      arguments: args = {},
    } = inputs as {
      serverId: string;
      tool: string;
      arguments?: Record<string, unknown>;
    };

    if (!serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!tool) {
      return {
        success: false,
        error: "Tool name is required",
        durationMs: performance.now() - startTime,
      };
    }

    const mcpClient = getMCPClient();

    // Check if server is connected
    if (!mcpClient.isConnected(serverId)) {
      return {
        success: false,
        error: `MCP server not connected: ${serverId}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Call the MCP tool
    const callResult = await mcpClient.callTool(serverId, tool, args);

    if (!callResult.success) {
      return {
        success: false,
        error: callResult.error || "MCP tool call failed",
        durationMs: performance.now() - startTime,
      };
    }

    // Extract text content from result
    const textContent = callResult.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Try to parse as JSON, otherwise use raw text
    let output: Record<string, unknown>;
    try {
      output = textContent ? JSON.parse(textContent) : {};
    } catch {
      output = { text: textContent };
    }

    return {
      success: true,
      output: {
        serverId,
        tool,
        result: output,
        isError: callResult.isError,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * List available tools on an MCP server.
 */
const listTools = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { serverId } = inputs as { serverId: string };

    if (!serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    const mcpClient = getMCPClient();

    if (!mcpClient.isConnected(serverId)) {
      return {
        success: false,
        error: `MCP server not connected: ${serverId}`,
        durationMs: performance.now() - startTime,
      };
    }

    const tools = await mcpClient.listTools(serverId);

    return {
      success: true,
      output: {
        serverId,
        tools,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const mcpPlugin: BuiltinPlugin = {
  id: "builtin:mcp",
  name: "MCP",
  description: "Model Context Protocol tool invocations",
  actions: {
    call: {
      name: "call",
      description: "Call an MCP tool",
      handler: callTool,
    },
    listTools: {
      name: "listTools",
      description: "List available tools on an MCP server",
      handler: listTools,
    },
  },
};
