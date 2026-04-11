/**
 * Billing usage check tests.
 *
 * Tests for the Aether usage metering client, verifying that
 * checkUsage handles success, limit exceeded, unreachable backend,
 * and missing env var scenarios.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Store original env values for restoration
const originalBillingApiUrl = process.env.BILLING_API_URL;
const originalBillingServiceApiKey = process.env.BILLING_SERVICE_API_KEY;

// Keep a reference to the real fetch
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Set billing env vars for most tests
  process.env.BILLING_API_URL = "http://aether.test";
  process.env.BILLING_SERVICE_API_KEY = "test-service-key";
});

afterEach(() => {
  // Restore originals
  globalThis.fetch = originalFetch;

  if (originalBillingApiUrl !== undefined) {
    process.env.BILLING_API_URL = originalBillingApiUrl;
  } else {
    delete process.env.BILLING_API_URL;
  }

  if (originalBillingServiceApiKey !== undefined) {
    process.env.BILLING_SERVICE_API_KEY = originalBillingServiceApiKey;
  } else {
    delete process.env.BILLING_SERVICE_API_KEY;
  }
});

// Mock the logger to suppress warnings during tests
mock.module("lib/logger", () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

describe("checkUsage", () => {
  it("should return allowed:true when within limits", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          allowed: true,
          currentUsage: 50,
          limit: 1000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    // Re-import after env is set so the module picks up the values
    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(true);
    expect(result!.currentUsage).toBe(50);
    expect(result!.limit).toBe(1000);
  });

  it("should return allowed:false when limits exceeded", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          allowed: false,
          currentUsage: 1000,
          limit: 1000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.currentUsage).toBe(1000);
    expect(result!.limit).toBe(1000);
  });

  it("should return null when Aether is unreachable (graceful degradation)", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new Error("Connection refused"),
      )) as unknown as typeof fetch;

    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).toBeNull();
  });

  it("should return null when Aether returns non-OK status", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
      })) as unknown as typeof fetch;

    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).toBeNull();
  });
});

describe("checkUsage with missing env vars", () => {
  it("should return null when BILLING_API_URL is not set", async () => {
    delete process.env.BILLING_API_URL;
    delete process.env.BILLING_SERVICE_API_KEY;

    // Force re-evaluation by re-importing
    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).toBeNull();
  });

  it("should return null when BILLING_SERVICE_API_KEY is not set", async () => {
    process.env.BILLING_API_URL = "http://aether.test";
    delete process.env.BILLING_SERVICE_API_KEY;

    const { checkUsage } = await import("../billing/usageClient");
    const result = await checkUsage(
      "organization",
      "org-123",
      "step_executions",
      1,
    );

    expect(result).toBeNull();
  });
});

describe("checkUsage request construction", () => {
  it("should include additionalUsage query parameter when provided", async () => {
    let capturedUrl = "";

    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();

      return new Response(
        JSON.stringify({ allowed: true, currentUsage: 10, limit: 100 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { checkUsage } = await import("../billing/usageClient");
    await checkUsage("organization", "org-456", "compute_ms", 5);

    expect(capturedUrl).toContain("additionalUsage=5");
    expect(capturedUrl).toContain(
      "/usage/vortex/organization/org-456/compute_ms/check",
    );
  });

  it("should omit additionalUsage when not provided", async () => {
    let capturedUrl = "";

    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();

      return new Response(
        JSON.stringify({ allowed: true, currentUsage: 0, limit: 100 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { checkUsage } = await import("../billing/usageClient");
    await checkUsage("organization", "org-456", "compute_ms");

    expect(capturedUrl).not.toContain("additionalUsage");
  });
});

describe("usageClient source validation", () => {
  it("should use fire-and-forget pattern (never throw)", async () => {
    const source = await Bun.file("src/billing/usageClient.ts").text();

    // All errors should be caught and return null
    expect(source).toContain("return null");
    expect(source).toContain("catch");
    // Should log warnings, not throw
    expect(source).toContain("logger.warn");
  });

  it("should set a request timeout", async () => {
    const source = await Bun.file("src/billing/usageClient.ts").text();

    expect(source).toContain("AbortSignal.timeout");
    expect(source).toContain("REQUEST_TIMEOUT_MS");
  });

  it("should authenticate with x-service-api-key header", async () => {
    const source = await Bun.file("src/billing/usageClient.ts").text();

    expect(source).toContain("x-service-api-key");
    expect(source).toContain("BILLING_SERVICE_API_KEY");
  });
});
