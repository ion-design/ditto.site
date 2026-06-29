import { join } from "node:path";
import { parseDuration } from "./duration.js";

export type WorkerEnv = {
  databaseUrl: string;
  artifactsDir: string;
  /** cache time-to-stale (CACHE_STALE_AFTER, default 24h; "0" disables caching). */
  cacheStaleAfterMs: number;
  /** this worker's isolated build harness dir for verify jobs (M5). */
  harnessDir: string;
  /** persistent entry-capture cache dir (the single→multi speed path). "" disables it. */
  captureCacheDir: string;
  tier: string;
};

export function loadWorkerEnv(): WorkerEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker");
  return {
    databaseUrl,
    artifactsDir: process.env.ARTIFACTS_DIR ?? join(process.cwd(), "local-data", "artifacts"),
    cacheStaleAfterMs: parseDuration(process.env.CACHE_STALE_AFTER, 24 * 60 * 60 * 1000),
    harnessDir: process.env.HARNESS_DIR ?? join(process.cwd(), "local-data", "harness"),
    captureCacheDir: process.env.CAPTURE_CACHE_DIR ?? join(process.cwd(), "local-data", "capture-cache"),
    tier: process.env.VERIFY_TIER ?? "stage2",
  };
}
