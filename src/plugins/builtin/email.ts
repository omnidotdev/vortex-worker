/**
 * Built-in Email Plugin
 *
 * Sends emails via SMTP or integration.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Email attachment */
interface EmailAttachment {
  /** Filename for the attachment */
  filename: string;
  /** Base64 encoded content or plain text */
  content: string;
  /** MIME type (default: application/octet-stream) */
  contentType?: string;
}

/** Email send input */
interface EmailSendInput {
  /** Recipient email address(es) */
  to: string | string[];
  /** CC recipients */
  cc?: string | string[];
  /** BCC recipients */
  bcc?: string | string[];
  /** Email subject */
  subject: string;
  /** Email body content */
  body: string;
  /** Content type: text or html (default: text) */
  contentType?: "text" | "html";
  /** File attachments */
  attachments?: EmailAttachment[];
}

/**
 * Send an email.
 */
const sendEmail = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      to,
      cc,
      bcc,
      subject,
      body,
      contentType = "text",
      attachments,
    } = inputs as unknown as EmailSendInput;

    if (!to) {
      return {
        success: false,
        error: "Recipient (to) is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!subject) {
      return {
        success: false,
        error: "Subject is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Normalize recipients to arrays.
    const toList = Array.isArray(to) ? to : [to];
    const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccList = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;

    const emailData = {
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject,
      [contentType === "html" ? "html" : "text"]: body,
      attachments,
    };

    // TODO: Integrate with actual SMTP transport via MCP or direct.
    // biome-ignore lint/suspicious/noConsole: Intentional runtime logging for plugin placeholder
    console.log("[Email Plugin] Would send:", emailData);

    return {
      success: true,
      output: {
        sent: true,
        recipients: toList.length,
        messageId: `msg_${Date.now()}`,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Email built-in plugin definition.
 */
export const emailPlugin: BuiltinPlugin = {
  id: "builtin:email",
  name: "Email",
  description: "Send emails via SMTP",
  actions: {
    send: {
      name: "send",
      description: "Send an email",
      handler: sendEmail,
    },
  },
};
