/**
 * Model registry provider tests.
 *
 * Synapse is the default provider (OpenAI-compatible chat, embeddings and
 * model listing on the gateway); a step naming a vendor keeps calling that
 * vendor with its own key; a Synapse key never reaches a non-Synapse host
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

import { modelRegistryPlugin } from "./modelRegistry";

import type { PluginContext } from "../types";

const { chat, complete, embed, listModels } = modelRegistryPlugin.actions;

const SYNAPSE_KEY = "synapse_test_key";
const OPENAI_KEY = "sk-openai-test-key";

type Captured = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Captured[] = [];

const ctx = (keys: Record<string, string | undefined> = {}): PluginContext => ({
  workflowId: "wf",
  runId: "run",
  stepId: "step",
  organizationId: "org-a",
  config: {},
  secrets: {},
  resolveProviderKey: async (provider) => keys[provider],
});

const messages = [{ role: "user", content: "hi" }];

beforeEach(() => {
  calls = [];
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload = url.endsWith("/embeddings")
      ? { data: [{ embedding: [0.1, 0.2] }] }
      : url.endsWith("/models")
        ? { data: [{ id: "auto" }] }
        : { choices: [{ message: { content: "hello" } }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
});

afterEach(() => {
  mock.restore();
});

describe("model registry default provider", () => {
  it("chats through the Synapse gateway with model auto and the org's Synapse key", async () => {
    const result = await chat.handler(
      { messages },
      ctx({ synapse: SYNAPSE_KEY, openai: OPENAI_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${SYNAPSE_KEY}`);
    expect(calls[0]?.body?.model).toBe("auto");
    expect(result.output).toMatchObject({
      content: "hello",
      provider: "synapse",
      model: "auto",
    });
  });

  it("falls back to chat for text completion on Synapse", async () => {
    const result = await complete.handler(
      { prompt: "hi" },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/chat/completions",
    );
  });

  it("embeds through the Synapse gateway", async () => {
    const result = await embed.handler(
      { input: "hi", model: "text-embedding-3-small" },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://gateway.synapse.omni.dev/v1/embeddings",
    );
  });

  it("lists Synapse models", async () => {
    const result = await listModels.handler({}, ctx({ synapse: SYNAPSE_KEY }));

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe("https://gateway.synapse.omni.dev/v1/models");
    expect(result.output).toMatchObject({ models: ["auto"] });
  });
});

describe("model registry BYOK providers", () => {
  it("keeps an explicitly named OpenAI step on OpenAI with the OpenAI key", async () => {
    const result = await chat.handler(
      { provider: "openai", model: "gpt-4o", messages },
      ctx({ synapse: SYNAPSE_KEY, openai: OPENAI_KEY }),
    );

    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("rejects an unknown provider without calling anything", async () => {
    const result = await chat.handler(
      { provider: "made-up", model: "m", messages, apiKey: OPENAI_KEY },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("model registry Synapse key containment", () => {
  it("never sends a Synapse key to a vendor host", async () => {
    for (const handler of [chat, complete, embed, listModels]) {
      const result = await handler.handler(
        {
          provider: "openai",
          model: "gpt-4o",
          messages,
          prompt: "hi",
          input: "hi",
          apiKey: SYNAPSE_KEY,
        },
        ctx(),
      );
      expect(result.success).toBe(false);
    }

    expect(calls).toHaveLength(0);
  });

  it("never sends a Synapse key to a custom endpoint", async () => {
    const result = await chat.handler(
      { messages, baseUrl: "https://evil.example.com/v1", provider: "synapse" },
      ctx({ synapse: SYNAPSE_KEY }),
    );

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
