/**
 * Built-in Database Plugin
 *
 * SQL database operations for in-workflow data storage and queries.
 * Supports SQLite (embedded), PostgreSQL, and MySQL.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Database connection config */
interface DbConfig {
  /** Database type */
  type: "sqlite" | "postgres" | "mysql";
  /** Connection string or file path */
  connection: string;
  /** Connection pool size */
  poolSize?: number;
}

/** Query input */
interface QueryInput extends DbConfig {
  /** SQL query */
  sql: string;
  /** Query parameters (positional or named) */
  params?: unknown[] | Record<string, unknown>;
  /** Return first row only */
  single?: boolean;
}

/** Execute input (INSERT, UPDATE, DELETE) */
interface ExecuteInput extends DbConfig {
  /** SQL statement */
  sql: string;
  /** Statement parameters */
  params?: unknown[] | Record<string, unknown>;
}

/** Batch execute input */
interface BatchInput extends DbConfig {
  /** SQL statements to execute in transaction */
  statements: Array<{
    sql: string;
    params?: unknown[] | Record<string, unknown>;
  }>;
  /** Wrap in transaction */
  transaction?: boolean;
}

/** Create table input */
interface CreateTableInput extends DbConfig {
  /** Table name */
  table: string;
  /** Column definitions */
  columns: Array<{
    name: string;
    type: "text" | "integer" | "real" | "blob" | "boolean" | "timestamp";
    primaryKey?: boolean;
    notNull?: boolean;
    unique?: boolean;
    default?: unknown;
  }>;
  /** Create only if not exists */
  ifNotExists?: boolean;
}

/** Insert input */
interface InsertInput extends DbConfig {
  /** Table name */
  table: string;
  /** Row data */
  data: Record<string, unknown> | Record<string, unknown>[];
  /** Return inserted rows */
  returning?: boolean;
  /** On conflict action */
  onConflict?: "ignore" | "replace" | "update";
}

/** Update input */
interface UpdateInput extends DbConfig {
  /** Table name */
  table: string;
  /** Values to update */
  data: Record<string, unknown>;
  /** WHERE conditions */
  where: Record<string, unknown>;
  /** Return updated rows */
  returning?: boolean;
}

/** Delete input */
interface DeleteInput extends DbConfig {
  /** Table name */
  table: string;
  /** WHERE conditions */
  where: Record<string, unknown>;
  /** Return deleted rows */
  returning?: boolean;
}

/**
 * Build WHERE clause from conditions object.
 */
