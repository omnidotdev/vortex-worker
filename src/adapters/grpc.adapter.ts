import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

export class GrpcStreamAdapter implements EventAdapter {
  name = "grpc";
  source = "grpc";

  private client: grpc.Client | null = null;
  private stream: grpc.ClientReadableStream<unknown> | null = null;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;

  #config: {
    address: string;
    protoPath: string;
    service: string;
    method: string;
    requestData?: Record<string, unknown>;
    tls?: boolean;
    metadata?: Record<string, string>;
  };

  constructor(config: {
    address: string;
    protoPath: string;
    service: string;
    method: string;
    requestData?: Record<string, unknown>;
    tls?: boolean;
    metadata?: Record<string, string>;
  }) {
    this.#config = config;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const packageDefinition = protoLoader.loadSync(this.#config.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition);

    // Navigate to service constructor (handles nested packages)
    const ServiceConstructor = this.#config.service
      .split(".")
      .reduce(
        (obj: Record<string, unknown>, key) =>
          obj[key] as Record<string, unknown>,
        proto as unknown as Record<string, unknown>,
      ) as unknown as new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => grpc.Client;

    const credentials = this.#config.tls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    this.client = new ServiceConstructor(this.#config.address, credentials);

    const meta = new grpc.Metadata();
    if (this.#config.metadata) {
      for (const [key, value] of Object.entries(this.#config.metadata)) {
        meta.set(key, value);
      }
    }

    // biome-ignore lint/complexity/noBannedTypes: gRPC dynamic client methods are untyped
    const methodFn = (this.client as unknown as Record<string, Function>)[
      this.#config.method
    ];
    if (typeof methodFn !== "function") {
      throw new Error(
        `Method ${this.#config.method} not found on service ${this.#config.service}`,
      );
    }

    this.stream = methodFn.call(
      this.client,
      this.#config.requestData ?? {},
      meta,
    ) as grpc.ClientReadableStream<unknown>;

    this.stream.on("data", (message: unknown) => {
      if (!this.handler) return;

      const event: NormalizedEvent = {
        source: `grpc:${this.#config.service}`,
        type: "grpc.message",
        subject: `${this.#config.service}.${this.#config.method}`,
        data: message,
        metadata: {
          idempotencyKey: `grpc-${this.#config.service}-${this.#config.method}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          timestamp: new Date(),
          raw: {
            service: this.#config.service,
            method: this.#config.method,
          },
        },
      };

      this.handler(event).catch((err) => {
        logger.error("gRPC event handler failed", {
          service: this.#config.service,
          method: this.#config.method,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async stop(): Promise<void> {
    this.stream?.cancel();
    this.client?.close();
  }
}
