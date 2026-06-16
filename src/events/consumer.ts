/**
 * Iggy-backed event consumer.
 *
 * Polls all organization topics from the omni-events stream and
 * dispatches each message to the provided handler. Uses consumer
 * groups (kind 2) so multiple worker instances can share the load.
 */

import { Client, Partitioning, PollingStrategy } from "@iggy.rs/sdk";
import { CompressionAlgorithmKind } from "@iggy.rs/sdk/dist/wire/topic/topic.utils.js";

import logger from "lib/logger";
import { withTimeout } from "./withTimeout";

import type { DlqEvent, EventHandler, EventsConfig, OmniEvent } from "./types";

const STREAM_ID = 1;
// Shared named consumer. Both worker replicas use the same id so the server
// coordinates their per-partition offsets (each message is delivered once).
const CONSUMER_ID = "vortex-worker";
const POLL_INTERVAL_MS = 100;
// Hard ceiling on any single Iggy request. The SDK has no client-side timeout,
// so a half-open connection makes `topic.list` / `message.poll` hang forever,
// freezing the sequential poll loop. On timeout we reconnect and carry on.
const IGGY_OP_TIMEOUT_MS = 5000;
// Hard ceiling on a single event handler. The poll loop awaits the handler
// synchronously, so any hang inside routeEvent (a wedged Redis dedup, a slow
// subscription delivery, a stuck dispatch) would freeze the whole consumer.
// On timeout the event is sent to the DLQ and the loop moves on.
const HANDLER_TIMEOUT_MS = 20_000;
const BATCH_SIZE = 10;
const DEFAULT_PARTITIONS = 3;
// 90-day retention
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Token bucket defaults — VORTEX_MAX_EVENTS_PER_SECOND env var overrides
const DEFAULT_MAX_EVENTS_PER_SECOND = 50;

