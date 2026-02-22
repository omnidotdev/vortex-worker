import type { EventAdapter, NormalizedEvent } from "./types";

type WebSocketAdapterConfig = {
  url: string;
  messageFormat?: "json" | "text";
  heartbeatIntervalMs?: number;
  authHeaders?: Record<string, string>;
  initMessage?: unknown;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
};

export class WebSocketAdapter implements EventAdapter {
  name = "websocket";
  source = "websocket";

  private ws: WebSocket | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private reconnectAttempts = 0;

  #config: Required<
    Omit<WebSocketAdapterConfig, "authHeaders" | "initMessage">
  > & {
    authHeaders?: Record<string, string>;
    initMessage?: unknown;
  };

  constructor(config: WebSocketAdapterConfig) {
    this.#config = {
      url: config.url,
      messageFormat: config.messageFormat ?? "json",
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
      authHeaders: config.authHeaders,
      initMessage: config.initMessage,
      reconnectDelayMs: config.reconnectDelayMs ?? 5_000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
    };
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    return this.#connect();
  }

  #connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Bun's WebSocket supports headers via options
        this.ws = new WebSocket(this.#config.url);

        this.ws.addEventListener("open", () => {
          this.reconnectAttempts = 0;

          // Send init message if configured
          if (this.#config.initMessage) {
            this.ws!.send(JSON.stringify(this.#config.initMessage));
          }

          // Start heartbeat
          this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: "ping" }));
            }
          }, this.#config.heartbeatIntervalMs);

          resolve();
        });

        this.ws.addEventListener("message", (event) => {
          if (!this.handler) return;

          let data: unknown;
          if (this.#config.messageFormat === "json") {
            try {
              data = JSON.parse(event.data as string);
            } catch {
              data = event.data;
            }
          } else {
            data = event.data;
          }

          const normalizedEvent: NormalizedEvent = {
            source: `websocket:${this.#config.url}`,
            type: "websocket.message",
            data,
            metadata: {
              idempotencyKey: `ws-${this.#config.url}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              timestamp: new Date(),
            },
          };

          this.handler(normalizedEvent).catch(() => {});
        });

        this.ws.addEventListener("error", (event) => {
          reject(new Error(`WebSocket error: ${String(event)}`));
        });

        this.ws.addEventListener("close", () => {
          this.#clearHeartbeat();

          if (
            this.running &&
            this.reconnectAttempts < this.#config.maxReconnectAttempts
          ) {
            this.reconnectAttempts++;
            this.reconnectTimer = setTimeout(() => {
              this.#connect().catch(() => {});
            }, this.#config.reconnectDelayMs);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  #clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.#clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
