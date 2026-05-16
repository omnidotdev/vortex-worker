/**
 * Built-in Webhook Response Plugin
 *
 * Returns data to webhook callers.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Webhook response input */
interface WebhookRespondInput {
  /** HTTP status code (default: 200) */
  statusCode?: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** Response body */
  body: unknown;
  /** Content type (default: application/json) */
  contentType?: string;
}

/**
 * Send response to webhook caller.
 */
const respond = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      statusCode = 200,
      headers = {},
      body,
      contentType = "application/json",
    } = inputs as unknown as WebhookRespondInput;

    const response = {
      statusCode,
      headers: { "Content-Type": contentType, ...headers },
      body: contentType.includes("json") ? JSON.stringify(body) : body,
    };

    return {
      success: true,
      output: { _webhookResponse: response },
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
 * Webhook Response built-in plugin definition.
 */
export const webhookResponsePlugin: BuiltinPlugin = {
  id: "builtin:webhookResponse",
  name: "Webhook Response",
  description: "Return data to webhook caller",
  actions: {
    respond: {
      name: "respond",
      description: "Send response to webhook caller",
      handler: respond,
    },
  },
};
