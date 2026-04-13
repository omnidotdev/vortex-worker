import { connect } from "nats";

import type { NatsConnection, Subscription } from "nats";
import type { EventAdapter, NormalizedEvent } from "./types";

export class NatsAdapter implements EventAdapter {
  name = "nats";
  source = "nats";

  private connection: NatsConnection | null = null;
  private subscription: Subscription | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    servers: string;
    subject: string;
    queue?: string;
    token?: string;
    user?: string;
    pass?: string;
  };

  constructor(config: {
    servers: string;
    subject: string;
    queue?: string;
    token?: string;
    user?: string;
    pass?: string;
  }) {
    this.#config = config;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.connection = await connect({
      servers: this.#config.servers,
      token: this.#config.token,
      user: this.#config.user,
      pass: this.#config.pass,
    });

    const opts = this.#config.queue ? { queue: this.#config.queue } : undefined;

    this.subscription = this.connection.subscribe(this.#config.subject, opts);

    (async () => {
      for await (const msg of this.subscription!) {
        if (!this.handler) continue;

        let data: unknown;
        try {
          data = JSON.parse(new TextDecoder().decode(msg.data));
        } catch {
          data = new TextDecoder().decode(msg.data);
        }

        const event: NormalizedEvent = {
          source: `nats:${msg.subject}`,
          type: "nats.message",
          subject: msg.subject,
          data,
          metadata: {
            idempotencyKey: `nats-${msg.subject}-${crypto.randomUUID()}`,
            timestamp: new Date(),
            raw: { subject: msg.subject, reply: msg.reply },
          },
        };

        this.handler(event).catch(() => {});
      }
    })();
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    await this.connection?.drain();
  }
}
