import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalOptions,
  errorFields,
  summarizeCloneOptions,
  summarizeFileMap,
  verifyCloneJobResult,
  type CloneJobResult,
  type CloneOptions,
  type RunCloneJobInput,
  type ServiceLogger,
} from "@cloner/core";
import { repo, type Db } from "@cloner/db";
import type { ArtifactStore } from "@cloner/storage";

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
  log?: ServiceLogger;
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
  if (!job) {
    deps.log?.("clone_job_missing", { jobId }, "warn");
    return; // job deleted before it ran
  }
  await repo.markRunning(db, jobId);

  const base = mkdtempSync(join(tmpdir(), "worker-clone-"));
  let eventTail = Promise.resolve();
  const appendEvent = (payload: Record<string, unknown>): Promise<void> => {
    eventTail = eventTail
      .catch(() => undefined)
      .then(() => repo.appendJobEvent(db, jobId, payload).then(() => undefined))
      .catch((e) => {
        deps.log?.("clone_event_append_failed", { jobId, event: payload.event, error: errorFields(e) }, "warn");
      });
    return eventTail;
  };
  const log = (event: string, fields: Record<string, unknown> = {}, level: "debug" | "info" | "warn" | "error" = "info") => {
    deps.log?.(event, { jobId, url: job.url, kind: job.kind, ...fields }, level);
  };

  try {
    const options = (job.options ?? {}) as CloneOptions;
    await appendEvent({ event: "clone_job_started", jobId, url: job.url, kind: job.kind, options: summarizeCloneOptions(options) });
    log("clone_job_started", { options: summarizeCloneOptions(options), attempt: job.attempts + 1 });
    // Provision the isolated harness only when this job actually verifies (build).
    const harnessDir = (options.verify || options.asyncVerify) && deps.harnessProvider ? await deps.harnessProvider() : undefined;
    if (harnessDir) log("clone_harness_ready", { harnessDir });
    const result = await deps.runJob({
      url: job.url,
      options,
      runsDir: base,
      harnessDir,
      tier: deps.tier,
      captureCacheDir: deps.captureCacheDir || undefined,
      captureCacheTtlMs: deps.cacheTtlMs,
      log: (e) => { void appendEvent(e); },
    });
    await appendEvent({
      event: "clone_run_completed",
      jobId,
      kind: result.kind,
      routeCount: result.routes?.length ?? 1,
      capture: result.capture,
      captureReused: result.captureReused,
      timings: result.timings,
      ...summarizeFileMap(result.files),
    });
    log("clone_run_completed", {
      routeCount: result.routes?.length ?? 1,
      capture: result.capture,
      captureReused: result.captureReused,
      timings: result.timings,
      ...summarizeFileMap(result.files),
    });

    const manifest = await store.putClone(jobId, result.files);
    await appendEvent({ event: "clone_artifacts_stored", jobId, files: manifest.files.length, bundle: !!manifest.bundleKey });
    log("clone_artifacts_stored", { files: manifest.files.length, bundle: !!manifest.bundleKey });
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
    await appendEvent({
      event: "clone_created",
      jobId,
      compilerVersion: result.compilerVersion,
      routeCount: result.routes?.length ?? 1,
      capture: result.capture,
      timings: result.timings,
      ...summarizeFileMap(result.files),
    });
    log("clone_created", {
      compilerVersion: result.compilerVersion,
      routeCount: result.routes?.length ?? 1,
      capture: result.capture,
      timings: result.timings,
      ...summarizeFileMap(result.files),
    });

    if (deps.cacheTtlMs > 0 && !options.noCache) {
      await repo.cachePut(db, {
        cacheKey: job.cacheKey,
        jobId,
        url: job.url,
        optionsHash: canonicalOptions(options),
        compilerVersion: result.compilerVersion,
        expiresAt: new Date(Date.now() + deps.cacheTtlMs),
      });
      log("clone_cache_written", { cacheTtlMs: deps.cacheTtlMs });
    }

    if (options.asyncVerify) {
      try {
        await appendEvent({ event: "clone_verify_started", jobId, async: true });
        log("clone_verify_started", { async: true });
        const done = await verifyCloneJobResult(result, {
          harnessDir,
          tier: deps.tier,
          validationConcurrency: options.validationConcurrency,
          viewportConcurrency: options.viewportConcurrency,
        });
        const timings = { ...result.timings, verifyMs: done.verifyMs };
        await repo.updateCloneVerify(db, jobId, done.verify);
        await repo.updateJobTimings(db, jobId, timings);
        await appendEvent({ event: "clone_verify_finished", jobId, async: true, verifyMs: done.verifyMs });
        log("clone_verify_finished", { async: true, verifyMs: done.verifyMs });
      } catch (e) {
        await repo.updateCloneVerify(db, jobId, { error: String(e).slice(0, 500), async: true });
        await appendEvent({ event: "clone_verify_failed", jobId, async: true, error: String(e).slice(0, 500) });
        log("clone_verify_failed", { async: true, error: errorFields(e) }, "error");
      }
    }
  } catch (e) {
    await repo.markFailed(db, jobId, String(e));
    await appendEvent({ event: "clone_failed", jobId, error: String(e).slice(0, 500) });
    log("clone_failed", { error: errorFields(e) }, "error");
    throw e;
  } finally {
    await eventTail.catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
}
