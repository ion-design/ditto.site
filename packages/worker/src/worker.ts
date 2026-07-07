import { join } from "node:path";
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
    captureCacheDir: env.captureCacheDir,
    tier: env.tier,
  };

  // One harness per concurrency slot: verify builds must not share a harness dir
  // (concurrent framework builds collide). With concurrency 1 this is the plain
  // harnessDir, preserving existing layouts. At most `concurrency` jobs run at
  // once (one per poller), so a free slot always exists at checkout.
  const harnesses = Array.from({ length: env.concurrency }, (_, i) =>
    makeHarnessProvider(env.concurrency > 1 ? join(env.harnessDir, `slot-${i}`) : env.harnessDir),
  );
  const freeSlots = harnesses.map((_, i) => i);

  await workClone(
    boss,
    async (jobId) => {
      const slot = freeSlots.pop() ?? 0;
      try {
        await processCloneJob({ ...deps, harnessProvider: harnesses[slot]! }, jobId);
      } finally {
        freeSlots.push(slot);
      }
    },
    env.concurrency,
  );
  console.log(JSON.stringify({ event: "worker_started", concurrency: env.concurrency, artifactsDir: env.artifactsDir, harnessDir: env.harnessDir, cacheStaleAfterMs: env.cacheStaleAfterMs }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
