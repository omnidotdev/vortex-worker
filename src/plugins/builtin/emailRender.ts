/**
 * Built-in Email Render Plugin
 *
 * Renders transactional email templates via the Auth API render endpoint.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Email render input parameters */
type EmailRenderInput = {
  /** Identifier of the template to render */
  templateId: string;
  /** Data interpolated into the template */
  templateData?: Record<string, unknown>;
};

/**
 * Render an email template.
 */
const renderEmail = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { templateId, templateData } = inputs as unknown as EmailRenderInput;

    const authApiUrl = process.env.AUTH_API_URL;
    const renderSecret = process.env.EMAIL_RENDER_SECRET;

    if (!authApiUrl || !renderSecret) {
      return {
        success: false,
        error: "Email render not configured (AUTH_API_URL/EMAIL_RENDER_SECRET)",
        durationMs: performance.now() - startTime,
      };
    }

    const response = await fetch(`${authApiUrl}/api/email/render`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${renderSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ templateId, templateData }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Email render failed: ${response.status} ${response.statusText}`,
        durationMs: performance.now() - startTime,
      };
    }

    const { html, subject } = (await response.json()) as {
      html: string;
      subject: string;
    };

    return {
      success: true,
      output: { html, subject },
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
 * Email Render built-in plugin definition.
 */
export const emailRenderPlugin: BuiltinPlugin = {
  id: "builtin:emailRender",
  name: "Email Render",
  description: "Render transactional email templates via the Auth API",
  actions: {
    render: {
      name: "render",
      description: "Render an email template to HTML and subject",
      handler: renderEmail,
    },
  },
};
