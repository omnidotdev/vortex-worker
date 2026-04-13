/**
 * Built-in Email Plugin
 *
 * Sends emails via Resend.
 */

import { Resend } from "resend";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Default sender address */
const DEFAULT_FROM = "Vortex <noreply@vortex.omni.dev>";

/** Module-level singleton for the env-key Resend client */
let resendClient: Resend | null = null;

/**
 * Get a Resend client instance.
 *
 * Uses a module-level singleton when relying on the env var, or creates a new
 * instance per call when an explicit `apiKey` override is provided.
 */
const getResendClient = (apiKey?: string): Resend | null => {
  if (apiKey) {
    return new Resend(apiKey);
  }

  if (!resendClient) {
    const RESEND_API_KEY = process.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return null;
    }

    resendClient = new Resend(RESEND_API_KEY);
  }

  return resendClient;
};

/** Email attachment */
type EmailAttachment = {
  /** Filename for the attachment */
  filename: string;
  /** Base64 encoded content or plain text */
  content: string;
  /** MIME type (default: application/octet-stream) */
  contentType?: string;
};

/** Email send input */
type EmailSendInput = {
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
  /** Sender address override */
  from?: string;
  /** Reply-to address */
  replyTo?: string;
  /** Resend API key override */
  apiKey?: string;
};

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
      from,
      replyTo,
      apiKey,
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

    if (!body) {
      return {
        success: false,
        error: "Body is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Normalize recipients to arrays.
    const toList = Array.isArray(to) ? to : [to];
    const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccList = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;

    const resend = getResendClient(apiKey);

    if (!resend) {
      const toStr = Array.isArray(to) ? to.join(", ") : to;
      console.info(
        `[Email] ${subject} -> ${toStr}`,
        JSON.stringify({ from: from ?? DEFAULT_FROM, body }, null, 2),
      );

      return {
        success: true,
        output: { sent: false, recipients: toList.length, fallback: "stdout" },
        durationMs: performance.now() - startTime,
      };
    }

    const baseOptions = {
      from: from ?? DEFAULT_FROM,
      to: toList,
      subject,
      ...(ccList && { cc: ccList }),
      ...(bccList && { bcc: bccList }),
      ...(replyTo && { replyTo }),
      ...(attachments && {
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType && { content_type: a.contentType }),
        })),
      }),
    };

    const { data, error } = await resend.emails.send(
      contentType === "html"
        ? { ...baseOptions, html: body }
        : { ...baseOptions, text: body },
    );

    if (error) {
      return {
        success: false,
        error: error.message,
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        sent: true,
        recipients: toList.length,
        messageId: data?.id,
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
  description: "Send emails via Resend",
  actions: {
    send: {
      name: "send",
      description: "Send an email",
      handler: sendEmail,
    },
  },
};
