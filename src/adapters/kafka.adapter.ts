import { Kafka, Consumer } from "kafkajs";

import type { EventAdapter, NormalizedEvent } from "./types";

import type { EachMessagePayload } from "kafkajs";

export class KafkaAdapter implements EventAdapter {
  name = "kafka";
  source = "kafka";

  private kafka: Kafka;
  private consumer: Consumer;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  constructor(
    private config: {
      brokers: string[];
      topic: string;
      groupId: string;
      fromBeginning?: boolean;
    },
  ) {
    this.kafka = new Kafka({
      clientId: "vortex-worker",
      brokers: config.brokers,
    });
    this.consumer = this.kafka.consumer({ groupId: config.groupId });
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.topic,
      fromBeginning: this.config.fromBeginning ?? false,
    });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        if (!this.handler) return;

        const value = payload.message.value?.toString();
        if (!value) return;

        let data: unknown;
        try {
          data = JSON.parse(value);
        } catch {
          data = value;
        }

        const event: NormalizedEvent = {
          source: `kafka:${this.config.topic}`,
          type: "kafka.message",
          subject: payload.message.key?.toString(),
          data,
          metadata: {
            idempotencyKey: `kafka-${this.config.topic}-${payload.partition}-${payload.message.offset}`,
            timestamp: new Date(
              Number(payload.message.timestamp) || Date.now(),
            ),
            raw: {
              topic: payload.topic,
              partition: payload.partition,
              offset: payload.message.offset,
              headers: payload.message.headers,
            },
          },
        };

        await this.handler(event);
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
