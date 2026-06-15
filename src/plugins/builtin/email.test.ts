/**
 * Built-in Email Plugin Tests
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { emailPlugin } from "./email";

const ORIGINAL_ENV = {
  HERALD_API_URL: process.env.HERALD_API_URL,
  HERALD_API_KEY: process.env.HERALD_API_KEY,
  HERALD_SENDER_EMAIL_ADDRESS: process.env.HERALD_SENDER_EMAIL_ADDRESS,
  SENDER_EMAIL_ADDRESS: process.env.SENDER_EMAIL_ADDRESS,
};

const ORIGINAL_FETCH = globalThis.fetch;

const send = (inputs: Record<string, unknown>) =>
  emailPlugin.actions.send.handler(inputs);

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("emailPlugin", () => {
  it("has Herald-based metadata", () => {
    expect(emailPlugin.id).toBe("builtin:email");
    expect(emailPlugin.description).toBe("Send emails via Herald");
  });

  describe("input validation", () => {
    it("requires a recipient", async () => {
      const result = await send({ subject: "Hi", body: "Body" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Recipient");
    });

    it("requires a subject", async () => {
      const result = await send({ to: "a@example.com", body: "Body" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Subject");
    });

    it("requires a body", async () => {
      const result = await send({ to: "a@example.com", subject: "Hi" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Body");
    });
  });

  describe("with Herald env present", () => {
    beforeEach(() => {
      process.env.HERALD_API_URL = "https://herald.test";
      process.env.HERALD_API_KEY = "test-key";
    });

    it("sends via Herald and reports the message id", async () => {
      let calledUrl = "";
      let calledHeaders: Record<string, string> = {};

      globalThis.fetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calledUrl = String(url);
        calledHeaders = (init?.headers ?? {}) as Record<string, string>;

        return new Response(JSON.stringify({ id: "herald-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const result = await send({
        to: "a@example.com",
        subject: "Hi",
        body: "<p>Body</p>",
        contentType: "html",
      });

      expect(calledUrl).toContain("herald.test");
      expect(calledHeaders.Authorization).toBe("Bearer test-key");
      expect(result.success).toBe(true);
      expect(result.output?.sent).toBe(true);
      expect(result.output?.recipients).toBe(1);
      expect(result.output?.messageId).toBe("herald-123");
    });

    it("returns a failure result when Herald reports an error", async () => {
      globalThis.fetch = (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch;

      const result = await send({
        to: "a@example.com",
        subject: "Hi",
        body: "Body",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("without Herald env", () => {
    beforeEach(() => {
      delete process.env.HERALD_API_URL;
      delete process.env.HERALD_API_KEY;
    });

    it("degrades to the noop provider and reports success", async () => {
      const result = await send({
        to: "a@example.com",
        subject: "Hi",
        body: "Body",
      });

      expect(result.success).toBe(true);
      expect(result.output?.recipients).toBe(1);
    });
  });
});
