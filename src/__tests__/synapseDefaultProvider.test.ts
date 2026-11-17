/**
 * Synapse default provider, end to end through the DSL executor.
 *
 * An agent or model registry step that names no provider runs through the
 * Synapse gateway with model `auto`, using the Synapse key the workflow's org
 * stored as an integration. Existing steps that name a vendor keep calling
 * that vendor with the org's key for that vendor. The key lookup is bound to
 * the executing org and never reaches across to another provider's key
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

import { createExecutionContext, executeStep } from "../dsl/executor";
import { AgentStep, ModelRegistryStep } from "../dsl/types";
import * as credentials from "../integrations/credentials";
import * as mcp from "../mcp";

import type { WorkflowDefinition } from "../dsl/types";

const ORG = "org-synapse-test";
const SYNAPSE_KEY = "synapse_org_key";
const OPENAI_KEY = "sk-org-openai-key";

type Captured = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Captured[] = [];
let lookup: ReturnType<typeof spyOn>;

const def: WorkflowDefinition = { version: "1.0", steps: [], edges: [] };

beforeEach(() => {
  calls = [];
  lookup = spyOn(credentials, "getIntegrationCredentials").mockImplementation(
    async (organizationId: string, type: string) => {
      if (organizationId !== ORG) return undefined;
      if (type === "synapse")
        return { type: "secret_text", secret: SYNAPSE_KEY };
      if (type === "openai") return { type: "secret_text", secret: OPENAI_KEY };
      return undefined;
    },
  );
  spyOn(mcp, "ensureMCPServerForOrg").mockResolvedValue(undefined);
  spyOn(mcp.getMCPClient(), "listTools").mockResolvedValue([]);
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch);
});

afterEach(() => {
  mock.restore();
});

describe("agent step default provider", () => {
  it("runs a provider-less agent step through Synapse with the org's Synapse key", async () => {
    const step = AgentStep.parse({
      id: "agent-1",
      type: "agent",
      name: "Agent",
      position: { x: 0, y: 0 },
      agent: { serverId: "srv", goal: "summarize" },
    });
    const ctx = createExecutionContext("wf", "run", {}, ORG);

    await executeStep(def, step, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${SYNAPSE_KEY}`);
    expect(calls[0]?.body?.model).toBe("auto");
    expect(lookup).toHaveBeenCalledWith(ORG, "synapse");
    expect(lookup).not.toHaveBeenCalledWith(ORG, "openai");
  });

  it("keeps an agent step that names OpenAI on OpenAI with the org's OpenAI key", async () => {
    const step = AgentStep.parse({
      id: "agent-2",
      type: "agent",
      name: "Agent",
      position: { x: 0, y: 0 },
      agent: { serverId: "srv", goal: "x", provider: "openai" },
    });
    const ctx = createExecutionContext("wf", "run", {}, ORG);

    await executeStep(def, step, ctx);

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });
});

describe("model registry step default provider", () => {
  it("runs a provider-less chat step through Synapse with model auto", async () => {
    const step = ModelRegistryStep.parse({
      id: "mr-1",
      type: "modelRegistry",
      name: "Model",
      position: { x: 0, y: 0 },
      modelRegistry: { messages: [{ role: "user", content: "hi" }] },
    });
    const ctx = createExecutionContext("wf", "run", {}, ORG);

    await executeStep(def, step, ctx);

    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${SYNAPSE_KEY}`);
    expect(calls[0]?.body?.model).toBe("auto");
  });

  it("still accepts an existing step that names a vendor provider and model", () => {
    const parsed = ModelRegistryStep.safeParse({
      id: "mr-2",
      type: "modelRegistry",
      name: "Model",
      position: { x: 0, y: 0 },
      modelRegistry: {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("does not look up keys for a workflow with no org", async () => {
    const step = ModelRegistryStep.parse({
      id: "mr-3",
      type: "modelRegistry",
      name: "Model",
      position: { x: 0, y: 0 },
      modelRegistry: { messages: [{ role: "user", content: "hi" }] },
    });
    const ctx = createExecutionContext("wf", "run", {});

    await executeStep(def, step, ctx);

    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