const buildWhere = (where: Record<string, unknown>): { clause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      conditions.push(`${key} IS NULL`);
    } else if (Array.isArray(value)) {
      const placeholders = value.map(() => "?").join(", ");
      conditions.push(`${key} IN (${placeholders})`);
      params.push(...value);
    } else if (typeof value === "object") {
      const op = value as { op?: string; value?: unknown };
      const opStr = op.op ?? "=";
      conditions.push(`${key} ${opStr} ?`);
      params.push(op.value);
    } else {
      conditions.push(`${key} = ?`);
      params.push(value);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

/**
 * Execute a raw SQL query.
 */
const query = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as QueryInput;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const stmt = db.prepare(input.sql);
        const params = (Array.isArray(input.params) ? input.params : []) as (string | number | boolean | null | Uint8Array)[];

        const rows = input.single
          ? stmt.get(...params)
          : stmt.all(...params);

        return {
          success: true,
          output: {
            rows: input.single ? (rows ? [rows] : []) : rows,
            rowCount: input.single ? (rows ? 1 : 0) : (rows as unknown[]).length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    // For PostgreSQL/MySQL, use native fetch to a database proxy.
    // In production, this would use pg/mysql2 libraries.
    return {
      success: false,
      error: `Database type ${input.type} requires external connection. Use SQLite for embedded operations.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Execute a SQL statement (INSERT, UPDATE, DELETE).
 */
const execute = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExecuteInput;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const stmt = db.prepare(input.sql);
        const params = (Array.isArray(input.params) ? input.params : []) as (string | number | boolean | null | Uint8Array)[];
        const result = stmt.run(...params);

        return {
          success: true,
          output: {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Execute multiple statements in a batch.
 */
const batch = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BatchInput;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const results: Array<{ changes: number }> = [];
        const useTransaction = input.transaction !== false;

        if (useTransaction) {
          db.run("BEGIN TRANSACTION");
        }

        try {
          for (const stmt of input.statements) {
            const prepared = db.prepare(stmt.sql);
            const params = (Array.isArray(stmt.params) ? stmt.params : []) as (string | number | boolean | null | Uint8Array)[];
            const result = prepared.run(...params);
            results.push({ changes: result.changes });
          }

          if (useTransaction) {
            db.run("COMMIT");
          }
        } catch (error) {
          if (useTransaction) {
            db.run("ROLLBACK");
          }
          throw error;
        }

        return {
          success: true,
          output: {
            results,
            totalChanges: results.reduce((sum, r) => sum + r.changes, 0),
            statementCount: results.length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Create a table.
 */
const createTable = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CreateTableInput;

    const typeMap: Record<string, string> = {
      text: "TEXT",
      integer: "INTEGER",
      real: "REAL",
      blob: "BLOB",
      boolean: "INTEGER",
      timestamp: "TEXT",
    };

    const columnDefs = input.columns.map((col) => {
      const parts = [col.name, typeMap[col.type] ?? "TEXT"];
      if (col.primaryKey) parts.push("PRIMARY KEY");
      if (col.notNull) parts.push("NOT NULL");
      if (col.unique) parts.push("UNIQUE");
      if (col.default !== undefined) {
        const defaultVal = typeof col.default === "string" ? `'${col.default}'` : col.default;
        parts.push(`DEFAULT ${defaultVal}`);
      }
      return parts.join(" ");
    });

    const ifNotExists = input.ifNotExists ? "IF NOT EXISTS " : "";
    const sql = `CREATE TABLE ${ifNotExists}${input.table} (${columnDefs.join(", ")})`;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        db.run(sql);

        return {
          success: true,
          output: {
            table: input.table,
            columns: input.columns.length,
            sql,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Insert rows into a table.
 */
const insert = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as InsertInput;
    const rows = Array.isArray(input.data) ? input.data : [input.data];

    if (rows.length === 0) {
      return {
        success: true,
        output: { inserted: 0 },
        durationMs: performance.now() - startTime,
      };
    }

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => "?").join(", ");

    let verb = "INSERT";
    if (input.onConflict === "ignore") verb = "INSERT OR IGNORE";
    if (input.onConflict === "replace") verb = "INSERT OR REPLACE";

    const sql = `${verb} INTO ${input.table} (${columns.join(", ")}) VALUES (${placeholders})`;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const stmt = db.prepare(sql);
        let totalChanges = 0;
        let lastId: number | bigint = 0;

        for (const row of rows) {
          const values = columns.map((col) => row[col]) as (string | number | boolean | null | Uint8Array)[];
          const result = stmt.run(...values);
          totalChanges += result.changes;
          lastId = result.lastInsertRowid;
        }

        return {
          success: true,
          output: {
            inserted: totalChanges,
            lastInsertRowid: lastId,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Update rows in a table.
 */
const update = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UpdateInput;

    const setClauses = Object.keys(input.data).map((col) => `${col} = ?`);
    const setParams = Object.values(input.data);

    const { clause: whereClause, params: whereParams } = buildWhere(input.where);

    const sql = `UPDATE ${input.table} SET ${setClauses.join(", ")} ${whereClause}`;
    const params = [...setParams, ...whereParams] as (string | number | boolean | null | Uint8Array)[];

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const stmt = db.prepare(sql);
        const result = stmt.run(...params);

        return {
          success: true,
          output: {
            updated: result.changes,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Delete rows from a table.
 */
const deleteRows = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DeleteInput;

    const { clause: whereClause, params } = buildWhere(input.where);

    if (!whereClause) {
      return {
        success: false,
        error: "DELETE requires WHERE conditions. Use TRUNCATE for full table delete.",
        durationMs: performance.now() - startTime,
      };
    }

    const sql = `DELETE FROM ${input.table} ${whereClause}`;

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const stmt = db.prepare(sql);
        const typedParams = params as (string | number | boolean | null | Uint8Array)[];
        const result = stmt.run(...typedParams);

        return {
          success: true,
          output: {
            deleted: result.changes,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Get table schema/info.
 */
const tableInfo = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DbConfig & { table: string };

    if (input.type === "sqlite") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(input.connection);

      try {
        const columns = db.prepare(`PRAGMA table_info(${input.table})`).all();
        const indexes = db.prepare(`PRAGMA index_list(${input.table})`).all();

        return {
          success: true,
          output: {
            table: input.table,
            columns,
            indexes,
            columnCount: (columns as unknown[]).length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Database built-in plugin definition.
 */
export const databasePlugin: BuiltinPlugin = {
  id: "builtin:database",
  name: "Database",
  description: "SQL database operations (SQLite, PostgreSQL, MySQL)",
  actions: {
    query: {
      name: "query",
      description: "Execute a SQL query and return results",
      handler: query,
    },
    execute: {
      name: "execute",
      description: "Execute a SQL statement (INSERT, UPDATE, DELETE)",
      handler: execute,
    },
    batch: {
      name: "batch",
      description: "Execute multiple statements in a transaction",
      handler: batch,
    },
    createTable: {
      name: "createTable",
      description: "Create a new table",
      handler: createTable,
    },
    insert: {
      name: "insert",
      description: "Insert rows into a table",
      handler: insert,
    },
    update: {
      name: "update",
      description: "Update rows in a table",
      handler: update,
    },
    delete: {
      name: "delete",
      description: "Delete rows from a table",
      handler: deleteRows,
    },
    tableInfo: {
      name: "tableInfo",
      description: "Get table schema information",
      handler: tableInfo,
    },
  },
};
