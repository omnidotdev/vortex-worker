import { Resend } from "resend";

const { RESEND_API_KEY } = process.env;

// Initialize Resend client (lazy to allow for missing API key during tests)
let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    if (!RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY environment variable is required for email activity",
      );
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
      console.error("[Email] Failed to send email:", error);
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
    console.error("[Email] Exception while sending email:", err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
