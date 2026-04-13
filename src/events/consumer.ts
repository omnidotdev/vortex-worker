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

import type { DlqEvent, EventHandler, EventsConfig, OmniEvent } from "./types";

const STREAM_ID = 1;
const CONSUMER_GROUP_NAME = "vortex-worker";
const POLL_INTERVAL_MS = 100;
const BATCH_SIZE = 10;
const DEFAULT_PARTITIONS = 3;
// 90-day retention
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

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

  constructor(config: EventsConfig, handler: EventHandler) {
    this.#config = config;
    this.#handler = handler;
  }

  /**
   * Connect to Iggy and begin the polling loop.
   */
  async start(): Promise<void> {
    this.#client = new Client({
      transport: "TCP",
      options: { host: this.#config.host, port: this.#config.port },
      credentials: {
        username: this.#config.username,
        password: this.#config.password,
      },
    });

    this.#running = true;

    logger.info("Events consumer started", {
      host: this.#config.host,
      port: this.#config.port,
    });

    this.#schedulePoll();
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
      await this.#poll();
      this.#schedulePoll();
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
      topics = await client.topic.list({ streamId: STREAM_ID });
    } catch (err) {
      // Stream may not exist yet if the API hasn't published anything
      logger.debug("Failed to list topics", {
        error: err instanceof Error ? err.message : String(err),
      });
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
      }
    }
  }

  /**
   * Poll a single topic and dispatch each message to the handler.
   */
  async #pollTopic(client: Client, topicId: string): Promise<void> {
    const response = await client.message.poll({
      streamId: STREAM_ID,
      topicId,
      consumer: { kind: 2, id: CONSUMER_GROUP_NAME },
      partitionId: 0,
      pollingStrategy: { kind: 5, value: 0n },
      count: BATCH_SIZE,
      autocommit: true,
    });

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
      await client.group.create({
        streamId: STREAM_ID,
        topicId,
        groupId: 0,
        name: CONSUMER_GROUP_NAME,
      });
    } catch {
      // Group likely already exists — this is expected
    }

    // Join the consumer group so the server registers this client as a member
    try {
      await client.group.join({
        streamId: STREAM_ID,
        topicId,
        groupId: CONSUMER_GROUP_NAME,
      });
    } catch {
      // Already joined — this is expected on reconnect
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
