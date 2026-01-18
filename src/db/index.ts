/**
 * Database connection for vortex-worker.
 *
 * Uses lazy initialization to allow importing without DATABASE_URL
 * being set (e.g., during testing).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

let pgPool: Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Get the Postgres connection pool (lazy initialization).
 */
export function getPgPool(): Pool {
  if (!pgPool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pgPool;
}

/**
 * Get the Drizzle database client (lazy initialization).
 */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!dbInstance) {
    dbInstance = drizzle({
      client: getPgPool(),
      schema,
      casing: "snake_case",
    });
  }
  return dbInstance;
}

/**
 * Legacy exports for backwards compatibility.
 * @deprecated Use getDb() and getPgPool() instead.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getDb() as Record<string | symbol, unknown>)[prop];
  },
});

export { schema };
