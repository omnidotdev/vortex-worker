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
      // Send TCP keepalive probes so a network blip that silently severs an idle
      // connection is detected by the OS and the dead socket evicted, instead of
      // being handed to the next request and surfacing as "Connection terminated
      // unexpectedly". Without this a brief pod-to-pod blip lingers for minutes as
      // stale connections are reused before they age out
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });

    // An idle pooled client can still error after checkout (backend restart, network
    // partition). node-postgres emits these on the pool itself; with no listener the
    // error is thrown and crashes the process. Log and swallow so a transient DB
    // connectivity blip degrades gracefully instead of taking the whole API down
    pgPool.on("error", (err) => {
      console.warn("pg pool idle client error:", err.message);
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
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { schema };
