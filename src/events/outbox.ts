/**
 * Transactional outbox sweeper for reliable event publishing.
 *
 * Polls the outbox table for unpublished rows, publishes each to Iggy
 * via `publish()`, and marks them as published. This guarantees
 * at-least-once delivery even if the worker crashes between step
 * completion and Iggy publish.
 */

import { eq, isNull } from "drizzle-orm";
import { getDb } from "db";
import { outboxTable } from "db/schema";

import logger from "lib/logger";

import { publish } from "./publisher";

import type { EventInput } from "./types";

const BATCH_SIZE = 100;
const SWEEP_INTERVAL_MS = 2_000;

/**
 * Background sweeper that drains the outbox table into Iggy.
 */
class OutboxSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Poll for pending outbox rows, publish each, and mark as published.
   * @returns Number of events successfully published
   */
  async sweep(): Promise<number> {
    const db = getDb();

    const pending = await db
      .select()
      .from(outboxTable)
      .where(isNull(outboxTable.publishedAt))
      .limit(BATCH_SIZE)
      .orderBy(outboxTable.createdAt);

    let published = 0;

    for (const row of pending) {
      try {
        await publish(row.payload as EventInput);

        await db
          .update(outboxTable)
          .set({ publishedAt: new Date() })
          .where(eq(outboxTable.id, row.id));

        published++;
      } catch (err) {
        // Skip on failure; will retry on next sweep
        logger.warn("Outbox publish failed, will retry", {
          outboxId: row.id,
          topic: row.topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (published > 0) {
      logger.debug("Outbox sweep completed", { published, total: pending.length });
    }

    return published;
  }

  /**
   * Start the background sweep interval.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        logger.error("Outbox sweep error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, SWEEP_INTERVAL_MS);

    logger.info("Outbox sweeper started", { intervalMs: SWEEP_INTERVAL_MS });
  }

  /**
   * Stop the background sweep interval.
   */
  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;

    logger.info("Outbox sweeper stopped");
  }
}

export default OutboxSweeper;
