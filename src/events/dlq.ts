/**
 * DLQ reader and retry utilities for event routing.
 *
 * Provides:
 * - `withRetry` — retry with exponential backoff
 * - `writeToDlq` — persist failed events to Postgres dead_letter_event table
 * - Iggy-backed DLQ inspection and management (list, stats, replay, discard)
 */

import { Client, Partitioning } from "@iggy.rs/sdk";
import { getDb } from "db";
import { deadLetterEventTable } from "db/schema";

import logger from "lib/logger";

import type { DlqEvent, EventsConfig, OmniEvent } from "./types";

// -- Retry + Postgres DLQ writer --

type RetryConfig = {
  /** Maximum number of attempts (including the first). */
  maxAttempts: number;
  /** Base delay in milliseconds; scaled by 4^(attempt-1). */
  baseDelayMs: number;
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
};

type DlqErrorCode =
  | "ROUTING_ERROR"
  | "TRANSFORM_ERROR"
  | "SCHEMA_VALIDATION_ERROR"
  | "SCHEMA_VERSION_MISMATCH"
  | "DISPATCH_ERROR";

/**
 * Retry a function with exponential backoff.
 *
 * Delays between attempts follow `baseDelayMs * 4^(attempt-1)`:
 * 1s, 4s, 16s (with default config).
 * @param fn - Async function to retry
 * @param config - Retry configuration (maxAttempts, baseDelayMs)
 * @returns Result of the function on success
 * @throws Last error after all attempts are exhausted
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const { maxAttempts, baseDelayMs } = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 4 ** (attempt - 1);
        await Bun.sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Write a failed event to the Postgres dead_letter_event table.
 *
 * Wrapped in try/catch so DLQ write failures never crash the consumer loop.
 * @param event - Original event that failed to route
 * @param routingRuleId - ID of the routing rule that matched
 * @param error - Error that caused the failure
 * @param errorCode - Classification of the failure
 * @param attempts - Number of retry attempts made
 */
async function writeToDlq(
  event: OmniEvent,
  routingRuleId: string,
  error: unknown,
  errorCode: DlqErrorCode,
  attempts: number,
): Promise<void> {
  try {
    const db = getDb();

    await db.insert(deadLetterEventTable).values({
      originalEventId: event.id,
      eventType: event.type,
      eventSource: event.source,
      eventData: event.data,
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      routingRuleId,
      attempts,
      lastAttemptAt: new Date(),
      organizationId: event.organizationId,
    });

    logger.info("Event written to dead-letter table", {
      eventId: event.id,
      errorCode,
      routingRuleId,
      attempts,
    });
  } catch (dlqErr) {
    logger.error("Failed to write to dead-letter table", {
      eventId: event.id,
      error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
}

const STREAM_ID = 1;
const DLQ_CONSUMER_GROUP = "vortex-dlq-reader";
const DLQ_CONSUMER_ID = 200;

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

    // Use offset-based polling (kind 1) to read without advancing offsets
    const response = await client.message.poll({
      streamId: STREAM_ID,
      topicId: dlqTopic,
      consumer: { kind: 1, id: DLQ_CONSUMER_ID },
      partitionId: 0,
      pollingStrategy: { kind: 1, value: BigInt(offset) },
      count: limit,
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

    return events;
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

    // Extract message count from topic partitions metadata
    const totalMessages = Number(
      topicInfo.partitions.reduce((sum, p) => sum + p.messagesCount, 0n),
    );

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

    // Scan messages using offset-based polling to find the target event
    const batchSize = 50;
    let found = false;
    let currentOffset = 0;

    // Safety limit to avoid infinite loops
    const maxBatches = 100;
    let batches = 0;

    while (!found && batches < maxBatches) {
      batches++;

      const response = await client.message.poll({
        streamId: STREAM_ID,
        topicId: dlqTopic,
        consumer: { kind: 1, id: DLQ_CONSUMER_ID },
        partitionId: 0,
        pollingStrategy: { kind: 1, value: BigInt(currentOffset) },
        count: batchSize,
        autocommit: false,
      });

      if (response.messages.length === 0) break;

      for (const message of response.messages) {
        try {
          const dlqEvent = JSON.parse(message.payload.toString()) as DlqEvent;

          if (dlqEvent.originalEvent.id === eventId) {
            found = true;

            // Commit the offset to the consumer group so the event
            // is not returned by future group-based reads
            await client.offset.store({
              streamId: STREAM_ID,
              topicId: dlqTopic,
              consumer: { kind: 2, id: DLQ_CONSUMER_GROUP },
              partitionId: 0,
              offset: BigInt(currentOffset + 1),
            });

            break;
          }

          currentOffset++;
        } catch {
          currentOffset++;
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

export type { DlqErrorCode, DlqQuery, DlqStats, RetryConfig };
export {
  discardDlqEvent,
  getDlqStats,
  listDlqEvents,
  replayDlqEvent,
  withRetry,
  writeToDlq,
};
