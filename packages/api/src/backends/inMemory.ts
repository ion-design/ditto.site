import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveCloneMode, verifyCloneJobResult, type CloneJobResult, type CloneOptions, type RunCloneJobInput } from "@cloner/core";
import { makeTarGz, makeZip, sha256hex } from "@cloner/storage";
import { InMemoryStore } from "../store.js";
import { buildRestResult, buildRestSummary, contentTypeFor } from "../rest.js";
import type { Backend, BundleFormat, CloneBundle, FileFacet, JobView, ResultOutcome, SubmitOutcome } from "../backend.js";

export type RunJob = (input: RunCloneJobInput) => Promise<CloneJobResult>;

/** Sync, in-memory backend (M1): runs the clone INLINE on submit and holds results
 *  in memory. POST returns the file map immediately (200). */
export class InMemoryBackend implements Backend {
  constructor(private deps: { store: InMemoryStore; runJob: RunJob; makeTempBase?: () => string; captureCacheDir?: string }) {}

  private makeBase(): string {
    return (this.deps.makeTempBase ?? (() => mkdtempSync(join(tmpdir(), "api-clone-"))))();
  }

  async submit(url: string, options: CloneOptions | undefined): Promise<SubmitOutcome> {
    const id = randomUUID();
    const base = this.makeBase();
    // Record the job BEFORE running it so a second connection can poll
    // /v1/clones/:id and /events while the inline clone is in flight.
    const events: Array<Record<string, unknown>> = [];
    const kind: "clone" | "clone_site" = resolveCloneMode(options) === "multi" ? "clone_site" : "clone";
    const rec = { id, status: "running" as const, url, kind, options: options ?? {}, createdAt: Date.now(), base, events };
    this.deps.store.put(rec);
    const log = (e: Record<string, unknown>) => {
      events.push({ t: Date.now(), ...e });
    };
    try {
      // captureCacheDir (persistent, shared across submits) powers the single→multi
      // reuse: a single-page submit stashes its capture; a later multi-page submit for
      // the same URL reuses it as the entry route (no re-capture) and expands the site.
      const result = await this.deps.runJob({ url, options, runsDir: base, captureCacheDir: this.deps.captureCacheDir, log });
      log({ event: "clone_done" });
      this.deps.store.put({ id, status: "succeeded", url, kind: result.kind, options: result.options, createdAt: rec.createdAt, result, base, events });
      if (result.options.asyncVerify) {
        void verifyCloneJobResult(result, {
          validationConcurrency: result.options.validationConcurrency,
          viewportConcurrency: result.options.viewportConcurrency,
        }).then((done) => {
          result.verify = done.verify;
          result.timings = { ...result.timings, verifyMs: done.verifyMs };
        }).catch((e) => {
          result.verify = { error: String(e).slice(0, 500), async: true };
        });
      }
      return { jobId: id, status: "succeeded", httpStatus: 200, result: buildRestResult(id, result, `/v1/clones/${id}/files`) };
    } catch (e) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      log({ event: "clone_error", error: String(e).slice(0, 300) });
      this.deps.store.put({ id, status: "failed", url, kind, options: options ?? {}, createdAt: rec.createdAt, error: String(e), events });
      throw e;
    }
  }

  async events(jobId: string): Promise<Array<Record<string, unknown>> | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec) return null;
    return rec.events ?? [];
  }

  async status(jobId: string): Promise<JobView | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec) return null;
    if (rec.status === "succeeded" && rec.result) return { ...buildRestSummary(jobId, rec.result), verify: rec.result.verify };
    return { jobId, url: rec.url, kind: rec.kind, status: rec.status, options: rec.options, error: rec.error };
  }

  async result(jobId: string): Promise<ResultOutcome | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec) return null;
    if (rec.status === "succeeded" && rec.result) return { ready: true, result: buildRestResult(jobId, rec.result, `/v1/clones/${jobId}/files`) };
    return { ready: false, status: rec.status, error: rec.error };
  }

  async file(jobId: string, path: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec?.result) return null;
    const entry = rec.result.files[path];
    if (!entry) return null;
    return { bytes: readFileSync(entry.absPath), contentType: contentTypeFor(path) };
  }

  async list(): Promise<JobView[]> {
    return this.deps.store.list().map((rec) =>
      rec.status === "succeeded" && rec.result
        ? buildRestSummary(rec.id, rec.result)
        : { jobId: rec.id, url: rec.url, kind: rec.kind, status: rec.status, options: rec.options, error: rec.error },
    );
  }

  async remove(jobId: string): Promise<boolean> {
    return this.deps.store.remove(jobId);
  }

  async facets(jobId: string): Promise<FileFacet[] | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec?.result) return null;
    return Object.entries(rec.result.files).map(([path, f]) =>
      f.kind === "text"
        ? { path, kind: "text", bytes: f.bytes, sha256: f.sha256, content: f.content ?? "" }
        : { path, kind: "binary", bytes: f.bytes, sha256: f.sha256, binaryUrl: async () => `/v1/clones/${jobId}/files/${path}` },
    );
  }

  async bundle(jobId: string, format: BundleFormat = "tgz"): Promise<CloneBundle | null> {
    const rec = this.deps.store.get(jobId);
    if (!rec?.result) return null;
    const entries = Object.entries(rec.result.files).map(([path, f]) => ({ path, bytes: readFileSync(f.absPath) }));
    const bytes = format === "zip" ? makeZip(entries) : makeTarGz(entries);
    return { bytes, sha256: sha256hex(bytes), format };
  }
}
