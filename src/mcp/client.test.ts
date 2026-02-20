/**
 * MCP Client Transport Selection Tests
 *
 * Verifies that the correct transport is instantiated based on the
 * `transport` field in `MCPServerConfig`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Track constructor call counts and arguments
let stdioCallCount = 0;
let stdioLastArgs: unknown[] = [];
let sseCallCount = 0;
let sseLastArgs: unknown[] = [];
let httpCallCount = 0;
let httpLastArgs: unknown[] = [];

function resetCounts() {
  stdioCallCount = 0;
  stdioLastArgs = [];
  sseCallCount = 0;
  sseLastArgs = [];
  httpCallCount = 0;
  httpLastArgs = [];
}

const mockTransport = {
  start: async () => {},
  close: async () => {},
  send: async () => {},
};

const mockClientInstance = {
  connect: async () => {},
  listTools: async () => ({ tools: [] }),
  close: async () => {},
};

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class StdioClientTransport {
    constructor(...args: unknown[]) {
      stdioCallCount++;
      stdioLastArgs = args;
      Object.assign(this, mockTransport);
    }
    start = mockTransport.start;
    close = mockTransport.close;
    send = mockTransport.send;
  },
}));

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class SSEClientTransport {
    constructor(...args: unknown[]) {
      sseCallCount++;
      sseLastArgs = args;
      Object.assign(this, mockTransport);
    }
    start = mockTransport.start;
    close = mockTransport.close;
    send = mockTransport.send;
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
    constructor(...args: unknown[]) {
      httpCallCount++;
      httpLastArgs = args;
      Object.assign(this, mockTransport);
    }
    start = mockTransport.start;
    close = mockTransport.close;
    send = mockTransport.send;
  },
}));

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class Client {
    connect = mockClientInstance.connect;
    listTools = mockClientInstance.listTools;
    close = mockClientInstance.close;
  },
}));

mock.module("lib/logger", () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

mock.module("lib/retry", () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

// Import after mocking
const { MCPIntegrationClient } = await import("./client");

describe("MCPIntegrationClient transport selection", () => {
  let client: InstanceType<typeof MCPIntegrationClient>;

  beforeEach(() => {
    client = new MCPIntegrationClient();
    resetCounts();
  });

  afterEach(async () => {
    await client.disconnectAll();
  });

  describe("stdio transport", () => {
    it("creates StdioClientTransport when transport is omitted", async () => {
      await client.connect({
        id: "server-1",
        name: "Test Server",
        command: "node",
        args: ["server.js"],
      });

      expect(stdioCallCount).toBe(1);
      expect(sseCallCount).toBe(0);
      expect(httpCallCount).toBe(0);
    });

    it("creates StdioClientTransport when transport is explicitly stdio", async () => {
      await client.connect({
        id: "server-2",
        name: "Test Server",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp-server"],
        env: { API_KEY: "test" },
        cwd: "/tmp",
      });

      expect(stdioCallCount).toBe(1);
      expect(stdioLastArgs[0]).toEqual({
        command: "npx",
        args: ["-y", "some-mcp-server"],
        env: { API_KEY: "test" },
        cwd: "/tmp",
      });
      expect(sseCallCount).toBe(0);
      expect(httpCallCount).toBe(0);
    });

    it("throws when command is missing for stdio transport", async () => {
      await expect(
        client.connect({
          id: "server-3",
          name: "Test Server",
          transport: "stdio",
        }),
      ).rejects.toThrow("command required for stdio transport");
    });
  });

  describe("SSE transport", () => {
    it("creates SSEClientTransport when transport is sse", async () => {
      await client.connect({
        id: "server-4",
        name: "SSE Server",
        transport: "sse",
        url: "https://example.com/mcp/sse",
        headers: { Authorization: "Bearer token" },
      });

      expect(sseCallCount).toBe(1);
      expect(sseLastArgs[0]).toEqual(new URL("https://example.com/mcp/sse"));
      expect(sseLastArgs[1]).toEqual({
        requestInit: { headers: { Authorization: "Bearer token" } },
      });
      expect(stdioCallCount).toBe(0);
      expect(httpCallCount).toBe(0);
    });

    it("creates SSEClientTransport without headers when headers is omitted", async () => {
      await client.connect({
        id: "server-5",
        name: "SSE Server",
        transport: "sse",
        url: "https://example.com/mcp/sse",
      });

      expect(sseCallCount).toBe(1);
      expect(sseLastArgs[1]).toEqual({
        requestInit: { headers: undefined },
      });
    });

    it("throws when url is missing for SSE transport", async () => {
      await expect(
        client.connect({
          id: "server-6",
          name: "SSE Server",
          transport: "sse",
        }),
      ).rejects.toThrow("url required for SSE transport");
    });
  });

  describe("HTTP transport", () => {
    it("creates StreamableHTTPClientTransport when transport is http", async () => {
      await client.connect({
        id: "server-7",
        name: "HTTP Server",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Api-Key": "secret" },
      });

      expect(httpCallCount).toBe(1);
      expect(httpLastArgs[0]).toEqual(new URL("https://example.com/mcp"));
      expect(httpLastArgs[1]).toEqual({
        requestInit: { headers: { "X-Api-Key": "secret" } },
      });
      expect(stdioCallCount).toBe(0);
      expect(sseCallCount).toBe(0);
    });

    it("creates StreamableHTTPClientTransport without headers when headers is omitted", async () => {
      await client.connect({
        id: "server-8",
        name: "HTTP Server",
        transport: "http",
        url: "https://example.com/mcp",
      });

      expect(httpCallCount).toBe(1);
      expect(httpLastArgs[1]).toEqual({
        requestInit: { headers: undefined },
      });
    });

    it("throws when url is missing for HTTP transport", async () => {
      await expect(
        client.connect({
          id: "server-9",
          name: "HTTP Server",
          transport: "http",
        }),
      ).rejects.toThrow("url required for HTTP transport");
    });
  });
});
