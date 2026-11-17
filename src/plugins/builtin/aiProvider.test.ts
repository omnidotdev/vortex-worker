/**
 * AI provider resolution tests.
 *
 * Synapse is the default provider for agent and model registry steps. These
 * tests pin how a step's provider is chosen (explicit names keep their old
 * behavior), where each provider's key comes from, and the key/host pairing
 * rules: a Synapse key only ever goes to the Synapse gateway, and a key the
 * org stored for a provider only ever goes to that provider's own endpoint
 */

import { describe, expect, it, mock } from "bun:test";

import { createProviderKeyResolver } from "../../integrations/providerKeys";
import {
  DEFAULT_SYNAPSE_MODEL,
  SYNAPSE_PROVIDER,
  isSynapseKey,
  isSynapseUrl,
  resolveCredential,
  resolveProvider,
  synapseApiBaseUrl,
} from "./aiProvider";

import type { PluginContext } from "../types";

const SYNAPSE_KEY = "synapse_test_key";
const OPENAI_KEY = "sk-openai-test-key";
const OPENAI_BASE = "https://api.openai.com/v1";

const ctx = (
  resolveProviderKey?: (provider: string) => Promise<string | undefined>,
): PluginContext => ({
  workflowId: "wf",
  runId: "run",
  stepId: "step",
  organizationId: "org-a",
  config: {},
  secrets: {},
  resolveProviderKey,
});

describe("synapse defaults", () => {
  it("targets the production gateway's /v1 API", () => {
    expect(synapseApiBaseUrl()).toBe("https://gateway.synapse.omni.dev/v1");
  });

  it("uses the auto routing model by default", () => {
    expect(DEFAULT_SYNAPSE_MODEL).toBe("auto");
  });

  it("recognizes Synapse keys and the gateway host", () => {
    expect(isSynapseKey(SYNAPSE_KEY)).toBe(true);
    expect(isSynapseKey(OPENAI_KEY)).toBe(false);
    expect(isSynapseUrl("https://gateway.synapse.omni.dev/v1")).toBe(true);
    expect(isSynapseUrl("https://gateway.synapse.omni.dev.evil.com/v1")).toBe(
      false,
    );
    expect(isSynapseUrl("https://evil.com/gateway.synapse.omni.dev")).toBe(
      false,
    );
    expect(isSynapseUrl("not a url")).toBe(false);
  });
});

describe("resolveProvider", () => {
  it("defaults to Synapse when a step names no provider", () => {
    expect(resolveProvider({})).toBe(SYNAPSE_PROVIDER);
  });

  it("keeps an explicitly named provider", () => {
    expect(resolveProvider({ provider: "openai" })).toBe("openai");
    expect(
      resolveProvider({ provider: "anthropic", apiKey: SYNAPSE_KEY }),
    ).toBe("anthropic");
  });

  it("keeps the legacy OpenAI default for steps carrying their own vendor key or endpoint", () => {
    expect(resolveProvider({ apiKey: OPENAI_KEY })).toBe("openai");
    expect(resolveProvider({ baseUrl: "https://llm.example.com/v1" })).toBe(
      "openai",
    );
  });

  it("routes an inline Synapse key without a provider to Synapse", () => {
    expect(resolveProvider({ apiKey: SYNAPSE_KEY })).toBe(SYNAPSE_PROVIDER);
  });
});

