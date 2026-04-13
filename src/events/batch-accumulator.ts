/**
 * Routing-level batch accumulator for event batching.
 *
 * Collects events into partitions (optionally keyed by a field) and
 * flushes when either `maxSize` or `maxWaitMs` is reached. Used by the
 * event router to accumulate events before triggering a workflow run.
 */

import logger from "lib/logger";

export type BatchConfig = {
  /** Flush when partition reaches this many events */
  maxSize: number;
  /** Flush after this many milliseconds since the first event in a partition */
  maxWaitMs: number;
  /** Field name on the event object to use for partitioning (e.g., "userId") */
  partitionKey?: string;
};

export type BatchMetadata = {
  /** Number of events in this batch */
  size: number;
  /** ISO timestamp of the first event added to this batch */
  windowStart: string;
  /** ISO timestamp of the flush */
  windowEnd: string;
  /** Partition key field name, if configured */
  partitionKey?: string;
  /** Partition key value for this batch */
  partitionValue?: string;
};

type FlushHandler = (
  events: unknown[],
  metadata: BatchMetadata,
) => Promise<void>;

type Partition = {
  events: unknown[];
  timer: ReturnType<typeof setTimeout>;
  windowStart: string;
};

const DEFAULT_PARTITION = "__default__";

/**
 * Accumulate events into partitions and flush on size or time thresholds.
 *
 * Each rule with batch config gets its own `BatchAccumulator` instance.
 * Events are grouped by `config.partitionKey` (or a single default partition)
 * and flushed when `maxSize` is reached or `maxWaitMs` elapses since the
 * first event in that partition.
 */
class BatchAccumulator {
  #ruleId: string;
  #config: BatchConfig;
  #onFlush: FlushHandler;
  #partitions: Map<string, Partition>;

  constructor(ruleId: string, config: BatchConfig, onFlush: FlushHandler) {
    this.#ruleId = ruleId;
    this.#config = config;
    this.#onFlush = onFlush;
    this.#partitions = new Map();
  }

  /**
   * Add an event to the appropriate partition.
   *
   * Starts a timer on the first event in a partition. Flushes immediately
   * when `maxSize` is reached.
   */
  async add(event: unknown): Promise<void> {
    const key = this.#getPartitionValue(event);
    let partition = this.#partitions.get(key);

    if (!partition) {
      partition = {
        events: [],
        timer: setTimeout(() => {
          this.#flush(key).catch((err) => {
            logger.error("Batch timer flush failed", {
              ruleId: this.#ruleId,
              partitionKey: key,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, this.#config.maxWaitMs),
        windowStart: new Date().toISOString(),
      };
      this.#partitions.set(key, partition);
    }

    partition.events.push(event);

    if (partition.events.length >= this.#config.maxSize) {
      await this.#flush(key);
    }
  }

  /**
   * Flush all active partitions.
   *
   * Called during graceful shutdown to ensure no events are lost.
   */
  async shutdown(): Promise<void> {
    const keys = [...this.#partitions.keys()];

    await Promise.all(keys.map((key) => this.#flush(key)));
  }

  /**
   * Flush a single partition: snapshot events, clear timer, delete
   * partition, and invoke the flush handler.
   */
  async #flush(key: string): Promise<void> {
    const partition = this.#partitions.get(key);
    if (!partition) return;

    clearTimeout(partition.timer);
    const events = [...partition.events];
    const windowStart = partition.windowStart;
    this.#partitions.delete(key);

    if (events.length === 0) return;

    const metadata: BatchMetadata = {
      size: events.length,
      windowStart,
      windowEnd: new Date().toISOString(),
      ...(this.#config.partitionKey && {
        partitionKey: this.#config.partitionKey,
        partitionValue: key === DEFAULT_PARTITION ? undefined : key,
      }),
    };

    logger.debug("Flushing batch", {
      ruleId: this.#ruleId,
      partitionKey: key,
      size: events.length,
    });

    await this.#onFlush(events, metadata);
  }

  /**
   * Extract the partition key value from an event object.
   *
   * Returns `DEFAULT_PARTITION` when no `partitionKey` is configured
   * or when the event does not contain the specified field.
   */
  #getPartitionValue(event: unknown): string {
    if (!this.#config.partitionKey) return DEFAULT_PARTITION;

    if (
      event !== null &&
      typeof event === "object" &&
      this.#config.partitionKey in event
    ) {
      const value = (event as Record<string, unknown>)[
        this.#config.partitionKey
      ];

      if (value !== null && value !== undefined) {
        return String(value);
      }
    }

    return DEFAULT_PARTITION;
  }
}

export default BatchAccumulator;
