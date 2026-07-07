import { createJsonLogger, errorFields, runCloneJob } from "@cloner/core";
import { createDb, createBoss, workClone } from "@cloner/db";
import { artifactStoreFromEnv } from "@cloner/storage";
import { processCloneJob } from "./processJob.js";
import { makeHarnessProvider } from "./harness.js";
import { loadWorkerEnv } from "./env.js";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = createJsonLogger("worker");
  const { db } = createDb(env.databaseUrl);
  const boss = await createBoss(env.databaseUrl);
  const store = artifactStoreFromEnv();

  const deps = {
    db,
    store,
    runJob: runCloneJob,
    cacheTtlMs: env.cacheStaleAfterMs,
    harnessProvider: makeHarnessProvider(env.harnessDir),
    captureCacheDir: env.captureCacheDir,
    tier: env.tier,
    log,
  };

  await workClone(boss, (jobId) => processCloneJob(deps, jobId));
  log("worker_started", {
    artifactsDir: env.artifactsDir,
    harnessDir: env.harnessDir,
    cacheStaleAfterMs: env.cacheStaleAfterMs,
    captureCacheDir: env.captureCacheDir || null,
    tier: env.tier,
  });
}

main().catch((e) => {
  createJsonLogger("worker")("worker_start_failed", { error: errorFields(e) }, "error");
  process.exit(1);
});
