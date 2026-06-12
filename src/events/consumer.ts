/**
 * Iggy-backed event consumer.
 *
 * Polls all organization topics from the omni-events stream and
 * dispatches each message to the provided handler. Uses consumer
 * groups (kind 2) so multiple worker instances can share the load.
 */

import { Client, Partitioning } from "@iggy.rs/sdk";
import { CompressionAlgorithmKind } from "@iggy.rs/sdk/dist/wire/topic/topic.utils.js";

import logger from "lib/logger";
import { withTimeout } from "./withTimeout";

import type { DlqEvent, EventHandler, EventsConfig, OmniEvent } from "./types";

const STREAM_ID = 1;
const CONSUMER_GROUP_NAME = "vortex-worker";
const POLL_INTERVAL_MS = 100;
// Hard ceiling on any single Iggy request. The SDK has no client-side timeout,
// so a half-open connection makes `topic.list` / `message.poll` hang forever,
// freezing the sequential poll loop. On timeout we reconnect and carry on.
const IGGY_OP_TIMEOUT_MS = 5000;
const BATCH_SIZE = 10;
const DEFAULT_PARTITIONS = 3;
// 90-day retention
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Token bucket defaults — VORTEX_MAX_EVENTS_PER_SECOND env var overrides
const DEFAULT_MAX_EVENTS_PER_SECOND = 50;

class EventsConsumer {
  #config: EventsConfig;
  #handler: EventHandler;
  #client: Client | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  // Track which topics already have a consumer group created
  #consumerGroups = new Set<string>();
  // Track which DLQ topics have been created
  #dlqTopics = new Set<string>();
  // Token bucket for rate limiting — null means unlimited
  #tokenBucket: {
    tokens: number;
    lastRefillMs: number;
    maxTokens: number;
    refillRatePerMs: number;
  } | null = null;

  constructor(config: EventsConfig, handler: EventHandler) {
    this.#config = config;
    this.#handler = handler;

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
   * Called when an Iggy request times out or errors. The consumer-group and DLQ
   * topic caches are cleared so the new connection re-creates and re-joins its
   * groups before polling again.
   */
  #reconnect(): void {
    try {
      this.#client?.destroy();
    } catch (err) {
      logger.debug("Error destroying wedged Iggy client", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.#consumerGroups.clear();
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
    this.#consumerGroups.clear();
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

    let topics: Array<{ id: number; name: string }>;

    try {
      topics = await withTimeout(
        client.topic.list({ streamId: STREAM_ID }),
        IGGY_OP_TIMEOUT_MS,
        "topic.list",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // A timeout means the TCP connection is wedged; rebuild it. A plain error
      // is usually just an empty stream the API hasn't published to yet.
      if (this.#isTimeout(err)) {
        logger.warn("Iggy topic.list stalled, reconnecting", {
          error: message,
        });
        this.#reconnect();
      } else {
        logger.debug("Failed to list topics", { error: message });
      }
      return;
    }

    for (const topic of topics) {
      // Skip dead-letter topics
      if (topic.name.endsWith("-dlq")) continue;

      try {
        await this.#ensureConsumerGroup(topic.name);
        await this.#pollTopic(client, topic.name);
      } catch (err) {
        logger.error("Error polling topic", {
          topic: topic.name,
          error: err instanceof Error ? err.message : String(err),
        });

        // A wedged connection fails for every topic, so don't grind through the
        // rest on a dead client; reconnect and resume cleanly next cycle.
        if (this.#isTimeout(err)) {
          this.#reconnect();
          return;
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
    const response = await withTimeout(
      client.message.poll({
        streamId: STREAM_ID,
        topicId,
        consumer: { kind: 2, id: CONSUMER_GROUP_NAME },
        partitionId: 0,
        pollingStrategy: { kind: 5, value: 0n },
        count: BATCH_SIZE,
        autocommit: true,
      }),
      IGGY_OP_TIMEOUT_MS,
      `message.poll:${topicId}`,
    );

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
        await this.#handler(event);
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

  /**
   * Idempotently create a consumer group for a topic.
   *
   * Consumer groups must exist before polling with kind 2. We cache
   * known groups in memory so we only call create once per topic.
   */
  async #ensureConsumerGroup(topicId: string): Promise<void> {
    if (this.#consumerGroups.has(topicId)) return;

    const client = this.#client;
    if (!client) return;

    try {
      await withTimeout(
        client.group.create({
          streamId: STREAM_ID,
          topicId,
          groupId: 0,
          name: CONSUMER_GROUP_NAME,
        }),
        IGGY_OP_TIMEOUT_MS,
        `group.create:${topicId}`,
      );
    } catch (err) {
      // A timeout means a wedged connection; surface it so #poll reconnects.
      // Any other error just means the group already exists, which is expected.
      if (this.#isTimeout(err)) throw err;
    }

    // Join the consumer group so the server registers this client as a member
    try {
      await withTimeout(
        client.group.join({
          streamId: STREAM_ID,
          topicId,
          groupId: CONSUMER_GROUP_NAME,
        }),
        IGGY_OP_TIMEOUT_MS,
        `group.join:${topicId}`,
      );
    } catch (err) {
      if (this.#isTimeout(err)) throw err;
      // Already joined, this is expected on reconnect
    }

    this.#consumerGroups.add(topicId);
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
