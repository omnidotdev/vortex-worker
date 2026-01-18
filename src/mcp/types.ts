/**
 * MCP (Model Context Protocol) Types
 *
 * Types for integrating with MCP servers, enabling access to
 * 280+ Activepieces integrations and any MCP-compatible tool.
 */

/** Configuration for an MCP server */
export interface MCPServerConfig {
  /** Unique identifier for this server */
  id: string;
  /** Human-readable name */
  name: string;
  /** Command to start the server (e.g., "npx", "node") */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
  /** Working directory for the server */
  cwd?: string;
  /** Whether this server is enabled */
  enabled?: boolean;
}

/** Tool definition from an MCP server */
export interface MCPTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for input parameters */
  inputSchema: {
    type: "object";
    properties?: Record<string, MCPToolProperty>;
    required?: string[];
  };
}

/** Property definition in a tool's input schema */
export interface MCPToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/** Result of calling an MCP tool */
export interface MCPToolResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Result content (if success) */
  content?: MCPContent[];
  /** Error message (if failed) */
  error?: string;
  /** Whether the result is an error response from the tool itself */
  isError?: boolean;
}

/** Content block in an MCP response */
export interface MCPContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Status of an MCP server connection */
export type MCPServerStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** Information about a connected MCP server */
export interface MCPServerInfo {
  config: MCPServerConfig;
  status: MCPServerStatus;
  tools: MCPTool[];
  error?: string;
  connectedAt?: Date;
}
