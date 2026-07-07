import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  errorFields,
  resolveCloneMode,
  summarizeCloneOptions,
  summarizeFileMap,
  verifyCloneJobResult,
  type CloneJobResult,
  type CloneOptions,
  type RunCloneJobInput,
  type ServiceLogger,
} from "@cloner/core";
import { makeTarGz, makeZip, sha256hex } from "@cloner/storage";
import { InMemoryStore } from "../store.js";
import { buildRestResult, buildRestSummary, contentTypeFor } from "../rest.js";
import type { Backend, BundleFormat, CloneBundle, FileFacet, JobView, ResultOutcome, SubmitOutcome } from "../backend.js";

export type RunJob = (input: RunCloneJobInput) => Promise<CloneJobResult>;

/** In-memory backend: enqueues a clone (202) and runs it in the background so long
 *  captures (multi-viewport + verify) never hold a single HTTP connection open for
 *  minutes — which browsers surface as `TypeError: Failed to fetch` when the link
 *  drops (server restart, hot-reload, idle timeout). Poll /v1/clones/:id + /events. */
export class InMemoryBackend implements Backend {
  constructor(private deps: { store: InMemoryStore; runJob: RunJob; makeTempBase?: () => string; captureCacheDir?: string; log?: ServiceLogger }) {}

  private activeClones = 0;

  private makeBase(): string {
    return (this.deps.makeTempBase ?? (() => mkdtempSync(join(tmpdir(), "api-clone-"))))();
  }

  async submit(url: string, options: CloneOptions | undefined): Promise<SubmitOutcome> {
    if (this.activeClones > 0 || this.deps.store.list().some((j) => j.status === "running")) {
      throw new Error("BUSY: another clone is already running — wait for it to finish (use npm run dev:api:stable to avoid hot-reload killing Playwright)");
    }
    const id = randomUUID();
    const base = this.makeBase();
    const events: Array<Record<string, unknown>> = [];
    const kind: "clone" | "clone_site" = resolveCloneMode(options) === "multi" ? "clone_site" : "clone";
    const rec = { id, status: "running" as const, url, kind, options: options ?? {}, createdAt: Date.now(), base, events };
    this.deps.store.put(rec);
    this.deps.log?.("clone_queued", { jobId: id, backend: "in-memory", url, kind, options: summarizeCloneOptions(options) });
    void this.runInBackground(id, url, options, rec, base, events, kind);
    return { jobId: id, status: "queued", httpStatus: 202 };
  }

  private async runInBackground(
    id: string,
    url: string,
    options: CloneOptions | undefined,
    rec: { id: string; status: "running"; url: string; kind: "clone" | "clone_site"; options: CloneOptions; createdAt: number; base: string; events: Array<Record<string, unknown>> },
    base: string,
    events: Array<Record<string, unknown>>,
    kind: "clone" | "clone_site",
  ): Promise<void> {
    this.activeClones++;
    const log = (e: Record<string, unknown>) => {
      events.push({ t: Date.now(), ...e });
      const current = this.deps.store.get(id);
      this.deps.store.put(current ? { ...current, events: [...events] } : { ...rec, events: [...events] });
    };
    try {
      log({ event: "clone_job_started", jobId: id, url, kind, options: summarizeCloneOptions(options) });
      this.deps.log?.("clone_job_started", { jobId: id, backend: "in-memory", url, kind, options: summarizeCloneOptions(options) });
      const result = await this.deps.runJob({ url, options, runsDir: base, captureCacheDir: this.deps.captureCacheDir, log });
      const files = summarizeFileMap(result.files);
      const routeCount = result.routes?.length ?? 1;
      log({
        event: "clone_created",
        jobId: id,
        kind: result.kind,
        routeCount,
        capture: result.capture,
        timings: result.timings,
        ...files,
      });
      this.deps.store.put({ id, status: "succeeded", url, kind: result.kind, options: result.options, createdAt: rec.createdAt, result, base, events });
      this.deps.log?.("clone_created", {
        jobId: id,
        backend: "in-memory",
        url,
        kind: result.kind,
        routeCount,
        capture: result.capture,
        timings: result.timings,
        ...files,
      });
      if (result.options.asyncVerify) {
        log({ event: "clone_verify_started", jobId: id, async: true });
        this.deps.log?.("clone_verify_started", { jobId: id, backend: "in-memory", async: true });
        void verifyCloneJobResult(result, {
          validationConcurrency: result.options.validationConcurrency,
          viewportConcurrency: result.options.viewportConcurrency,
        }).then((done) => {
          result.verify = done.verify;
          result.timings = { ...result.timings, verifyMs: done.verifyMs };
          log({ event: "clone_verify_finished", jobId: id, async: true, verifyMs: done.verifyMs });
          this.deps.store.put({ id, status: "succeeded", url, kind: result.kind, options: result.options, createdAt: rec.createdAt, result, base, events });
          this.deps.log?.("clone_verify_finished", { jobId: id, backend: "in-memory", async: true, verifyMs: done.verifyMs });
        }).catch((e) => {
          result.verify = { error: String(e).slice(0, 500), async: true };
          log({ event: "clone_verify_failed", jobId: id, async: true, error: String(e).slice(0, 500) });
          this.deps.store.put({ id, status: "succeeded", url, kind: result.kind, options: result.options, createdAt: rec.createdAt, result, base, events });
          this.deps.log?.("clone_verify_failed", { jobId: id, backend: "in-memory", async: true, error: errorFields(e) }, "error");
        });
      }
    } catch (e) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      log({ event: "clone_failed", jobId: id, error: String(e).slice(0, 300) });
      this.deps.store.put({ id, status: "failed", url, kind, options: options ?? {}, createdAt: rec.createdAt, error: String(e), events });
      this.deps.log?.("clone_failed", { jobId: id, backend: "in-memory", url, kind, error: errorFields(e) }, "error");
    } finally {
      this.activeClones = Math.max(0, this.activeClones - 1);
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
    this.deps.log?.("clone_bundle_created", { jobId, format, bytes: bytes.length, delivery: "api" });
    return { bytes, sha256: sha256hex(bytes), format };
  }
}
