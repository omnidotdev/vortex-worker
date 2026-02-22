import { createHash } from "node:crypto";

import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

type PollingAdapterConfig = {
  url: string;
  intervalMs?: number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  dedup?: {
    mode: "hash" | "field";
    fieldPath?: string;
  };
};

/**
 * Resolve a dot-separated path against an object.
 * @param obj - Source object to traverse.
 * @param path - Dot-delimited field path (e.g. "data.id").
 */
function getByDotPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (acc, key) =>
        acc !== null && acc !== undefined
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
}

export class PollingAdapter implements EventAdapter {
  name = "polling";
  source: string;

  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDedupValue: string | undefined;

  #config: {
    url: string;
    intervalMs: number;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
    dedup: { mode: "hash" | "field"; fieldPath?: string };
  };

  constructor(config: PollingAdapterConfig) {
    this.#config = {
      url: config.url,
      intervalMs: config.intervalMs ?? 60_000,
      method: config.method ?? "GET",
      headers: config.headers,
      body: config.body,
      dedup: {
        mode: config.dedup?.mode ?? "hash",
        fieldPath: config.dedup?.fieldPath,
      },
    };

    this.source = `polling:${this.#config.url}`;
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Run an initial poll immediately
    await this.#poll();

    this.timer = setInterval(() => {
      this.#poll().catch(() => {});
    }, this.#config.intervalMs);
  }

  async #poll(): Promise<void> {
    try {
      const fetchOptions: RequestInit = {
        method: this.#config.method,
        headers: this.#config.headers,
      };

      if (this.#config.method === "POST" && this.#config.body !== undefined) {
        fetchOptions.body = JSON.stringify(this.#config.body);
      }

      const response = await fetch(this.#config.url, fetchOptions);
      const body = await response.text();

      logger.debug("Poll completed", {
        url: this.#config.url,
        status: response.status,
      });

      const dedupValue = this.#computeDedupValue(body);

      if (dedupValue === this.lastDedupValue) {
        logger.debug("Poll dedup: no change detected", {
          url: this.#config.url,
        });
        return;
      }

      this.lastDedupValue = dedupValue;

      if (!this.handler) return;

      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        data = body;
      }

      const event: NormalizedEvent = {
        source: this.source,
        type: "polling.change",
        data,
        metadata: {
          idempotencyKey: `poll-${this.#config.url}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          timestamp: new Date(),
          raw: {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          },
        },
      };

      this.handler(event).catch(() => {});
    } catch (err) {
      logger.error("Poll request failed", {
        url: this.#config.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #computeDedupValue(body: string): string {
    if (this.#config.dedup.mode === "field" && this.#config.dedup.fieldPath) {
      try {
        const parsed = JSON.parse(body);
        const value = getByDotPath(parsed, this.#config.dedup.fieldPath);
        return String(value);
      } catch {
        // Fall back to hash if JSON parsing fails
        return createHash("sha256").update(body).digest("hex");
      }
    }

    return createHash("sha256").update(body).digest("hex");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
