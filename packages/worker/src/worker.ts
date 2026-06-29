import { runCloneJob } from "@cloner/core";
import { createDb, createBoss, workClone } from "@cloner/db";
import { artifactStoreFromEnv } from "@cloner/storage";
import { processCloneJob } from "./processJob.js";
import { makeHarnessProvider } from "./harness.js";
import { loadWorkerEnv } from "./env.js";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
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
  };

  await workClone(boss, (jobId) => processCloneJob(deps, jobId));
  console.log(JSON.stringify({ event: "worker_started", artifactsDir: env.artifactsDir, harnessDir: env.harnessDir, cacheStaleAfterMs: env.cacheStaleAfterMs }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
