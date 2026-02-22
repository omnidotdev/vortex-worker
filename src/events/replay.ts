/**
 * Event replay engine.
 *
 * Reads historical events from Iggy topics and re-publishes them
 * through the existing event pipeline. Supports time-range filtering,
 * glob-based source/type matching, and configurable rate limiting.
 */

import { Client } from "@iggy.rs/sdk";

import logger from "lib/logger";
import { publish } from "./publisher";

import type { EventsConfig, OmniEvent } from "./types";

const STREAM_ID = 1;
const REPLAY_CONSUMER_GROUP = "vortex-replay";
const DEFAULT_MAX_RATE = 100;
const POLL_BATCH_SIZE = 50;
const PROGRESS_LOG_INTERVAL = 100;

type ReplayOptions = {
  /** Replay events from this timestamp */
  from: string;
  /** Replay events until this timestamp */
  to: string;
  /** Filter by event source (glob pattern) */
  source?: string;
  /** Filter by event type (glob pattern) */
  type?: string;
  /** Target specific workflow ID */
  targetWorkflowId?: string;
  /** Max events per second (default: 100) */
  maxRate?: number;
};

type ReplayResult = {
  replayed: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

/**
 * Match a glob-style pattern against a value.
 *
 * Supports:
 * - `"*"` matches everything
 * - `"prefix.*"` matches `"prefix.anything"`
 * - `"exact"` matches exactly `"exact"`
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;

  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(value);
}

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
 * Idempotently ensure a consumer group exists for the replay reader.
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
      name: REPLAY_CONSUMER_GROUP,
    });
  } catch {
    // Group likely already exists
  }
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether an event falls within the specified time range.
 */
function isInTimeRange(timestamp: string, from: string, to: string): boolean {
  const t = new Date(timestamp).getTime();
  return t >= new Date(from).getTime() && t <= new Date(to).getTime();
}

/**
 * Check whether an event matches the replay filters.
 */
function matchesFilters(event: OmniEvent, options: ReplayOptions): boolean {
  // Timestamp range is required
  if (!isInTimeRange(event.timestamp, options.from, options.to)) {
    return false;
  }

  // Source glob filter
  if (options.source && !matchGlob(options.source, event.source)) {
    return false;
  }

  // Type glob filter
  if (options.type && !matchGlob(options.type, event.type)) {
    return false;
  }

  // Workflow ID filter (check event data)
  if (
    options.targetWorkflowId &&
    event.data.workflowId !== options.targetWorkflowId
  ) {
    return false;
  }

  return true;
}

/**
 * Replay events from an Iggy topic within a time range.
 *
 * Reads events from the topic, applies filters (timestamp range,
 * source/type glob patterns), and re-publishes matching events
 * through the existing publisher at the configured rate limit.
 * @param config - Iggy connection config
 * @param topic - Topic name to replay from
 * @param options - Replay filters and rate limiting options
 */
async function replayEvents(
  config: EventsConfig,
  topic: string,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const startTime = Date.now();
  const maxRate = options.maxRate ?? DEFAULT_MAX_RATE;
  const result: ReplayResult = {
    replayed: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
  };

  let client: Client | null = null;

  logger.info("Starting event replay", {
    topic,
    from: options.from,
    to: options.to,
    source: options.source,
    type: options.type,
    maxRate,
  });

  try {
    client = await connectIggy(config);
    await ensureConsumerGroup(client, topic);

    // Track rate limiting across batches
    let replayedInWindow = 0;
    let windowStart = Date.now();
    let endOfTopic = false;

    while (!endOfTopic) {
      // TODO: Iggy SDK — use an offset-based polling strategy to read
      // from the beginning of the topic without committing offsets.
      // The current approach uses consumer group polling (kind 2) which
      // will advance the group offset. Consider using kind 1 (consumer)
      // with explicit offset tracking for idempotent replays.
      const response = await client.message.poll({
        streamId: STREAM_ID,
        topicId: topic,
        consumer: { kind: 2, id: REPLAY_CONSUMER_GROUP },
        partitionId: 0,
        pollingStrategy: { kind: 5, value: 0n },
        count: POLL_BATCH_SIZE,
        autocommit: false,
      });

      if (response.messages.length === 0) {
        endOfTopic = true;
        break;
      }

      for (const message of response.messages) {
        let event: OmniEvent;

        try {
          event = JSON.parse(message.payload.toString()) as OmniEvent;
        } catch {
          result.skipped++;
          continue;
        }

        // Stop early if we've passed the time window
        const eventTime = new Date(event.timestamp).getTime();
        const toTime = new Date(options.to).getTime();

        if (eventTime > toTime) {
          endOfTopic = true;
          break;
        }

        // Apply filters
        if (!matchesFilters(event, options)) {
          result.skipped++;
          continue;
        }

        // Rate limiting: enforce maxRate events per second
        replayedInWindow++;

        if (replayedInWindow >= maxRate) {
          const elapsed = Date.now() - windowStart;
          const remaining = 1000 - elapsed;

          if (remaining > 0) {
            await sleep(remaining);
          }

          replayedInWindow = 0;
          windowStart = Date.now();
        }

        // Re-publish through the existing event publisher
        try {
          await publish({
            type: event.type,
            source: event.source,
            subject: event.subject,
            data: event.data,
            organizationId: event.organizationId,
            correlationId: event.correlationId,
            schemaId: event.schemaId,
          });
          result.replayed++;
        } catch (err) {
          result.failed++;
          logger.warn("Failed to replay event", {
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Log progress at regular intervals
        const total = result.replayed + result.skipped + result.failed;

        if (total > 0 && total % PROGRESS_LOG_INTERVAL === 0) {
          logger.info("Replay progress", {
            topic,
            replayed: result.replayed,
            skipped: result.skipped,
            failed: result.failed,
            total,
          });
        }
      }
    }

    result.durationMs = Date.now() - startTime;

    logger.info("Event replay complete", {
      topic,
      replayed: result.replayed,
      skipped: result.skipped,
      failed: result.failed,
      durationMs: result.durationMs,
    });

    return result;
  } catch (err) {
    result.durationMs = Date.now() - startTime;

    logger.error("Event replay failed", {
      topic,
      error: err instanceof Error ? err.message : String(err),
      replayed: result.replayed,
      skipped: result.skipped,
      failed: result.failed,
      durationMs: result.durationMs,
    });

    return result;
  } finally {
    client?.destroy();
  }
}

export { matchGlob, replayEvents };

export type { ReplayOptions, ReplayResult };
