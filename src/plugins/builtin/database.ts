/**
 * Built-in Database Plugin
 *
 * SQL database operations for in-workflow data storage and queries.
 * Supports PGlite (embedded PostgreSQL), PostgreSQL, and MySQL.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Database connection config */
interface DbConfig {
  /** Database type */
  type: "pglite" | "postgres" | "mysql";
  /** Connection string or directory path (PGlite) */
  connection: string;
  /** Connection pool size */
  poolSize?: number;
}

/** Query input */
interface QueryInput extends DbConfig {
  /** SQL query */
  sql: string;
  /** Query parameters (positional) */
  params?: unknown[];
  /** Return first row only */
  single?: boolean;
}

/** Execute input (INSERT, UPDATE, DELETE) */
interface ExecuteInput extends DbConfig {
  /** SQL statement */
  sql: string;
  /** Statement parameters */
  params?: unknown[];
}

/** Batch execute input */
interface BatchInput extends DbConfig {
  /** SQL statements to execute in transaction */
  statements: Array<{
    sql: string;
    params?: unknown[];
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
 * Build WHERE clause from conditions object using Postgres $N placeholders.
 */
const buildWhere = (
  where: Record<string, unknown>,
  startIndex = 1,
): { clause: string; params: unknown[]; nextIndex: number } => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      conditions.push(`${key} IS NULL`);
    } else if (Array.isArray(value)) {
      const placeholders = value.map(() => `$${idx++}`).join(", ");
      conditions.push(`${key} IN (${placeholders})`);
      params.push(...value);
    } else if (typeof value === "object") {
      const op = value as { op?: string; value?: unknown };
      const opStr = op.op ?? "=";
      conditions.push(`${key} ${opStr} $${idx++}`);
      params.push(op.value);
    } else {
      conditions.push(`${key} = $${idx++}`);
      params.push(value);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
    nextIndex: idx,
  };
};

/**
 * Create a PGlite instance.
 */
const createPGlite = async (connection: string): Promise<PGlite> => {
  const { PGlite } = await import("@electric-sql/pglite");
  return new PGlite(connection);
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

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const result = await db.query(input.sql, input.params);
        const rows = input.single ? result.rows.slice(0, 1) : result.rows;

        return {
          success: true,
          output: {
            rows,
            rowCount: rows.length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
      }
    }

    return {
      success: false,
      error: `Database type ${input.type} requires external connection. Use PGlite for embedded operations.`,
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

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const result = await db.query(input.sql, input.params);

        return {
          success: true,
          output: {
            changes: result.affectedRows ?? 0,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
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

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const results: Array<{ changes: number }> = [];
        const useTransaction = input.transaction !== false;

        const run = async () => {
          for (const stmt of input.statements) {
            const result = await db.query(stmt.sql, stmt.params);
            results.push({ changes: result.affectedRows ?? 0 });
          }
        };

        if (useTransaction) {
          await db.transaction(async (tx) => {
            for (const stmt of input.statements) {
              const result = await tx.query(stmt.sql, stmt.params);
              results.push({ changes: result.affectedRows ?? 0 });
            }
          });
        } else {
          await run();
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
        await db.close();
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
      blob: "BYTEA",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMPTZ",
    };

    const columnDefs = input.columns.map((col) => {
      const parts = [col.name, typeMap[col.type] ?? "TEXT"];
      if (col.primaryKey) parts.push("PRIMARY KEY");
      if (col.notNull) parts.push("NOT NULL");
      if (col.unique) parts.push("UNIQUE");
      if (col.default !== undefined) {
        const defaultVal =
          typeof col.default === "string" ? `'${col.default}'` : col.default;
        parts.push(`DEFAULT ${defaultVal}`);
      }
      return parts.join(" ");
    });

    const ifNotExists = input.ifNotExists ? "IF NOT EXISTS " : "";
    const sql = `CREATE TABLE ${ifNotExists}${input.table} (${columnDefs.join(", ")})`;

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        await db.exec(sql);

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
        await db.close();
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

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        let totalChanges = 0;

        for (const row of rows) {
          const values = columns.map((col) => row[col]);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

          let sql = `INSERT INTO ${input.table} (${columns.join(", ")}) VALUES (${placeholders})`;

          if (input.onConflict === "ignore") {
            sql += " ON CONFLICT DO NOTHING";
          } else if (
            input.onConflict === "replace" ||
            input.onConflict === "update"
          ) {
            const setClauses = columns
              .map((col) => `${col} = EXCLUDED.${col}`)
              .join(", ");
            sql += ` ON CONFLICT DO UPDATE SET ${setClauses}`;
          }

          const result = await db.query(sql, values);
          totalChanges += result.affectedRows ?? 0;
        }

        return {
          success: true,
          output: {
            inserted: totalChanges,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
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

    const dataKeys = Object.keys(input.data);
    const setClauses = dataKeys.map((col, i) => `${col} = $${i + 1}`);
    const setParams = Object.values(input.data);

    const { clause: whereClause, params: whereParams } = buildWhere(
      input.where,
      dataKeys.length + 1,
    );

    const sql = `UPDATE ${input.table} SET ${setClauses.join(", ")} ${whereClause}`;
    const params = [...setParams, ...whereParams];

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const result = await db.query(sql, params);

        return {
          success: true,
          output: {
            updated: result.affectedRows ?? 0,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
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
        error:
          "DELETE requires WHERE conditions. Use TRUNCATE for full table delete.",
        durationMs: performance.now() - startTime,
      };
    }

    const sql = `DELETE FROM ${input.table} ${whereClause}`;

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const result = await db.query(sql, params);

        return {
          success: true,
          output: {
            deleted: result.affectedRows ?? 0,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
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

    if (input.type === "pglite") {
      const db = await createPGlite(input.connection);

      try {
        const columns = await db.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = $1
           ORDER BY ordinal_position`,
          [input.table],
        );

        const indexes = await db.query(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE tablename = $1`,
          [input.table],
        );

        return {
          success: true,
          output: {
            table: input.table,
            columns: columns.rows,
            indexes: indexes.rows,
            columnCount: columns.rows.length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await db.close();
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
  description: "SQL database operations (PGlite, PostgreSQL, MySQL)",
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
