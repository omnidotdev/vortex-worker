/**
 * Email Activity Tests
 */

import { describe, expect, it } from "bun:test";

import {
  executeEmailActivity,
  type EmailActivityInput,
} from "../activities/email.activity";

describe("EmailActivityInput validation", () => {
  it("should accept valid email input with required fields", () => {
    const input: EmailActivityInput = {
      to: "test@example.com",
      subject: "Test Subject",
      body: "Test body content",
    };

    expect(input.to).toBe("test@example.com");
    expect(input.subject).toBe("Test Subject");
    expect(input.body).toBe("Test body content");
  });

  it("should accept array of recipients", () => {
    const input: EmailActivityInput = {
      to: ["a@example.com", "b@example.com"],
      subject: "Multi-recipient",
      body: "Hello all",
    };

    expect(Array.isArray(input.to)).toBe(true);
    expect(input.to).toHaveLength(2);
  });

  it("should accept optional fields", () => {
    const input: EmailActivityInput = {
      to: "test@example.com",
      subject: "Test",
      body: "Body",
      from: "sender@example.com",
      replyTo: "reply@example.com",
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      html: true,
    };

    expect(input.from).toBe("sender@example.com");
    expect(input.replyTo).toBe("reply@example.com");
    expect(input.cc).toEqual(["cc@example.com"]);
    expect(input.bcc).toEqual(["bcc@example.com"]);
    expect(input.html).toBe(true);
  });
});

describe("executeEmailActivity", () => {
  it("should gracefully degrade to stdout when RESEND_API_KEY is not set", async () => {
    const input: EmailActivityInput = {
      to: "test@example.com",
      subject: "Test",
      body: "Test body",
    };

    // Should succeed via stdout fallback when Resend is not configured
    const result = await executeEmailActivity(input);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("stdout-fallback");
  });
});