class EventsConsumer {
  #config: EventsConfig;
  #handler: EventHandler;
  // Optional override for topic discovery. The Iggy SDK's `topic.list`
  // deserialization is incompatible with our server version and throws, so the
  // composition root injects a discovery function (e.g. a DB lookup of org
  // topics) instead of relying on the broken wire call.
  #listTopics?: () => Promise<string[]>;
  #client: Client | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  // Next offset to poll per `${topicId}:${partitionId}`. We poll by explicit
  // offset rather than the SDK's `Next` strategy: against our server version
  // `Next` + autocommit stops returning messages after the first batch, leaving
  // the consumer permanently stalled mid-backlog. Seeded from the server-stored
  // offset on first poll, then advanced locally past each processed batch.
  #partitionOffsets = new Map<string, bigint>();
  // Track which DLQ topics have been created
  #dlqTopics = new Set<string>();
  // Token bucket for rate limiting — null means unlimited
  #tokenBucket: {
    tokens: number;
    lastRefillMs: number;
    maxTokens: number;
    refillRatePerMs: number;
  } | null = null;

  constructor(
    config: EventsConfig,
    handler: EventHandler,
    listTopics?: () => Promise<string[]>,
  ) {
    this.#config = config;
    this.#handler = handler;
    this.#listTopics = listTopics;

    const maxEventsPerSecond = Number(
      process.env.VORTEX_MAX_EVENTS_PER_SECOND ?? DEFAULT_MAX_EVENTS_PER_SECOND,
    );

    if (maxEventsPerSecond > 0) {
      this.#tokenBucket = {
        tokens: maxEventsPerSecond,
        lastRefillMs: Date.now(),
        maxTokens: maxEventsPerSecond,
        refillRatePerMs: maxEventsPerSecond / 1000,
      };
    }
  }

  /**
   * Connect to Iggy and begin the polling loop.
   */
  async start(): Promise<void> {
    this.#connect();
    this.#running = true;

    logger.info("Events consumer started", {
      host: this.#config.host,
      port: this.#config.port,
    });

    this.#schedulePoll();
  }

  /** Open a fresh Iggy client. The SDK connects lazily on the first request. */
  #connect(): void {
    this.#client = new Client({
      transport: "TCP",
      options: { host: this.#config.host, port: this.#config.port },
      credentials: {
        username: this.#config.username,
        password: this.#config.password,
      },
    });
  }

  /**
   * Tear down a wedged connection and open a fresh one.
   *
   * Called when an Iggy request times out or errors. The DLQ topic cache is
   * cleared so the fresh connection re-creates any DLQ topics it needs.
   */
  #reconnect(): void {
    try {
      this.#client?.destroy();
    } catch (err) {
      logger.debug("Error destroying wedged Iggy client", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.#dlqTopics.clear();
    this.#connect();

    logger.warn("Reconnected Iggy consumer after a stalled request");
  }

  /**
   * Stop polling and tear down the Iggy connection.
   */
  stop(): void {
    this.#running = false;

    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    this.#client?.destroy();
    this.#client = null;
    this.#dlqTopics.clear();

    logger.info("Events consumer stopped");
  }

  // -- Private helpers --

  #schedulePoll(): void {
    if (!this.#running) return;

    this.#timer = setTimeout(async () => {
      try {
        await this.#poll();
      } catch (err) {
        // #poll handles its own errors; this is a last-resort guard so an
        // unexpected throw can never break the reschedule chain and silently
        // kill the consumer.
        logger.error("Unexpected error in poll cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.#schedulePoll();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Poll all eligible topics for new messages.
   */
  async #poll(): Promise<void> {
    const client = this.#client;
    if (!client) return;

    let topicNames: string[];

    try {
      // Prefer the injected discovery function; the SDK's topic.list throws a
      // deserialization error against our server, so it is only a fallback.
      topicNames = this.#listTopics
        ? await withTimeout(
            this.#listTopics(),
            IGGY_OP_TIMEOUT_MS,
            "listTopics",
          )
        : (
            await withTimeout(
              client.topic.list({ streamId: STREAM_ID }),
              IGGY_OP_TIMEOUT_MS,
              "topic.list",
            )
          ).map((t) => t.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // A timeout means the TCP connection is wedged; rebuild it. A plain error
      // is usually just an empty stream the API hasn't published to yet.
      if (this.#isTimeout(err)) {
        logger.warn("Iggy topic discovery stalled, reconnecting", {
          error: message,
        });
        this.#reconnect();
      } else {
        logger.debug("Failed to list topics", { error: message });
      }
      return;
    }

    for (const topicName of topicNames) {
      // Skip dead-letter topics
      if (topicName.endsWith("-dlq")) continue;

      try {
        await this.#pollTopic(client, topicName);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);

        // A wedged connection fails for every topic, so don't grind through the
        // rest on a dead client; reconnect and resume cleanly next cycle.
        if (this.#isTimeout(err)) {
          logger.warn("Iggy topic poll stalled, reconnecting", {
            topic: topicName,
            error,
          });
          this.#reconnect();
          return;
        }

        // A topic with a routing rule or subscription but no published events
        // yet has no server-side topic; that is expected, not an error
        if (error.includes("topic_name_not_found")) {
          logger.debug("Topic not yet created, skipping", {
            topic: topicName,
          });
        } else {
          logger.error("Error polling topic", { topic: topicName, error });
        }
      }
    }
  }

  /** True when an error came from {@link withTimeout} exceeding its deadline. */
  #isTimeout(err: unknown): boolean {
    return err instanceof Error && err.message.includes("timed out after");
  }

  /**
   * Block until a rate-limit token is available, then consume it.
   *
   * No-op when no token bucket is configured (VORTEX_MAX_EVENTS_PER_SECOND=0).
   */
  async #consumeToken(): Promise<void> {
    const bucket = this.#tokenBucket;
    if (!bucket) return;

    const now = Date.now();
    const elapsed = now - bucket.lastRefillMs;
    bucket.tokens = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRatePerMs,
    );
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Sleep until enough tokens have accrued for one event
    const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRatePerMs);
    await Bun.sleep(waitMs);
    bucket.tokens = 0;
    bucket.lastRefillMs = Date.now();
  }

  /**
   * Poll a single topic and dispatch each message to the handler.
   */
  async #pollTopic(client: Client, topicId: string): Promise<void> {
    // Poll each partition explicitly by offset as a single named consumer. The
    // SDK's `Next` strategy stalls after the first batch on our server version,
    // so we track the next offset per partition ourselves: seed it from the
    // server-stored offset on first poll, then advance past each batch. The two
    // worker replicas may both poll the same offset; routeEvent's correlationId
    // dedup makes a re-delivered event a no-op, so each event dispatches once.
    const consumer = { kind: 1 as const, id: CONSUMER_ID };

    for (
      let partitionId = 1;
      partitionId <= DEFAULT_PARTITIONS;
      partitionId++
    ) {
      const key = `${topicId}:${partitionId}`;
      const tracked = this.#partitionOffsets.get(key);

      // First poll for a partition uses `Next` (resume from the committed
      // offset); afterwards we poll by explicit offset. We deliberately do NOT
      // call `offset.get` to seed: against a topic that has a routing rule but
      // no published events yet (so no server-side topic), `offset.get` throws
      // an "access memory outside buffer bounds" deserialization error that
      // leaves the shared TCP stream misaligned and silently breaks every later
      // poll on this connection. A `poll` against a missing topic errors
      // cleanly (`topic_name_not_found`) without corrupting the stream.
      const response = await withTimeout(
        client.message.poll({
          streamId: STREAM_ID,
          topicId,
          consumer,
          partitionId,
          pollingStrategy:
            tracked === undefined
              ? PollingStrategy.Next
              : PollingStrategy.Offset(tracked),
          count: BATCH_SIZE,
          autocommit: true,
        }),
        IGGY_OP_TIMEOUT_MS,
        `message.poll:${topicId}:${partitionId}`,
      );

      // Advance our local cursor past the batch so the next poll moves forward
      // even when the server's `Next` tracking does not. On an empty first poll
      // continue from the current end so we never re-issue `Next`.
      if (response.messages.length > 0) {
        const last = response.messages[response.messages.length - 1];
        this.#partitionOffsets.set(key, last.offset + 1n);
      } else if (tracked === undefined) {
        this.#partitionOffsets.set(key, response.currentOffset + 1n);
      }

      for (const message of response.messages) {
        let event: OmniEvent;

        try {
          event = JSON.parse(message.payload.toString()) as OmniEvent;
        } catch (err) {
          logger.error("Failed to parse event payload", {
            topic: topicId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        try {
          await this.#consumeToken();
          await withTimeout(
            this.#handler(event),
            HANDLER_TIMEOUT_MS,
            `handler:${event.type}`,
          );
        } catch (err) {
          logger.error("Event handler failed", {
            eventId: event.id,
            type: event.type,
            topic: topicId,
            error: err instanceof Error ? err.message : String(err),
          });
          await this.#publishToDlq(event, topicId, err);
        }
      }
    }
  }

  /**
   * Publish a failed event to the dead-letter topic.
   *
   * Wrapped in try/catch so DLQ failures never crash the consumer loop.
   */
  async #publishToDlq(
    event: OmniEvent,
    topicName: string,
    error: unknown,
  ): Promise<void> {
    try {
      const client = this.#client;
      if (!client) return;

      const dlqTopic = `${topicName}-dlq`;
      await this.#ensureDlqTopic(dlqTopic);

      const dlqEvent: DlqEvent = {
        originalEvent: event,
        originalTopic: topicName,
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
        attemptCount: 1,
      };

      await client.message.send({
        streamId: STREAM_ID,
        topicId: dlqTopic,
        messages: [{ payload: Buffer.from(JSON.stringify(dlqEvent)) }],
        partition: Partitioning.Balanced,
      });

      logger.debug("Event published to DLQ", {
        eventId: event.id,
        dlqTopic,
      });
    } catch (dlqErr) {
      logger.error("Failed to publish to DLQ", {
        eventId: event.id,
        error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
      });
    }
  }

  /**
   * Idempotently ensure a DLQ topic exists.
   */
  async #ensureDlqTopic(name: string): Promise<void> {
    if (this.#dlqTopics.has(name)) return;

    const client = this.#client;
    if (!client) return;

    try {
      await client.topic.get({ streamId: STREAM_ID, topicId: name });
    } catch {
      await client.topic.create({
        streamId: STREAM_ID,
        topicId: 0,
        name,
        partitionCount: DEFAULT_PARTITIONS,
        compressionAlgorithm: CompressionAlgorithmKind.None,
        messageExpiry: BigInt(RETENTION_SECONDS),
      });
      logger.info("Created DLQ topic", { streamId: STREAM_ID, topic: name });
    }

    this.#dlqTopics.add(name);
  }
}

export default EventsConsumer;
