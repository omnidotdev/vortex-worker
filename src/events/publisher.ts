/**
 * Singleton Iggy event publisher.
 *
 * Mirrors the API's `EventsClient` pattern as a module singleton
 * (like `lib/cache`). Allows workflows and plugins to emit events
 * back to the streaming layer.
 */

import { randomUUID } from "node:crypto";

import { Client, Partitioning } from "apache-iggy";
import { CompressionAlgorithm } from "apache-iggy/dist/wire/topic/topic.utils.js";

import logger from "lib/logger";
import { RETENTION_MICROSECONDS } from "./retention";

import type { EventInput, EventsConfig, OmniEvent } from "./types";

const STREAM_NAME = "omni-events";
const STREAM_ID = 1;
const DEFAULT_PARTITIONS = 3;

let client: Client | null = null;
const knownTopics = new Set<string>();

/**
 * Connect to Iggy and ensure the base stream exists.
 */
export async function initPublisher(config: EventsConfig): Promise<void> {
  client = new Client({
    transport: "TCP",
    options: { host: config.host, port: config.port },
    credentials: {
      username: config.username,
      password: config.password,
    },
  });

  await ensureStream();

  logger.info("Event publisher initialized", {
    host: config.host,
    port: config.port,
  });
}

/**
 * Publish an event to the organization's topic.
 *
 * Generates `id` and `timestamp` automatically, ensures the org topic
 * exists, and partitions by `subject` when provided.
 * @returns Published event, or `null` if publisher is not initialized
 */
export async function publish(input: EventInput): Promise<OmniEvent | null> {
  if (!client) return null;

  const event: OmniEvent = {
    ...input,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const topicName = input.organizationId;
  await ensureTopic(topicName);

  const partition = event.subject
    ? Partitioning.MessageKey(event.subject)
    : Partitioning.Balanced;

  await client.message.send({
    streamId: STREAM_ID,
    topicId: topicName,
    messages: [{ payload: Buffer.from(JSON.stringify(event)) }],
    partition,
  });

  logger.debug("Event published", {
    eventId: event.id,
    type: event.type,
    topic: topicName,
  });

  return event;
}

/**
 * Check whether the publisher has been initialized.
 */
export function isInitialized(): boolean {
  return client !== null;
}

/**
 * Close the Iggy connection and reset state.
 */
export function closePublisher(): void {
  client?.destroy();
  client = null;
  knownTopics.clear();

  logger.info("Event publisher closed");
}

// -- Private helpers --

/**
 * Idempotently ensure the omni-events stream exists.
 */
async function ensureStream(): Promise<void> {
  if (!client) return;

  try {
    await client.stream.get({ streamId: STREAM_ID });
  } catch {
    await client.stream.create({ streamId: STREAM_ID, name: STREAM_NAME });
    logger.info("Created stream", { streamId: STREAM_ID, name: STREAM_NAME });
  }
}

/**
 * Idempotently ensure a topic exists within the omni-events stream.
 */
async function ensureTopic(name: string): Promise<void> {
  if (knownTopics.has(name)) return;
  if (!client) return;

  try {
    await client.topic.get({ streamId: STREAM_ID, topicId: name });
  } catch {
    await client.topic.create({
      streamId: STREAM_ID,
      name,
      partitionCount: DEFAULT_PARTITIONS,
      compressionAlgorithm: CompressionAlgorithm.None,
      messageExpiry: RETENTION_MICROSECONDS,
    });
    logger.info("Created topic", { streamId: STREAM_ID, topic: name });
  }

  knownTopics.add(name);
}
