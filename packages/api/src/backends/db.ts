import { cacheKey, COMPILER_VERSION, resolveCloneMode, type CloneOptions, type RouteInfo } from "@cloner/core";
import { repo, enqueueClone, type Db, type PgBoss } from "@cloner/db";
import { makeTarGz, makeZip, sha256hex, type ArtifactStore, type StoredFile } from "@cloner/storage";
import type { Backend, BundleFormat, CloneBundle, FileFacet, JobView, JobStatus, ResultOutcome, SubmitOutcome } from "../backend.js";
import { contentTypeFor, restResultFromStored } from "../rest.js";

/** The jsonb envelope persisted in clones.fileManifest: text files inline + binary
 *  keys (from the ArtifactStore) plus the reproduced-route map. */
export type StoredEnvelope = { files: StoredFile[]; routes?: RouteInfo[]; bundleKey?: string };

/** Async, DB+queue backend (M2): submit enqueues a job and returns 202; the worker
 *  processes it and writes the result. Reads come from Postgres + the ArtifactStore. */
export class DbBackend implements Backend {
  constructor(private deps: { db: Db; boss: PgBoss; store: ArtifactStore }) {}

  async submit(url: string, options: CloneOptions | undefined): Promise<SubmitOutcome> {
    const key = cacheKey(url, options, COMPILER_VERSION);
    const kind: "clone" | "clone_site" = resolveCloneMode(options) === "multi" ? "clone_site" : "clone";

    if (!options?.noCache) {
      const hit = await repo.cacheGetFresh(this.deps.db, key, COMPILER_VERSION);
      if (hit?.jobId) {
        const r = await this.result(hit.jobId);
        if (r && r.ready) {
          return { jobId: hit.jobId, status: "cached", httpStatus: 200, result: { ...r.result, status: "cached" } };
        }
      }
    }

    const job = await repo.createJob(this.deps.db, { kind, url, options: options ?? {}, status: "queued", cacheKey: key });
    await enqueueClone(this.deps.boss, job.id);
    return { jobId: job.id, status: "queued", httpStatus: 202 };
  }

  async status(jobId: string): Promise<JobView | null> {
    const job = await repo.getJob(this.deps.db, jobId);
    if (!job) return null;
    const base: JobView = {
      jobId: job.id,
      url: job.url,
      kind: job.kind as "clone" | "clone_site",
      status: job.status as JobStatus,
      options: job.options as CloneOptions,
      compilerVersion: job.compilerVersion ?? undefined,
      timings: job.timings ?? undefined,
      error: job.error ?? undefined,
    };
    if (job.status === "succeeded") {
      const clone = await repo.getClone(this.deps.db, jobId);
      if (clone) {
        const env = clone.fileManifest as StoredEnvelope;
        let totalBytes = 0;
        for (const f of env.files) totalBytes += f.bytes;
        return { ...base, capture: clone.captureMeta as JobView["capture"], verify: clone.verify ?? undefined, routes: env.routes, fileCount: env.files.length, totalBytes };
      }
    }
    return base;
  }

  async result(jobId: string): Promise<ResultOutcome | null> {
    const job = await repo.getJob(this.deps.db, jobId);
    if (!job) return null;
    if (job.status !== "succeeded") return { ready: false, status: job.status as JobStatus, error: job.error ?? undefined };
    const clone = await repo.getClone(this.deps.db, jobId);
    if (!clone) return { ready: false, status: "running" };
    const env = clone.fileManifest as StoredEnvelope;
    const result = await restResultFromStored(jobId, {
      url: job.url,
      kind: job.kind as "clone" | "clone_site",
      options: job.options as CloneOptions,
      compilerVersion: job.compilerVersion ?? COMPILER_VERSION,
      timings: (job.timings as { captureMs: number; generateMs: number }) ?? { captureMs: 0, generateMs: 0 },
      capture: clone.captureMeta as { nodeCount: number; pollution: boolean; blocked: boolean },
      routes: env.routes,
      verify: clone.verify ?? undefined,
      files: env.files,
      binaryUrl: (p) => this.deps.store.binaryUrl(jobId, p),
    });
    return { ready: true, result };
  }

  async file(jobId: string, path: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    // Text lives inline in the manifest (not in blob storage); binaries come from
    // the store. This keeps /files/* working in S3 mode where text isn't uploaded.
    const env = await this.envelope(jobId);
    const meta = env?.files.find((f) => f.path === path);
    if (meta?.kind === "text") return { bytes: Buffer.from(meta.content, "utf8"), contentType: contentTypeFor(path) };
    const got = await this.deps.store.getFile(jobId, path);
    if (!got) return null;
    return { bytes: got.bytes, contentType: contentTypeFor(path) };
  }

  async list(): Promise<JobView[]> {
    const rows = await repo.listJobs(this.deps.db, 50);
    return rows.map((job) => ({
      jobId: job.id,
      url: job.url,
      kind: job.kind as "clone" | "clone_site",
      status: job.status as JobStatus,
      options: job.options as CloneOptions,
      compilerVersion: job.compilerVersion ?? undefined,
      timings: job.timings ?? undefined,
      error: job.error ?? undefined,
    }));
  }

  async remove(jobId: string): Promise<boolean> {
    await this.deps.store.remove(jobId).catch(() => {});
    return repo.deleteJob(this.deps.db, jobId);
  }

  private async envelope(jobId: string): Promise<StoredEnvelope | null> {
    const clone = await repo.getClone(this.deps.db, jobId);
    if (!clone) return null;
    return clone.fileManifest as StoredEnvelope;
  }

  async facets(jobId: string): Promise<FileFacet[] | null> {
    const env = await this.envelope(jobId);
    if (!env) return null;
    return env.files.map((f) =>
      f.kind === "text"
        ? { path: f.path, kind: "text", bytes: f.bytes, sha256: f.sha256, content: f.content }
        : { path: f.path, kind: "binary", bytes: f.bytes, sha256: f.sha256, binaryUrl: () => this.deps.store.binaryUrl(jobId, f.path) },
    );
  }

  async bundle(jobId: string, format: BundleFormat = "tgz"): Promise<CloneBundle | null> {
    const env = await this.envelope(jobId);
    if (!env) return null;
    const entries: Array<{ path: string; bytes: Buffer }> = [];
    for (const f of env.files) {
      if (f.kind === "text") {
        entries.push({ path: f.path, bytes: Buffer.from(f.content, "utf8") });
      } else {
        const got = await this.deps.store.getFile(jobId, f.path);
        if (got) entries.push({ path: f.path, bytes: got.bytes });
      }
    }
    const bytes = format === "zip" ? makeZip(entries) : makeTarGz(entries);
    // S3 store: upload + presign so the client downloads directly; local: served by the API.
    const url = this.deps.store.uploadBundle ? await this.deps.store.uploadBundle(jobId, format, bytes) : undefined;
    return { bytes, sha256: sha256hex(bytes), format, url };
  }

  async events(jobId: string, after = 0): Promise<Array<Record<string, unknown>> | null> {
    const job = await repo.getJob(this.deps.db, jobId);
    if (!job) return null;
    return repo.listJobEvents(this.deps.db, jobId, after);
  }
}
