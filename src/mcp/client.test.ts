/**
 * MCP Client Transport Selection Tests
 *
 * Verifies that the correct transport is instantiated based on the
 * `transport` field in `MCPServerConfig`.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "bun:test";

import { createTransport } from "./client";

describe("createTransport", () => {
  describe("stdio transport", () => {
    it("creates StdioClientTransport when transport is omitted", () => {
      const transport = createTransport({
        id: "server-1",
        name: "Test Server",
        command: "node",
        args: ["server.js"],
      });

      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    it("creates StdioClientTransport when transport is explicitly stdio", () => {
      const transport = createTransport({
        id: "server-2",
        name: "Test Server",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp-server"],
        env: { API_KEY: "test" },
        cwd: "/tmp",
      });

      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    it("throws when command is missing for stdio transport", () => {
      expect(() =>
        createTransport({
          id: "server-3",
          name: "Test Server",
          transport: "stdio",
        }),
      ).toThrow("command required for stdio transport");
    });
  });

  describe("SSE transport", () => {
    it("creates SSEClientTransport when transport is sse", () => {
      const transport = createTransport({
        id: "server-4",
        name: "SSE Server",
        transport: "sse",
        url: "https://example.com/mcp/sse",
        headers: { Authorization: "Bearer token" },
      });

      expect(transport).toBeInstanceOf(SSEClientTransport);
    });

    it("creates SSEClientTransport without headers when headers is omitted", () => {
      const transport = createTransport({
        id: "server-5",
        name: "SSE Server",
        transport: "sse",
        url: "https://example.com/mcp/sse",
      });

      expect(transport).toBeInstanceOf(SSEClientTransport);
    });

    it("throws when url is missing for SSE transport", () => {
      expect(() =>
        createTransport({
          id: "server-6",
          name: "SSE Server",
          transport: "sse",
        }),
      ).toThrow("url required for SSE transport");
    });
  });

  describe("HTTP transport", () => {
    it("creates StreamableHTTPClientTransport when transport is http", () => {
      const transport = createTransport({
        id: "server-7",
        name: "HTTP Server",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Api-Key": "secret" },
      });

      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    });

    it("creates StreamableHTTPClientTransport without headers when headers is omitted", () => {
      const transport = createTransport({
        id: "server-8",
        name: "HTTP Server",
        transport: "http",
        url: "https://example.com/mcp",
      });

      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    });

    it("throws when url is missing for HTTP transport", () => {
      expect(() =>
        createTransport({
          id: "server-9",
          name: "HTTP Server",
          transport: "http",
        }),
      ).toThrow("url required for HTTP transport");
    });
  });
});
