import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

import type { EventAdapter, NormalizedEvent } from "./types";

export class SqsAdapter implements EventAdapter {
  name = "sqs";
  source = "sqs";

  private client: SQSClient;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private running = false;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: {
      queueUrl: string;
      region: string;
      batchSize?: number;
    },
  ) {
    this.client = new SQSClient({ region: config.region });
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.handler) return;

    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.config.queueUrl,
          MaxNumberOfMessages: this.config.batchSize ?? 10,
          WaitTimeSeconds: 20, // Long polling
        }),
      );

      if (response.Messages) {
        for (const message of response.Messages) {
          let data: unknown;
          try {
            data = JSON.parse(message.Body ?? "{}");
          } catch {
            data = message.Body;
          }

          const event: NormalizedEvent = {
            source: `sqs:${this.config.queueUrl}`,
            type: "sqs.message",
            subject: message.MessageId,
            data,
            metadata: {
              idempotencyKey: message.MessageId ?? `sqs-${Date.now()}`,
              timestamp: new Date(),
              raw: {
                messageId: message.MessageId,
                receiptHandle: message.ReceiptHandle,
                attributes: message.Attributes,
              },
            },
          };

          await this.handler(event);

          // Delete message after successful processing
          if (message.ReceiptHandle) {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.config.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
        }
      }
    } catch (err) {
      console.error("[SQS Adapter] Poll error:", err);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimeout = setTimeout(() => this.poll(), 1000);
    }
  }
}
