import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalOptions, verifyCloneJobResult, type CloneJobResult, type CloneOptions, type RunCloneJobInput } from "@cloner/core";
import { repo, type Db } from "@cloner/db";
import type { ArtifactStore } from "@cloner/storage";
import { classifyCloneJobRetry } from "./retryPolicy.js";

export type RunJob = (input: RunCloneJobInput) => Promise<CloneJobResult>;

export type ProcessDeps = {
  db: Db;
  store: ArtifactStore;
  runJob: RunJob;
  /** cache TTL in ms (0 = caching disabled — no cache row written). */
  cacheTtlMs: number;
  /** lazily provisions this worker's isolated build harness, used only for verify jobs (M5). */
  harnessProvider?: () => Promise<string>;
  /** persistent entry-capture cache dir for the single→multi reuse path ("" / undefined off). */
  captureCacheDir?: string;
  tier?: string;
};

/**
 * Process one queued clone job: mark running → run the clone into a temp dir →
 * persist artifacts (ArtifactStore) + the clone row → mark succeeded → write a
 * freshness-bounded cache row. On failure, mark the job failed and rethrow so the
 * queue can retry (capped). The temp dir is always cleaned up.
 */
export async function processCloneJob(deps: ProcessDeps, jobId: string): Promise<void> {
  const { db, store } = deps;
  const job = await repo.getJob(db, jobId);
  if (!job) return; // job deleted before it ran
  await repo.markRunning(db, jobId);

  const base = mkdtempSync(join(tmpdir(), "worker-clone-"));
  try {
    const options = (job.options ?? {}) as CloneOptions;
    // Provision the isolated harness only when this job actually verifies (build).
    const harnessDir = (options.verify || options.asyncVerify) && deps.harnessProvider ? await deps.harnessProvider() : undefined;
    const result = await deps.runJob({
      url: job.url,
      options,
      runsDir: base,
      harnessDir,
      tier: deps.tier,
      captureCacheDir: deps.captureCacheDir || undefined,
      captureCacheTtlMs: deps.cacheTtlMs,
      log: (e) => { void repo.appendJobEvent(db, jobId, e); },
    });

    const manifest = await store.putClone(jobId, result.files);
    const envelope = { files: manifest.files, routes: result.routes, bundleKey: manifest.bundleKey };
    await repo.upsertClone(db, {
      jobId,
      url: result.url,
      routeCount: result.routes?.length ?? 1,
      fileManifest: envelope,
      captureMeta: result.capture,
      verify: (result.verify ?? null) as unknown as Record<string, unknown> | null,
    });
    await repo.markSucceeded(db, jobId, { compilerVersion: result.compilerVersion, timings: result.timings });

    if (deps.cacheTtlMs > 0 && !options.noCache) {
      await repo.cachePut(db, {
        cacheKey: job.cacheKey,
        jobId,
        url: job.url,
        optionsHash: canonicalOptions(options),
        compilerVersion: result.compilerVersion,
        expiresAt: new Date(Date.now() + deps.cacheTtlMs),
      });
    }

    if (options.asyncVerify) {
      try {
        const done = await verifyCloneJobResult(result, {
          harnessDir,
          tier: deps.tier,
          validationConcurrency: options.validationConcurrency,
          viewportConcurrency: options.viewportConcurrency,
        });
        const timings = { ...result.timings, verifyMs: done.verifyMs };
        await repo.updateCloneVerify(db, jobId, done.verify);
        await repo.updateJobTimings(db, jobId, timings);
      } catch (e) {
        await repo.updateCloneVerify(db, jobId, { error: String(e).slice(0, 500), async: true });
      }
    }
  } catch (e) {
    await repo.markFailed(db, jobId, String(e));
    const retry = classifyCloneJobRetry(e);
    if (!retry.retry) {
      await repo.appendJobEvent(db, jobId, { event: "retry_suppressed", reason: retry.reason }).catch(() => {});
      return;
    }
    throw e;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
