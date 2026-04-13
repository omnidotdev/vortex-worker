import { Client } from "pg";

import logger from "lib/logger";

import type { EventAdapter, NormalizedEvent } from "./types";

type CdcOperation = "insert" | "update" | "delete";

type CdcAdapterConfig = {
  connectionString: string;
  tables: string[];
  operations?: CdcOperation[];
  intervalMs?: number;
  trackingColumn?: string;
};

/**
 * Escape a SQL identifier with double-quoting to prevent injection.
 * @param identifier - Raw table or column name.
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export class CdcAdapter implements EventAdapter {
  name = "cdc";
  source = "cdc";

  private client: Client;
  private handler: ((event: NormalizedEvent) => Promise<void>) | null = null;
  private running = false;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private pollCount = 0;

  // High-water mark per table for tracking column
  private highWaterMarks = new Map<string, string>();

  // Known primary keys per table for delete detection
  private knownKeys = new Map<string, Set<string>>();

  // Row snapshots per table for distinguishing insert vs update
  private knownRows = new Map<string, Map<string, string>>();

  #config: {
    connectionString: string;
    tables: string[];
    operations: CdcOperation[];
    intervalMs: number;
    trackingColumn: string;
  };

  constructor(config: CdcAdapterConfig) {
    this.#config = {
      connectionString: config.connectionString,
      tables: config.tables,
      operations: config.operations ?? ["insert", "update", "delete"],
      intervalMs: config.intervalMs ?? 5000,
      trackingColumn: config.trackingColumn ?? "updated_at",
    };

    this.client = new Client({
      connectionString: this.#config.connectionString,
    });
  }

  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.client.connect();
    this.running = true;

    logger.info("CDC adapter connected", {
      tables: this.#config.tables,
      trackingColumn: this.#config.trackingColumn,
      intervalMs: this.#config.intervalMs,
    });

    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    await this.client.end();
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.handler) return;

    this.pollCount++;

    try {
      for (const table of this.#config.tables) {
        await this.pollTable(table);
      }
    } catch (err) {
      logger.error("CDC poll error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimeout = setTimeout(() => this.poll(), this.#config.intervalMs);
    }
  }

  private async pollTable(table: string): Promise<void> {
    const trackingCol = escapeIdentifier(this.#config.trackingColumn);
    const escapedTable = escapeIdentifier(table);

    // Detect inserts and updates via high-water mark
    if (
      this.#config.operations.includes("insert") ||
      this.#config.operations.includes("update")
    ) {
      await this.pollChanges(table, escapedTable, trackingCol);
    }

    // Detect deletes by diffing primary keys every 10th poll
    if (
      this.#config.operations.includes("delete") &&
      this.pollCount % 10 === 0
    ) {
      await this.pollDeletes(table, escapedTable);
    }
  }

  private async pollChanges(
    table: string,
    escapedTable: string,
    trackingCol: string,
  ): Promise<void> {
    const highWater = this.highWaterMarks.get(table);

    let rows: Record<string, unknown>[];

    if (highWater) {
      const result = await this.client.query(
        `SELECT * FROM ${escapedTable} WHERE ${trackingCol} > $1 ORDER BY ${trackingCol} ASC LIMIT 1000`,
        [highWater],
      );
      rows = result.rows;
    } else {
      // Initial poll: fetch all rows to establish baseline
      const result = await this.client.query(
        `SELECT * FROM ${escapedTable} ORDER BY ${trackingCol} ASC LIMIT 1000`,
      );
      rows = result.rows;
    }

    if (!this.knownRows.has(table)) {
      this.knownRows.set(table, new Map());
    }
    const rowMap = this.knownRows.get(table)!;

    if (!this.knownKeys.has(table)) {
      this.knownKeys.set(table, new Set());
    }
    const keySet = this.knownKeys.get(table)!;

    for (const row of rows) {
      const primaryKey = String(row.id);
      const trackingValue = String(row[this.#config.trackingColumn]);

      // Update high-water mark
      this.highWaterMarks.set(table, trackingValue);

      // Compute a snapshot hash for change detection
      const snapshot = JSON.stringify(row);

      const isKnown = keySet.has(primaryKey);
      const previousSnapshot = rowMap.get(primaryKey);

      // Track the row
      keySet.add(primaryKey);
      rowMap.set(primaryKey, snapshot);

      // Determine operation
      let operation: CdcOperation;
      if (!isKnown) {
        operation = "insert";
      } else if (previousSnapshot !== snapshot) {
        operation = "update";
      } else {
        // No change, skip
        continue;
      }

      if (!this.#config.operations.includes(operation)) continue;

      await this.emitEvent(table, operation, row, primaryKey, trackingValue);
    }
  }

  private async pollDeletes(
    table: string,
    escapedTable: string,
  ): Promise<void> {
    const keySet = this.knownKeys.get(table);
    if (!keySet || keySet.size === 0) return;

    const result = await this.client.query(
      `SELECT ${escapeIdentifier("id")} FROM ${escapedTable}`,
    );

    const currentKeys = new Set(result.rows.map((r) => String(r.id)));

    for (const knownKey of keySet) {
      if (!currentKeys.has(knownKey)) {
        keySet.delete(knownKey);

        // Clean up row snapshot
        this.knownRows.get(table)?.delete(knownKey);

        await this.emitEvent(table, "delete", { id: knownKey }, knownKey, "");
      }
    }
  }

  private async emitEvent(
    table: string,
    operation: CdcOperation,
    row: unknown,
    primaryKey: string,
    trackingValue: string,
  ): Promise<void> {
    if (!this.handler) return;

    const event: NormalizedEvent = {
      source: `cdc:${table}`,
      type: `cdc.row.${operation}`,
      subject: `${table}:${primaryKey}`,
      data: {
        table,
        operation,
        row,
        primaryKey,
        trackingValue,
      },
      metadata: {
        idempotencyKey: `cdc-${table}-${primaryKey}-${trackingValue}`,
        timestamp: new Date(),
        raw: { table, operation, primaryKey },
      },
    };

    await this.handler(event);
  }
}
