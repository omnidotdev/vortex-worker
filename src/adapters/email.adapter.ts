/**
 * Email trigger adapter.
 *
 * Webhook-style (push) adapter for inbound email via Resend.
 * Unlike polling adapters, this adapter does not actively poll.
 * Instead, events are injected from the webhook endpoint via `ingest()`.
 */

import matchGlob from "lib/glob";
import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

type EmailAdapterConfig = {
  address: string;
  provider?: "resend";
  filters?: {
    from?: string;
    subject?: string;
  };
};

type InboundEmail = {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    content?: string;
  }>;
  headers: Record<string, string>;
  messageId: string;
  inReplyTo?: string;
};

export class EmailAdapter implements EventAdapter {
  name = "email";
  source: string;

  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    address: string;
    provider: "resend";
    filters?: {
      from?: string;
      subject?: string;
    };
  };

  constructor(config: EmailAdapterConfig) {
    this.#config = {
      address: config.address,
      provider: config.provider ?? "resend",
      filters: config.filters,
    };

    this.source = `email:${this.#config.address}`;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  // No-op for push-based adapter; events arrive via `ingest()`
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  /**
   * Ingest an inbound email event from the webhook endpoint.
   *
   * Applies configured filters and, if matched, forwards to the event handler.
   * @returns Whether the email was accepted (matched filters and dispatched)
   */
  async ingest(email: InboundEmail): Promise<boolean> {
    // Apply sender filter
    if (this.#config.filters?.from) {
      if (!matchGlob(this.#config.filters.from, email.from)) {
        logger.debug("Email filtered out by sender pattern", {
          address: this.#config.address,
          from: email.from,
          pattern: this.#config.filters.from,
        });
        return false;
      }
    }

    // Apply subject filter
    if (this.#config.filters?.subject) {
      if (!matchGlob(this.#config.filters.subject, email.subject)) {
        logger.debug("Email filtered out by subject pattern", {
          address: this.#config.address,
          subject: email.subject,
          pattern: this.#config.filters.subject,
        });
        return false;
      }
    }

    if (!this.handler) return false;

    const event: NormalizedEvent = {
      source: this.source,
      type: "email.received",
      subject: email.messageId,
      data: email,
      metadata: {
        idempotencyKey: `email-${email.messageId}`,
        timestamp: new Date(),
        raw: email,
      },
    };

    await this.handler(event);
    return true;
  }
}
