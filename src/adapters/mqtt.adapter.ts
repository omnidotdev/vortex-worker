import mqtt from "mqtt";

import type { MqttClient } from "mqtt";
import type { EventAdapter, NormalizedEvent } from "./types";

export class MqttAdapter implements EventAdapter {
  name = "mqtt";
  source = "mqtt";

  private client: MqttClient | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    brokerUrl: string;
    topic: string;
    clientId?: string;
    username?: string;
    password?: string;
    qos?: 0 | 1 | 2;
    cleanSession?: boolean;
  };

  constructor(config: {
    brokerUrl: string;
    topic: string;
    clientId?: string;
    username?: string;
    password?: string;
    qos?: 0 | 1 | 2;
    cleanSession?: boolean;
  }) {
    this.#config = config;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.#config.brokerUrl, {
        clientId: this.#config.clientId,
        username: this.#config.username,
        password: this.#config.password,
        clean: this.#config.cleanSession ?? true,
      });

      this.client.once("connect", () => {
        this.client!.subscribe(
          this.#config.topic,
          { qos: this.#config.qos ?? 0 },
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          },
        );
      });

      this.client.once("error", reject);

      this.client.on("message", (topic, payload, packet) => {
        if (!this.handler) return;

        let data: unknown;
        try {
          data = JSON.parse(payload.toString());
        } catch {
          data = payload.toString();
        }

        const event: NormalizedEvent = {
          source: `mqtt:${topic}`,
          type: "mqtt.message",
          data,
          metadata: {
            idempotencyKey: `mqtt-${topic}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            timestamp: new Date(),
            raw: { topic, qos: packet.qos },
          },
        };

        this.handler(event).catch(() => {});
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.end(false, {}, () => resolve());
    });
  }
}
