/**
 * Built-in Email Plugin
 *
 * Sends emails via Herald through the notification provider.
 */

import { createNotificationProvider } from "@omnidotdev/providers";

import type { NotificationProvider } from "@omnidotdev/providers";
import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Default sender address */
const DEFAULT_FROM = "Omni <noreply@send.omni.dev>";

/** Module-level singleton notification provider */
let provider: NotificationProvider | null = null;
/** Env signature the cached provider was built from */
let providerKey: string | null = null;

/**
 * Get the notification provider.
 *
 * Builds a Herald provider when `HERALD_API_URL` and `HERALD_API_KEY` are set,
 * otherwise a noop provider that logs and returns success. Cached as a
 * module-level singleton keyed on the resolved env so the same instance is
 * reused across calls.
 */
const getProvider = (): NotificationProvider => {
  const apiUrl = process.env.HERALD_API_URL;
  const apiKey = process.env.HERALD_API_KEY;
  const key = `${apiUrl ?? ""}|${apiKey ?? ""}`;

  if (provider && providerKey === key) {
    return provider;
  }

  if (apiUrl && apiKey) {
    provider = createNotificationProvider({
      provider: "herald",
      apiKey,
      apiUrl,
      defaultFrom:
        process.env.HERALD_SENDER_EMAIL_ADDRESS ??
        process.env.SENDER_EMAIL_ADDRESS ??
        DEFAULT_FROM,
    });
  } else {
    provider = createNotificationProvider({});
  }

  providerKey = key;

  return provider;
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
  /** Sender address override */
  from?: string;
  /** Reply-to address */
  replyTo?: string;
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
      from,
      replyTo,
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

    // Normalize recipients to arrays
    const toList = Array.isArray(to) ? to : [to];
    const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccList = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;

    const result = await getProvider().sendEmail({
      to: toList,
      subject,
      body,
      html: contentType === "html",
      ...(from && { from }),
      ...(replyTo && { replyTo }),
      ...(ccList && { cc: ccList }),
      ...(bccList && { bcc: bccList }),
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        sent: result.success,
        recipients: toList.length,
        messageId: result.messageId,
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
  description: "Send emails via Herald",
  actions: {
    send: {
      name: "send",
      description: "Send an email",
      handler: sendEmail,
    },
  },
};
