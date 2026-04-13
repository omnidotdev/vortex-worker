import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

type SseAdapterConfig = {
  url: string;
  headers?: Record<string, string>;
  eventTypes?: string[];
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
};

export class SseAdapter implements EventAdapter {
  name = "sse";
  source: string;

  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private reconnectAttempts = 0;

  #config: {
    url: string;
    headers: Record<string, string>;
    eventTypes: string[];
    reconnectDelayMs: number;
    maxReconnectAttempts: number;
  };

  constructor(config: SseAdapterConfig) {
    this.#config = {
      url: config.url,
      headers: config.headers ?? {},
      eventTypes: config.eventTypes ?? [],
      reconnectDelayMs: config.reconnectDelayMs ?? 5_000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
    };

    this.source = `sse:${this.#config.url}`;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    return this.#connect();
  }

  async #connect(): Promise<void> {
    this.controller = new AbortController();

    try {
      const response = await fetch(this.#config.url, {
        headers: {
          Accept: "text/event-stream",
          ...this.#config.headers,
        },
        signal: this.controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      this.reconnectAttempts = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Current SSE event fields
      let eventType = "message";
      let eventData = "";
      let eventId = "";

      while (this.running) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep incomplete last line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith(":")) continue;

          if (line === "") {
            // Empty line = dispatch event
            if (eventData) {
              await this.#dispatch(eventType, eventData.trimEnd(), eventId);
            }
            eventType = "message";
            eventData = "";
            eventId = "";
            continue;
          }

          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) continue;

          const field = line.substring(0, colonIdx);
          // Strip leading space after colon per SSE spec
          const val =
            line[colonIdx + 1] === " "
              ? line.substring(colonIdx + 2)
              : line.substring(colonIdx + 1);

          switch (field) {
            case "event":
              eventType = val;
              break;
            case "data":
              eventData += `${val}\n`;
              break;
            case "id":
              eventId = val;
              break;
            case "retry":
              // Update reconnect delay if server requests
              {
                const ms = Number.parseInt(val, 10);
                if (!Number.isNaN(ms)) {
                  this.#config.reconnectDelayMs = ms;
                }
              }
              break;
          }
        }
      }
    } catch (err) {
      if (!this.running) return;

      logger.error("SSE connection error", {
        url: this.#config.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Reconnect if still running
    if (
      this.running &&
      this.reconnectAttempts < this.#config.maxReconnectAttempts
    ) {
      this.reconnectAttempts++;
      logger.info("SSE reconnecting", {
        url: this.#config.url,
        attempt: this.reconnectAttempts,
      });
      this.reconnectTimer = setTimeout(() => {
        this.#connect().catch((err) => {
          logger.error("SSE reconnect failed", {
            url: this.#config.url,
            attempt: this.reconnectAttempts,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.#config.reconnectDelayMs);
    }
  }

  async #dispatch(
    eventType: string,
    rawData: string,
    eventId: string,
  ): Promise<void> {
    if (!this.handler) return;

    // Filter by event types if configured
    if (
      this.#config.eventTypes.length > 0 &&
      !this.#config.eventTypes.includes(eventType)
    ) {
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }

    const event: NormalizedEvent = {
      source: this.source,
      type: `sse.${eventType}`,
      data,
      metadata: {
        idempotencyKey:
          eventId ||
          `sse-${this.#config.url}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        timestamp: new Date(),
        raw: { eventType, eventId },
      },
    };

    this.handler(event).catch((err) => {
      logger.error("SSE event handler failed", {
        url: this.#config.url,
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}
