/**
 * MCP tenancy and transport security tests.
 *
 * Tenants could register a stdio MCP server whose `command` the worker spawned
 * in its own pod (at boot, for every enabled row), and any workflow could use
 * another org's server by id. These tests assert that a workflow can only use
 * its own org's servers, that stdio is reserved for the platform org, that a
 * tenant's remote URL must pass the SSRF guard, and that every MCP call site
 * authorizes before use
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { authorizeMCPServer, ensureMCPServerForOrg } from "../mcp/access";

import type { MCPAccessDeps, MCPServerRecord } from "../mcp/access";
import type { MCPServerConfig } from "../mcp/types";

const PLATFORM_ORG = "33880602-cf32-4d8d-8db3-a4a9994c5d45";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const row = (overrides: Partial<MCPServerRecord> = {}): MCPServerRecord => ({
  id: "server-1",
  organizationId: TENANT_A,
  name: "Server",
  transport: "http",
  command: null,
  args: [],
  env: {},
  cwd: null,
  url: "https://mcp.example.com/mcp",
  headers: null,
  isEnabled: true,
  ...overrides,
});

const stdioRow = (organizationId: string) =>
  row({
    organizationId,
    transport: "stdio",
    command: "sh",
    args: ["-c", "env"],
    url: null,
  });

describe("authorizeMCPServer", () => {
  it("denies a server owned by another org", () => {
    const decision = authorizeMCPServer(row(), TENANT_B, PLATFORM_ORG);
    expect(decision.allowed).toBe(false);
  });

  it("denies when the workflow org is unknown", () => {
    expect(authorizeMCPServer(row(), undefined, PLATFORM_ORG).allowed).toBe(
      false,
    );
    expect(authorizeMCPServer(row(), "", PLATFORM_ORG).allowed).toBe(false);
  });

  it("denies stdio (and the stdio default) for tenant servers", () => {
    expect(
      authorizeMCPServer(stdioRow(TENANT_A), TENANT_A, PLATFORM_ORG).allowed,
    ).toBe(false);
    expect(
      authorizeMCPServer(
        row({ transport: null, command: "sh" }),
        TENANT_A,
        PLATFORM_ORG,
      ).allowed,
    ).toBe(false);
    expect(
      authorizeMCPServer(
        row({ transport: "anything-else" }),
        TENANT_A,
        PLATFORM_ORG,
      ).allowed,
    ).toBe(false);
  });

  it("denies tenant stdio even when the platform org is unset", () => {
    expect(
      authorizeMCPServer(stdioRow(TENANT_A), TENANT_A, undefined).allowed,
    ).toBe(false);
  });

  it("allows a tenant's own enabled remote server", () => {
    for (const transport of ["http", "sse"]) {
      expect(
        authorizeMCPServer(row({ transport }), TENANT_A, PLATFORM_ORG).allowed,
      ).toBe(true);
    }
  });

  it("denies a disabled server", () => {
    expect(
      authorizeMCPServer(row({ isEnabled: false }), TENANT_A, PLATFORM_ORG)
        .allowed,
    ).toBe(false);
  });

  it("keeps platform-org stdio servers working", () => {
    expect(
      authorizeMCPServer(stdioRow(PLATFORM_ORG), PLATFORM_ORG, PLATFORM_ORG)
        .allowed,
    ).toBe(true);
  });
});

describe("ensureMCPServerForOrg", () => {
  const makeDeps = (
    servers: MCPServerRecord[],
    opts: { connected?: string[]; unsafeUrls?: string[] } = {},
  ) => {
    const connected = new Set(opts.connected ?? []);
    const connects: MCPServerConfig[] = [];
    const deps: MCPAccessDeps = {
      // Mirrors the real query: lookup is scoped by id AND org
      loadServer: async (id, org) =>
        servers.find((s) => s.id === id && s.organizationId === org),
      client: {
        isConnected: (id) => connected.has(id),
        connect: async (config) => {
          connects.push(config);
          connected.add(config.id);
        },
      },
      platformOrgId: PLATFORM_ORG,
      assertSafeUrl: async (url) => {
        if (opts.unsafeUrls?.includes(url)) throw new Error("blocked");
      },
    };
    return { deps, connects };
  };

  it("never spawns a tenant stdio server", async () => {
    const { deps, connects } = makeDeps([stdioRow(TENANT_A)]);

    await expect(
      ensureMCPServerForOrg("server-1", TENANT_A, deps),
    ).rejects.toThrow();
    expect(connects).toHaveLength(0);
  });

  it("refuses another org's server even when it is already connected", async () => {
    const { deps } = makeDeps([row({ organizationId: TENANT_A })], {
      connected: ["server-1"],
    });

    await expect(
      ensureMCPServerForOrg("server-1", TENANT_B, deps),
    ).rejects.toThrow("MCP server not found");
  });

  it("refuses when the workflow org is unknown", async () => {
    const { deps } = makeDeps([row()], { connected: ["server-1"] });

    await expect(
      ensureMCPServerForOrg("server-1", undefined, deps),
    ).rejects.toThrow();
  });

  it("refuses a tenant remote server whose URL fails the SSRF guard", async () => {
    const url = "http://vortex-api:4000/mcp";
    const { deps, connects } = makeDeps([row({ url })], { unsafeUrls: [url] });

    await expect(
      ensureMCPServerForOrg("server-1", TENANT_A, deps),
    ).rejects.toThrow("MCP server URL is not allowed");
    expect(connects).toHaveLength(0);
  });

  it("connects a tenant's own remote server", async () => {
    const { deps, connects } = makeDeps([row()]);

    await ensureMCPServerForOrg("server-1", TENANT_A, deps);
    expect(connects).toHaveLength(1);
    expect(connects[0]?.transport).toBe("http");
  });

  it("connects a platform stdio server for the platform org", async () => {
    const { deps, connects } = makeDeps([stdioRow(PLATFORM_ORG)]);

    await ensureMCPServerForOrg("server-1", PLATFORM_ORG, deps);
    expect(connects).toHaveLength(1);
  });
});

describe("MCP call sites", () => {
  const srcDir = join(import.meta.dir, "..");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return entry === "__tests__" ? [] : walk(path);
      }
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });

  it("authorize the org before every tool call or tool listing", () => {
    const offenders: string[] = [];

    for (const file of walk(srcDir)) {
      if (file.includes(`${join("src", "mcp")}`)) continue;
      const source = readFileSync(file, "utf8");
      if (!/getMCPClient\(\)/.test(source)) continue;

      const uses = (source.match(/mcpClient\.(callTool|listTools)\(/g) ?? [])
        .length;
      const checks = (source.match(/ensureMCPServerForOrg\(/g) ?? []).length;
      if (uses > 0 && checks === 0) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("no longer exports the unscoped connect-by-id helper", async () => {
    const mcp = (await import("../mcp")) as Record<string, unknown>;
    expect(mcp.connectMCPServer).toBeUndefined();
  });
});
