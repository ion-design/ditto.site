import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export type DbHandle = { db: Db; pool: pg.Pool };

/** Create a Drizzle client + underlying pg Pool from a connection URL. Caller owns
 *  the pool lifecycle (`handle.pool.end()` on shutdown). */
export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
