import { Resend } from "resend";

import logger from "lib/logger";

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  // biome-ignore lint/suspicious/noConsole: startup warning for operators
  console.warn("RESEND_API_KEY not set — emails will be logged to stdout");
}

// Initialize Resend client (lazy to allow for missing API key during tests)
let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (!resendClient) {
    if (!RESEND_API_KEY) {
      return null;
    }
    resendClient = new Resend(RESEND_API_KEY);
  }
  return resendClient;
}

export interface EmailActivityInput {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
}

export interface EmailActivityOutput {
  success: boolean;
  messageId?: string;
  error?: string;
}

const DEFAULT_FROM_ADDRESS = "Vortex <noreply@vortex.omni.dev>";

export async function executeEmailActivity(
  input: EmailActivityInput,
): Promise<EmailActivityOutput> {
  try {
    const resend = getResendClient();

    if (!resend) {
      const to = Array.isArray(input.to) ? input.to.join(", ") : input.to;
      // biome-ignore lint/suspicious/noConsole: stdout fallback when Resend not configured
      console.info(
        `[Email] ${input.subject} -> ${to}`,
        JSON.stringify(
          { from: input.from ?? DEFAULT_FROM_ADDRESS, body: input.body },
          null,
          2,
        ),
      );

      return { success: true, messageId: "stdout-fallback" };
    }

    const { data, error } = await resend.emails.send({
      from: input.from ?? DEFAULT_FROM_ADDRESS,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
      ...(input.html ? { html: input.body } : { text: input.body }),
      ...(input.replyTo && { replyTo: input.replyTo }),
      ...(input.cc && { cc: input.cc }),
      ...(input.bcc && { bcc: input.bcc }),
    });

    if (error) {
      logger.error("Failed to send email", { error: error.message });
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      messageId: data?.id,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error sending email";
    logger.error("Exception while sending email", { error: errorMessage });
    return {
      success: false,
      error: errorMessage,
    };
  }
}
