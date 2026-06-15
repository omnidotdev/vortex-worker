/**
 * Built-in Email Render Plugin Tests
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { emailRenderPlugin } from "./emailRender";

const ORIGINAL_ENV = {
  AUTH_API_URL: process.env.AUTH_API_URL,
  EMAIL_RENDER_SECRET: process.env.EMAIL_RENDER_SECRET,
};

const ORIGINAL_FETCH = globalThis.fetch;

const render = (inputs: Record<string, unknown>) =>
  emailRenderPlugin.actions.render.handler(inputs);

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

describe("emailRenderPlugin", () => {
  it("has the expected metadata", () => {
    expect(emailRenderPlugin.id).toBe("builtin:emailRender");
    expect(emailRenderPlugin.actions.render).toBeDefined();
  });

  it("returns an error when env is missing", async () => {
    delete process.env.AUTH_API_URL;
    delete process.env.EMAIL_RENDER_SECRET;

    const result = await render({ templateId: "welcome" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  describe("with env present", () => {
    beforeEach(() => {
      process.env.AUTH_API_URL = "https://auth.test";
      process.env.EMAIL_RENDER_SECRET = "secret";
    });

    it("posts to the render endpoint and returns html/subject", async () => {
      let calledUrl = "";
      let calledInit: RequestInit | undefined;

      globalThis.fetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calledUrl = String(url);
        calledInit = init;

        return new Response(
          JSON.stringify({ html: "<p>Hi</p>", subject: "Welcome" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const result = await render({
        templateId: "welcome",
        templateData: { name: "Brian" },
      });

      expect(calledUrl).toBe("https://auth.test/api/email/render");
      expect(calledInit?.method).toBe("POST");
      expect(
        (calledInit?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer secret");
      expect(calledInit?.body).toBe(
        JSON.stringify({
          templateId: "welcome",
          templateData: { name: "Brian" },
        }),
      );
      expect(result.success).toBe(true);
      expect(result.output?.html).toBe("<p>Hi</p>");
      expect(result.output?.subject).toBe("Welcome");
    });

    it("returns a failure on non-2xx responses", async () => {
      globalThis.fetch = (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof fetch;

      const result = await render({ templateId: "welcome" });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
