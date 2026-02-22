/**
 * DLQ reader for inspecting and managing failed events.
 *
 * Provides functions to list, inspect, replay, and discard dead-letter
 * queue events. Connects to Iggy using the same client patterns as
 * the main consumer.
 */

import { Client, Partitioning } from "@iggy.rs/sdk";

import logger from "lib/logger";

import type { DlqEvent, EventsConfig } from "./types";

const STREAM_ID = 1;
const DLQ_CONSUMER_GROUP = "vortex-dlq-reader";

type DlqQuery = {
  organizationId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
};

type DlqStats = {
  totalMessages: number;
  oldestMessage?: string;
  newestMessage?: string;
};

/**
 * Create an authenticated Iggy client.
 */
async function connectIggy(config: EventsConfig): Promise<Client> {
  const client = new Client({
    transport: "TCP",
    options: { host: config.host, port: config.port },
    credentials: {
      username: config.username,
      password: config.password,
    },
  });

  return client;
}

/**
 * Idempotently ensure a consumer group exists for the DLQ topic.
 */
async function ensureConsumerGroup(
  client: Client,
  topicId: string,
): Promise<void> {
  try {
    await client.group.create({
      streamId: STREAM_ID,
      topicId,
      groupId: 0,
      name: DLQ_CONSUMER_GROUP,
    });
  } catch {
    // Group likely already exists
  }
}

/**
 * List dead-letter queue events for a topic.
 *
 * Reads from `{topic}-dlq`, parses messages as `DlqEvent`, applies
 * optional filters by organizationId/workflowId, and returns paginated
 * results.
 * @param config - Iggy connection config
 * @param topic - Base topic name (without `-dlq` suffix)
 * @param query - Optional filters and pagination
 */
