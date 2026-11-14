/**
 * Template `env.*` isolation security tests.
 *
 * Workflow templates used to resolve `{{ env.X }}` against the worker's whole
 * `process.env`, so any tenant workflow could read DATABASE_URL, ENCRYPTION_KEY,
 * BILLING_SERVICE_API_KEY and every other worker secret by putting a template
 * in a step input. These tests assert that tenant workflows see no worker env at
 * all, and that platform-org system workflows see only the explicit whitelist
 * they need
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createExecutionContext, resolveValue } from "../dsl/executor";
import {
  PLATFORM_TEMPLATE_ENV_KEYS,
  resolveTemplateEnv,
} from "../dsl/templateEnv";

const PLATFORM_ORG = "33880602-cf32-4d8d-8db3-a4a9994c5d45";

const WORKER_SECRETS = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "BILLING_SERVICE_API_KEY",
  "HATCHET_CLIENT_TOKEN",
  "INTERNAL_API_SECRET",
  "AUTHZ_SERVICE_KEY",
  "MEILISEARCH_MASTER_KEY",
  "IGGY_PASSWORD",
  "CACHE_URL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "CHRONICLE_WEBHOOK_SECRET",
];

const fakeEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://vortex:secret@db/vortex",
  ENCRYPTION_KEY: "enc-key",
  BILLING_SERVICE_API_KEY: "aether-key",
  HATCHET_CLIENT_TOKEN: "hatchet-token",
  INTERNAL_API_SECRET: "internal",
  AUTHZ_SERVICE_KEY: "authz",
  MEILISEARCH_MASTER_KEY: "meili",
  IGGY_PASSWORD: "iggy",
  CACHE_URL: "redis://:pw@cache:6379",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=x",
  CHRONICLE_WEBHOOK_SECRET: "chronicle",
  HERALD_API_URL: "https://api.herald.omni.dev",
  HERALD_API_KEY: "herald-key",
  AUTH_API_URL: "https://identity.omni.dev",
};

describe("resolveTemplateEnv", () => {
  it("exposes nothing to tenant workflows", () => {
    for (const org of [undefined, "", "tenant-org"]) {
      expect(resolveTemplateEnv(org, PLATFORM_ORG, fakeEnv)).toEqual({});
    }
  });

  it("exposes only whitelisted keys to platform workflows", () => {
    const env = resolveTemplateEnv(PLATFORM_ORG, PLATFORM_ORG, fakeEnv);

    for (const key of Object.keys(env)) {
      expect(PLATFORM_TEMPLATE_ENV_KEYS).toContain(key);
    }
    expect(env.HERALD_API_KEY).toBe("herald-key");
    expect(env.AUTH_API_URL).toBe("https://identity.omni.dev");
  });

  it("never whitelists worker infrastructure secrets", () => {
    for (const secret of WORKER_SECRETS) {
      expect(PLATFORM_TEMPLATE_ENV_KEYS).not.toContain(secret);
    }
    const env = resolveTemplateEnv(PLATFORM_ORG, PLATFORM_ORG, fakeEnv);
    for (const secret of WORKER_SECRETS) {
      expect(env[secret]).toBeUndefined();
    }
  });

  it("fails closed when the platform org is unset", () => {
    expect(resolveTemplateEnv(undefined, undefined, fakeEnv)).toEqual({});
    expect(resolveTemplateEnv("", "", fakeEnv)).toEqual({});
  });
});

describe("template resolution through the executor", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [k, v] of Object.entries(fakeEnv)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const runSet = async (organizationId: string | undefined) => {
    const inputs: Record<string, string> = {};
    for (const key of [...WORKER_SECRETS, "HERALD_API_KEY"]) {
      inputs[key] = `{{ env.${key} }}`;
      inputs[`${key}_embedded`] = `x={{env.${key}}}`;
    }
    const ctx = createExecutionContext("wf", "run", {}, organizationId);

    return resolveValue(inputs, ctx) as Record<string, unknown>;
  };

  it("resolves env templates to empty for a tenant workflow", async () => {
    const vars = await runSet("tenant-org");

    for (const key of [...WORKER_SECRETS, "HERALD_API_KEY"]) {
      expect(vars[key]).toBe("");
      expect(vars[`${key}_embedded`]).toBe("x=");
    }
  });

  it("resolves env templates to empty when the org is unknown", async () => {
    const vars = await runSet(undefined);

    for (const key of WORKER_SECRETS) {
      expect(vars[key]).toBe("");
    }
  });

  it("never resolves infrastructure secrets even for the platform org", async () => {
    const vars = await runSet(PLATFORM_ORG);

    for (const key of WORKER_SECRETS) {
      expect(vars[key]).toBe("");
    }
    expect(vars.HERALD_API_KEY).toBe("herald-key");
  });
});