describe("resolveCredential", () => {
  it("uses the org's stored Synapse key against the gateway", async () => {
    const resolver = mock(async (provider: string) =>
      provider === "synapse" ? SYNAPSE_KEY : undefined,
    );

    const result = await resolveCredential(
      {
        provider: SYNAPSE_PROVIDER,
        canonicalBaseUrl: synapseApiBaseUrl(),
        requiresKey: true,
      },
      ctx(resolver),
    );

    expect(result).toEqual({
      ok: true,
      apiKey: SYNAPSE_KEY,
      baseUrl: "https://gateway.synapse.omni.dev/v1",
    });
    expect(resolver).toHaveBeenCalledWith("synapse");
  });

  it("looks up a vendor provider's own stored key, never the Synapse key", async () => {
    const resolver = mock(async (provider: string) =>
      provider === "openai" ? OPENAI_KEY : SYNAPSE_KEY,
    );

    const result = await resolveCredential(
      { provider: "openai", canonicalBaseUrl: OPENAI_BASE, requiresKey: true },
      ctx(resolver),
    );

    expect(result).toEqual({
      ok: true,
      apiKey: OPENAI_KEY,
      baseUrl: OPENAI_BASE,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("openai");
  });

  it("prefers an inline key over the stored key", async () => {
    const resolver = mock(async () => "synapse_stored");

    const result = await resolveCredential(
      {
        provider: SYNAPSE_PROVIDER,
        canonicalBaseUrl: synapseApiBaseUrl(),
        apiKey: SYNAPSE_KEY,
        requiresKey: true,
      },
      ctx(resolver),
    );

    expect(result).toMatchObject({ ok: true, apiKey: SYNAPSE_KEY });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("fails clearly when no key is available", async () => {
    const result = await resolveCredential(
      {
        provider: SYNAPSE_PROVIDER,
        canonicalBaseUrl: synapseApiBaseUrl(),
        requiresKey: true,
      },
      ctx(async () => undefined),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Synapse");
  });

  it("refuses a Synapse step pointed at another host", async () => {
    const resolver = mock(async () => SYNAPSE_KEY);

    const result = await resolveCredential(
      {
        provider: SYNAPSE_PROVIDER,
        canonicalBaseUrl: synapseApiBaseUrl(),
        baseUrl: "https://evil.example.com/v1",
        requiresKey: true,
      },
      ctx(resolver),
    );

    expect(result.ok).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses to send an inline Synapse key to a vendor host", async () => {
    const result = await resolveCredential(
      {
        provider: "openai",
        canonicalBaseUrl: OPENAI_BASE,
        apiKey: SYNAPSE_KEY,
        requiresKey: true,
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Synapse key");
  });

  it("refuses to send a Synapse key stored under a vendor integration to that vendor", async () => {
    const result = await resolveCredential(
      { provider: "openai", canonicalBaseUrl: OPENAI_BASE, requiresKey: true },
      ctx(async () => SYNAPSE_KEY),
    );

    expect(result.ok).toBe(false);
  });

  it("refuses to send a Synapse key to a custom endpoint", async () => {
    const result = await resolveCredential(
      {
        provider: "openai",
        canonicalBaseUrl: OPENAI_BASE,
        baseUrl: "https://evil.example.com/v1",
        apiKey: SYNAPSE_KEY,
        requiresKey: true,
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
  });

  it("never sends a stored key to a custom endpoint", async () => {
    const resolver = mock(async () => OPENAI_KEY);

    const result = await resolveCredential(
      {
        provider: "openai",
        canonicalBaseUrl: OPENAI_BASE,
        baseUrl: "https://evil.example.com/v1",
        requiresKey: true,
      },
      ctx(resolver),
    );

    expect(result.ok).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("blocks a custom endpoint on a private address", async () => {
    const result = await resolveCredential(
      {
        provider: "openai",
        canonicalBaseUrl: OPENAI_BASE,
        baseUrl: "http://169.254.169.254/v1",
        apiKey: OPENAI_KEY,
        requiresKey: true,
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
  });

  it("refuses an unknown provider without an endpoint instead of falling back to OpenAI", async () => {
    const result = await resolveCredential(
      {
        provider: "made-up",
        canonicalBaseUrl: undefined,
        apiKey: OPENAI_KEY,
        requiresKey: true,
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
  });

  it("allows keyless providers without a key", async () => {
    const result = await resolveCredential(
      {
        provider: "ollama",
        canonicalBaseUrl: "http://localhost:11434/api",
        requiresKey: false,
      },
      ctx(async () => undefined),
    );

    expect(result).toEqual({
      ok: true,
      apiKey: undefined,
      baseUrl: "http://localhost:11434/api",
    });
  });
});

describe("createProviderKeyResolver", () => {
  it("returns the org's stored key for an AI provider integration", async () => {
    const lookup = mock(async () => ({
      type: "secret_text" as const,
      secret: SYNAPSE_KEY,
    }));
    const resolve = createProviderKeyResolver("org-a", lookup);

    expect(await resolve("synapse")).toBe(SYNAPSE_KEY);
    expect(lookup).toHaveBeenCalledWith("org-a", "synapse");
  });

  it("never reads a non-AI integration's secret", async () => {
    const lookup = mock(async () => ({
      type: "secret_text" as const,
      secret: "ghp_token",
    }));
    const resolve = createProviderKeyResolver("org-a", lookup);

    expect(await resolve("github")).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