async function listDlqEvents(
  config: EventsConfig,
  topic: string,
  query?: DlqQuery,
): Promise<DlqEvent[]> {
  const dlqTopic = `${topic}-dlq`;
  const limit = query?.limit ?? 100;
  const offset = query?.offset ?? 0;
  let client: Client | null = null;

  try {
    client = await connectIggy(config);
    await ensureConsumerGroup(client, dlqTopic);

    // TODO: Iggy SDK — poll messages from the DLQ topic
    // The consumer group approach (kind 2) advances the offset, which is
    // not ideal for listing. Use an absolute offset strategy (kind 1)
    // to read without side effects.
    const response = await client.message.poll({
      streamId: STREAM_ID,
      topicId: dlqTopic,
      consumer: { kind: 2, id: DLQ_CONSUMER_GROUP },
      partitionId: 0,
      pollingStrategy: { kind: 5, value: 0n },
      count: limit + offset,
      autocommit: false,
    });

    const events: DlqEvent[] = [];

    for (const message of response.messages) {
      try {
        const dlqEvent = JSON.parse(message.payload.toString()) as DlqEvent;

        // Apply organizationId filter
        if (
          query?.organizationId &&
          dlqEvent.originalEvent.organizationId !== query.organizationId
        ) {
          continue;
        }

        // Apply workflowId filter (check event data for workflow reference)
        if (query?.workflowId) {
          const data = dlqEvent.originalEvent.data;
          if (data.workflowId !== query.workflowId) continue;
        }

        events.push(dlqEvent);
      } catch (err) {
        logger.warn("Failed to parse DLQ message", {
          topic: dlqTopic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Apply pagination after filtering
    return events.slice(offset, offset + limit);
  } catch (err) {
    logger.error("Failed to list DLQ events", {
      topic: dlqTopic,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    client?.destroy();
  }
}

/**
 * Get basic stats about a DLQ topic.
 *
 * Returns the total message count and oldest/newest timestamps.
 * @param config - Iggy connection config
 * @param topic - Base topic name (without `-dlq` suffix)
 */
async function getDlqStats(
  config: EventsConfig,
  topic: string,
): Promise<DlqStats> {
  const dlqTopic = `${topic}-dlq`;
  let client: Client | null = null;

  try {
    client = await connectIggy(config);

    // Fetch topic metadata to get partition-level message counts
    const topicInfo = await client.topic.get({
      streamId: STREAM_ID,
      topicId: dlqTopic,
    });

    // TODO: Iggy SDK — extract message count from topic metadata
    // The shape depends on the SDK version; adapt as needed
    const totalMessages =
      ((topicInfo as Record<string, unknown>).messagesCount as number) ?? 0;

    // Read first and last messages to get timestamp boundaries
    let oldestMessage: string | undefined;
    let newestMessage: string | undefined;

    if (totalMessages > 0) {
      try {
        // Fetch the oldest message (offset 0)
        const oldestResponse = await client.message.poll({
          streamId: STREAM_ID,
          topicId: dlqTopic,
          consumer: { kind: 1, id: 0 },
          partitionId: 1,
          pollingStrategy: { kind: 1, value: 0n },
          count: 1,
          autocommit: false,
        });

        if (oldestResponse.messages.length > 0) {
          const event = JSON.parse(
            oldestResponse.messages[0].payload.toString(),
          ) as DlqEvent;
          oldestMessage = event.failedAt;
        }

        // Fetch the newest message (last offset)
        const newestResponse = await client.message.poll({
          streamId: STREAM_ID,
          topicId: dlqTopic,
          consumer: { kind: 1, id: 0 },
          partitionId: 1,
          pollingStrategy: { kind: 2, value: 0n },
          count: 1,
          autocommit: false,
        });

        if (newestResponse.messages.length > 0) {
          const event = JSON.parse(
            newestResponse.messages[0].payload.toString(),
          ) as DlqEvent;
          newestMessage = event.failedAt;
        }
      } catch (err) {
        logger.debug("Failed to read DLQ boundary messages", {
          topic: dlqTopic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { totalMessages, oldestMessage, newestMessage };
  } catch (err) {
    logger.error("Failed to get DLQ stats", {
      topic: dlqTopic,
      error: err instanceof Error ? err.message : String(err),
    });
    return { totalMessages: 0 };
  } finally {
    client?.destroy();
  }
}

/**
 * Re-publish a DLQ event back to its original topic for reprocessing.
 *
 * Takes the `originalEvent` from the DLQ envelope and publishes it
 * to the `originalTopic`, allowing the consumer to retry processing.
 * @param config - Iggy connection config
 * @param dlqEvent - DLQ envelope containing the original event
 * @returns `true` on success, `false` on failure
 */
async function replayDlqEvent(
  config: EventsConfig,
  dlqEvent: DlqEvent,
): Promise<boolean> {
  let client: Client | null = null;

  try {
    client = await connectIggy(config);

    const partition = dlqEvent.originalEvent.subject
      ? Partitioning.MessageKey(dlqEvent.originalEvent.subject)
      : Partitioning.Balanced;

    await client.message.send({
      streamId: STREAM_ID,
      topicId: dlqEvent.originalTopic,
      messages: [
        {
          payload: Buffer.from(JSON.stringify(dlqEvent.originalEvent)),
        },
      ],
      partition,
    });

    logger.info("Replayed DLQ event to original topic", {
      eventId: dlqEvent.originalEvent.id,
      topic: dlqEvent.originalTopic,
      attemptCount: dlqEvent.attemptCount,
    });

    return true;
  } catch (err) {
    logger.error("Failed to replay DLQ event", {
      eventId: dlqEvent.originalEvent.id,
      topic: dlqEvent.originalTopic,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    client?.destroy();
  }
}

/**
 * Discard a DLQ event by advancing the consumer offset past it.
 *
 * Acknowledges the event so it will not be read again by the DLQ
 * consumer group.
 * @param config - Iggy connection config
 * @param topic - Base topic name (without `-dlq` suffix)
 * @param eventId - ID of the original event to discard
 * @returns `true` on success, `false` on failure
 */
async function discardDlqEvent(
  config: EventsConfig,
  topic: string,
  eventId: string,
): Promise<boolean> {
  const dlqTopic = `${topic}-dlq`;
  let client: Client | null = null;

  try {
    client = await connectIggy(config);
    await ensureConsumerGroup(client, dlqTopic);

    // Poll messages until we find the target event, auto-committing
    // offsets to advance past it
    // TODO: Iggy SDK — seek to the specific offset containing `eventId`
    // and commit that offset. For now, poll in batches until found.
    const batchSize = 50;
    let found = false;

    // Safety limit to avoid infinite loops
    const maxAttempts = 100;
    let attempts = 0;

    while (!found && attempts < maxAttempts) {
      attempts++;

      const response = await client.message.poll({
        streamId: STREAM_ID,
        topicId: dlqTopic,
        consumer: { kind: 2, id: DLQ_CONSUMER_GROUP },
        partitionId: 0,
        pollingStrategy: { kind: 5, value: 0n },
        count: batchSize,
        autocommit: true,
      });

      if (response.messages.length === 0) break;

      for (const message of response.messages) {
        try {
          const dlqEvent = JSON.parse(message.payload.toString()) as DlqEvent;

          if (dlqEvent.originalEvent.id === eventId) {
            found = true;
            break;
          }
        } catch {
          // Skip malformed messages
        }
      }
    }

    if (found) {
      logger.info("Discarded DLQ event", { eventId, topic: dlqTopic });
    } else {
      logger.warn("DLQ event not found for discard", {
        eventId,
        topic: dlqTopic,
      });
    }

    return found;
  } catch (err) {
    logger.error("Failed to discard DLQ event", {
      eventId,
      topic: dlqTopic,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    client?.destroy();
  }
}

export { discardDlqEvent, getDlqStats, listDlqEvents, replayDlqEvent };

export type { DlqQuery, DlqStats };
