import amqplib from "amqplib";

import type { Channel, ChannelModel } from "amqplib";
import type { EventAdapter, NormalizedEvent } from "./types";

export class AmqpAdapter implements EventAdapter {
  name = "amqp";
  source = "amqp";

  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    url: string;
    queue: string;
    exchange?: string;
    routingKey?: string;
    prefetch?: number;
    durable?: boolean;
  };

  constructor(config: {
    url: string;
    queue: string;
    exchange?: string;
    routingKey?: string;
    prefetch?: number;
    durable?: boolean;
  }) {
    this.#config = config;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.connection = await amqplib.connect(this.#config.url);
    this.channel = await this.connection.createChannel();

    if (this.#config.prefetch) {
      await this.channel.prefetch(this.#config.prefetch);
    }

    await this.channel.assertQueue(this.#config.queue, {
      durable: this.#config.durable ?? true,
    });

    if (this.#config.exchange && this.#config.routingKey) {
      await this.channel.bindQueue(
        this.#config.queue,
        this.#config.exchange,
        this.#config.routingKey,
      );
    }

    await this.channel.consume(this.#config.queue, (msg) => {
      if (!msg || !this.handler) return;

      let data: unknown;
      try {
        data = JSON.parse(msg.content.toString());
      } catch {
        data = msg.content.toString();
      }

      const event: NormalizedEvent = {
        source: `amqp:${this.#config.queue}`,
        type: "amqp.message",
        subject: msg.fields.routingKey,
        data,
        metadata: {
          idempotencyKey: `amqp-${this.#config.queue}-${msg.fields.deliveryTag}`,
          timestamp: new Date(),
          raw: {
            exchange: msg.fields.exchange,
            routingKey: msg.fields.routingKey,
            deliveryTag: msg.fields.deliveryTag,
            headers: msg.properties.headers,
          },
        },
      };

      this.handler(event)
        .then(() => this.channel?.ack(msg))
        .catch(() => this.channel?.nack(msg, false, true));
    });
  }

  async stop(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
