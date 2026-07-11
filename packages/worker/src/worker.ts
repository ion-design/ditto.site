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

  // Self-healing: a container whose process table is poisoned (leaked/zombie
  // processes) fails EVERY browser launch with EAGAIN/EMFILE until replaced —
  // it can burn through the whole queue in minutes. After a few consecutive
  // environment-level launch failures, exit nonzero so the platform restarts
  // us in a fresh container; in-flight jobs are requeued by pg-boss expiry.
  const LAUNCH_FAILURE = /browserType\.launch.*(EAGAIN|EMFILE|ENOMEM|ENFILE)/s;
  const MAX_CONSECUTIVE_LAUNCH_FAILURES = 3;
  let launchFailures = 0;

  // Self-healing: the render pipeline leaks heap across jobs (~3.9GB over 20h
  // at concurrency 1), and V8 eventually aborts with "Reached heap limit"
  // MID-job — losing that job to expiry and, if the platform's restart retries
  // are exhausted, killing the worker for good. Recycle proactively instead:
  // once heap crosses the threshold after a job, stop fetching new jobs, let
  // in-flight handlers finish and ack (a bare process.exit here would requeue
  // jobs that already succeeded — pg-boss marks completion only after the
  // handler resolves), then exit nonzero for a fresh container.
  const HEAP_RECYCLE_BYTES = 2.5 * 1024 * 1024 * 1024;
  let recycling = false;
  const recycleIfBloated = () => {
    const { heapUsed, rss } = process.memoryUsage();
    if (recycling || heapUsed < HEAP_RECYCLE_BYTES) return;
    recycling = true;
    console.error(JSON.stringify({ event: "worker_unhealthy", reason: "heap above recycle threshold — draining, then exiting for a fresh container", heapUsedMb: Math.round(heapUsed / 1e6), rssMb: Math.round(rss / 1e6) }));
    boss.once("stopped", () => process.exit(1));
    setTimeout(() => process.exit(1), 60_000); // fallback if graceful stop hangs
    void boss.stop({ graceful: true, wait: false, timeout: 55_000 }).catch(() => process.exit(1));
  };

  await workClone(
    boss,
    async (jobId) => {
      const slot = freeSlots.pop() ?? 0;
      try {
        await processCloneJob({ ...deps, harnessProvider: harnesses[slot]! }, jobId);
        launchFailures = 0;
      } catch (e) {
        if (LAUNCH_FAILURE.test(String(e))) {
          launchFailures += 1;
          if (launchFailures >= MAX_CONSECUTIVE_LAUNCH_FAILURES) {
            console.error(JSON.stringify({ event: "worker_unhealthy", reason: "consecutive browser launch failures — exiting for a fresh container", launchFailures }));
            process.exit(1);
          }
        } else {
          launchFailures = 0;
        }
        throw e;
      } finally {
        freeSlots.push(slot);
        recycleIfBloated();
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
