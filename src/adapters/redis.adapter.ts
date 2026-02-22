import Redis from "ioredis";

import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

export class RedisAdapter implements EventAdapter {
  name = "redis";
  source = "redis";

  private subscriber: Redis | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    url?: string;
    channels?: string[];
    patterns?: string[];
  };

  constructor(config: {
    url?: string;
    channels?: string[];
    patterns?: string[];
  }) {
    this.#config = config;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const url = this.#config.url || process.env.CACHE_URL;

    this.subscriber = url ? new Redis(url) : new Redis();

    // Handle exact channel messages
    this.subscriber.on("message", (channel: string, message: string) => {
      if (!this.handler) return;

      const data = this.parseMessage(message);

      const event: NormalizedEvent = {
        source: `redis:${channel}`,
        type: "redis.message",
        subject: channel,
        data,
        metadata: {
          idempotencyKey: `redis-${channel}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          timestamp: new Date(),
        },
      };

      this.handler(event).catch(() => {});
    });

    // Handle pattern-matched messages
    this.subscriber.on(
      "pmessage",
      (pattern: string, channel: string, message: string) => {
        if (!this.handler) return;

        const data = this.parseMessage(message);

        const event: NormalizedEvent = {
          source: `redis:${channel}`,
          type: "redis.message",
          subject: channel,
          data,
          metadata: {
            idempotencyKey: `redis-${channel}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            timestamp: new Date(),
            raw: { pattern },
          },
        };

        this.handler(event).catch(() => {});
      },
    );

    const { channels, patterns } = this.#config;

    if (channels?.length) {
      await this.subscriber.subscribe(...channels);
      logger.info("Redis subscribed to channels", { channels });
    }

    if (patterns?.length) {
      await this.subscriber.psubscribe(...patterns);
      logger.info("Redis subscribed to patterns", { patterns });
    }
  }

  async stop(): Promise<void> {
    if (!this.subscriber) return;

    try {
      await this.subscriber.unsubscribe();
      await this.subscriber.punsubscribe();
      this.subscriber.disconnect();
    } finally {
      this.subscriber = null;
    }
  }

  private parseMessage(message: string): unknown {
    try {
      return JSON.parse(message);
    } catch {
      return message;
    }
  }
}
