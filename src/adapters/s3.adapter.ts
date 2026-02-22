import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

type S3EventType = "created" | "modified" | "deleted";

type S3AdapterConfig = {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  events?: S3EventType[];
  intervalMs?: number;
};

export class S3Adapter implements EventAdapter {
  name = "s3";
  source = "s3";

  private client: S3Client;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private knownObjects = new Map<string, string>();
  private initialized = false;

  #config: Required<
    Pick<
      S3AdapterConfig,
      "bucket" | "prefix" | "region" | "events" | "intervalMs"
    >
  > &
    Pick<S3AdapterConfig, "endpoint">;

  constructor(config: S3AdapterConfig) {
    this.#config = {
      bucket: config.bucket,
      prefix: config.prefix ?? "",
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      events: config.events ?? ["created", "modified"],
      intervalMs: config.intervalMs ?? 30_000,
    };

    this.client = new S3Client({
      region: this.#config.region,
      endpoint: this.#config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Run initial poll to establish baseline
    await this.poll();
    this.pollInterval = setInterval(() => this.poll(), this.#config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.handler && this.initialized) return;

    try {
      const currentObjects = new Map<
        string,
        { etag: string; size: number; lastModified: Date }
      >();
      let continuationToken: string | undefined;

      // Paginate through all objects
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.#config.bucket,
            Prefix: this.#config.prefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const obj of response.Contents ?? []) {
          if (!obj.Key || !obj.ETag) continue;

          currentObjects.set(obj.Key, {
            etag: obj.ETag,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified ?? new Date(),
          });
        }

        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);

      if (!this.initialized) {
        // First poll: store baseline without emitting events
        for (const [key, obj] of currentObjects) {
          this.knownObjects.set(key, obj.etag);
        }
        this.initialized = true;
        return;
      }

      // Detect created and modified objects
      if (
        this.#config.events.includes("created") ||
        this.#config.events.includes("modified")
      ) {
        for (const [key, obj] of currentObjects) {
          const previousEtag = this.knownObjects.get(key);

          if (!previousEtag && this.#config.events.includes("created")) {
            await this.emit(
              key,
              obj.etag,
              obj.size,
              obj.lastModified,
              "created",
            );
          } else if (
            previousEtag &&
            previousEtag !== obj.etag &&
            this.#config.events.includes("modified")
          ) {
            await this.emit(
              key,
              obj.etag,
              obj.size,
              obj.lastModified,
              "modified",
            );
          }
        }
      }

      // Detect deleted objects
      if (this.#config.events.includes("deleted")) {
        for (const [key, etag] of this.knownObjects) {
          if (!currentObjects.has(key)) {
            await this.emit(key, etag, 0, new Date(), "deleted");
          }
        }
      }

      // Update known objects
      this.knownObjects.clear();
      for (const [key, obj] of currentObjects) {
        this.knownObjects.set(key, obj.etag);
      }
    } catch (err) {
      logger.error("S3 poll error", {
        bucket: this.#config.bucket,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async emit(
    key: string,
    etag: string,
    size: number,
    lastModified: Date,
    eventType: S3EventType,
  ): Promise<void> {
    if (!this.handler) return;

    const event: NormalizedEvent = {
      source: `s3:${this.#config.bucket}`,
      type: `s3.object.${eventType}`,
      subject: key,
      data: {
        key,
        bucket: this.#config.bucket,
        etag,
        size,
        lastModified,
        event: eventType,
      },
      metadata: {
        idempotencyKey: `s3-${this.#config.bucket}-${key}-${etag}`,
        timestamp: new Date(),
        raw: { key, etag, size, lastModified },
      },
    };

    await this.handler(event);
  }
}
