/**
 * Agent plugin provider tests.
 *
 * Pins the default-provider path (no provider named: Synapse gateway, model
 * `auto`, the org's stored Synapse key as a Bearer token), that a step naming
 * a vendor keeps calling that vendor with its own key, and that a Synapse key
 * never reaches a non-Synapse host
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import * as mcp from "../../mcp";
import { agentPlugin } from "./agent";

import type { PluginContext } from "../types";

const execute = agentPlugin.actions.execute.handler;

const SYNAPSE_KEY = "synapse_test_key";
const OPENAI_KEY = "sk-openai-test-key";

type Captured = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Captured[] = [];

const finalAnswer = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const ctx = (keys: Record<string, string | undefined> = {}): PluginContext => ({
  workflowId: "wf",
  runId: "run",
  stepId: "step",
  organizationId: "org-a",
  config: {},
  secrets: {},
  resolveProviderKey: async (provider) => keys[provider],
});

beforeEach(() => {
  calls = [];
  spyOn(mcp, "ensureMCPServerForOrg").mockResolvedValue(undefined);
  const client = mcp.getMCPClient();
  spyOn(client, "listTools").mockResolvedValue([]);
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return finalAnswer();
  }) as typeof fetch);
});

afterEach(() => {
  mock.restore();
});

describe("agent default provider", () => {
  it("runs through the Synapse gateway with model auto and the org's Synapse key", async () => {
    const result = await execute(
      { serverId: "srv", goal: "say hi" },
      ctx({ synapse: SYNAPSE_KEY, openai: OPENAI_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${SYNAPSE_KEY}`);
    expect(calls[0]?.body?.model).toBe("auto");
    expect(result.output).toMatchObject({ provider: "synapse", model: "auto" });
  });

  it("passes a named Synapse model through", async () => {
    await execute(
      { serverId: "srv", goal: "x", model: "anthropic/claude-sonnet-5-5" },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(calls[0]?.body?.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("fails without calling anything when the org has no Synapse key", async () => {
    const result = await execute(
      { serverId: "srv", goal: "x" },
      ctx({ openai: OPENAI_KEY }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Synapse");
    expect(calls).toHaveLength(0);
  });
});

describe("agent BYOK providers", () => {
  it("keeps an explicitly named OpenAI step on OpenAI with the OpenAI key", async () => {
    const result = await execute(
      { serverId: "srv", goal: "x", provider: "openai" },
      ctx({ synapse: SYNAPSE_KEY, openai: OPENAI_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(calls[0]?.body?.model).toBe("gpt-4o-mini");
  });

  it("keeps a legacy step with an inline vendor key and no provider on OpenAI", async () => {
    await execute({ serverId: "srv", goal: "x", apiKey: OPENAI_KEY }, ctx());

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends an Anthropic step to Anthropic, not OpenAI", async () => {
    await execute(
      { serverId: "srv", goal: "x", provider: "anthropic", model: "claude-x" },
      ctx({ anthropic: "sk-ant-test" }),
    );

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-test");
  });
});

describe("agent Synapse key containment", () => {
  const allHeaderValues = () =>
    calls.flatMap((c) => Object.values(c.headers)).join("\n");

  it("never sends a Synapse key to a vendor host", async () => {
    const result = await execute(
      { serverId: "srv", goal: "x", provider: "openai", apiKey: SYNAPSE_KEY },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(allHeaderValues()).not.toContain(SYNAPSE_KEY);
  });

  it("never sends a Synapse key to a custom endpoint", async () => {
    const result = await execute(
      {
        serverId: "srv",
        goal: "x",
        provider: "synapse",
        baseUrl: "https://evil.example.com/v1",
      },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never sends the org's stored key to a custom endpoint", async () => {
    const result = await execute(
      {
        serverId: "srv",
        goal: "x",
        provider: "openai",
        baseUrl: "https://evil.example.com/v1",
      },
      ctx({ openai: OPENAI_KEY, synapse: SYNAPSE_KEY }),
    );

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("agent action names", () => {
  it("runs the editor's AI Agent node, which calls the run action", async () => {
    const run = agentPlugin.actions.run;
    expect(run).toBeDefined();

    const result = await run?.handler(
      { serverId: "srv", goal: "x" },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(result?.success).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
  });
});
