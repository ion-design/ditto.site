import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, "..", "migrations");

/** App-wide advisory lock id for migrations. Concurrent `db:migrate` runs (e.g.
 *  api + worker pre-deploy firing off the same push) serialize on it instead of
 *  racing Drizzle's journal writes. */
const MIGRATE_LOCK_ID = 0xd1770;

/** Apply all pending Drizzle migrations to the target database. Safe to run
 *  concurrently: callers serialize on a Postgres advisory lock, and re-running
 *  applied migrations is a journal no-op. */
export async function runMigrations(connectionString: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const { db, pool } = createDb(connectionString);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_ID]);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_ID]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  await runMigrations(url);
  console.log(JSON.stringify({ event: "migrations_applied" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
