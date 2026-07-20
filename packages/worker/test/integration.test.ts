import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type PgBoss from "pg-boss";
import { collectFileMap, COMPILER_VERSION, CaptureRejectedError, type CloneJobResult } from "@cloner/core";
import { createDb, createBoss, workClone, runMigrations, repo, type Db } from "@cloner/db";
import { LocalArtifactStore } from "@cloner/storage";
import { createApp, DbBackend } from "@cloner/api";
import { acquireTestPostgres, hasTestPostgres, type EphemeralPg } from "@cloner/test-utils";
import { processCloneJob } from "../src/processJob.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 30_000, step = 300): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await sleep(step);
  }
}

/** A browser-free fake clone: writes a tiny generated app under the worker's temp
 *  base, then returns a real CloneJobResult via collectFileMap. Keeps the queue/DB
 *  lifecycle test fast + hermetic (no Chromium). */
const fakeRunJob = async (input: { url: string; runsDir?: string; options?: unknown }): Promise<CloneJobResult> => {
  const base = input.runsDir!;
  const app = join(base, "generated", "app");
  mkdirSync(join(app, "src", "app"), { recursive: true });
  mkdirSync(join(app, "public", "assets", "cloned", "images"), { recursive: true });
  writeFileSync(join(app, "package.json"), '{"name":"cloned-app"}\n');
  writeFileSync(join(app, "src", "app", "page.tsx"), "export default function Page(){return <div/>}\n");
  writeFileSync(join(app, "public", "assets", "cloned", "images", "a.png"), Buffer.from([1, 2, 3, 4]));
  return {
    url: input.url,
    kind: "clone",
    options: (input.options as CloneJobResult["options"]) ?? {},
    status: "succeeded",
    compilerVersion: COMPILER_VERSION,
    timings: { captureMs: 1, generateMs: 0 },
    files: collectFileMap(base),
    capture: { nodeCount: 7, pollution: false, blocked: false },
    runDir: base,
  };
};

describe("M2: async job lifecycle (Postgres queue + DB + worker)", { skip: hasTestPostgres() ? false : "no test Postgres" }, () => {
  let pg: EphemeralPg;
  let db: Db;
  let pool: { end: () => Promise<void> };
  let boss: PgBoss;
  let store: LocalArtifactStore;
  let blobs: string;

  before(async () => {
    pg = (await acquireTestPostgres())!;
    await runMigrations(pg.url);
    const h = createDb(pg.url);
    db = h.db;
    pool = h.pool;
    boss = await createBoss(pg.url);
    blobs = mkdtempSync(join(tmpdir(), "it-blobs-"));
    store = new LocalArtifactStore(blobs);
    // Start the worker consuming the queue.
    await workClone(boss, (jobId) => processCloneJob({ db, store, runJob: fakeRunJob, cacheTtlMs: 60_000 }, jobId));
  });

  after(async () => {
    await boss?.stop({ graceful: false }).catch(() => {});
    await pool?.end().catch(() => {});
    await pg?.stop().catch(() => {});
    if (blobs) rmSync(blobs, { recursive: true, force: true });
  });

  it("enqueues, processes, persists, and serves the result; second submit is cached", async () => {
    const app = createApp({ backend: new DbBackend({ db, boss, store }) });
    const url = "https://example.com/?t=" + Date.now(); // unique → no stale cache on a reused DB
    const reqBody = JSON.stringify({ url, options: { interactions: false } });

    // Submit → 202 queued.
    const submit = await app.request("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: reqBody });
    assert.equal(submit.status, 202);
    const { jobId, status } = await submit.json();
    assert.ok(jobId);
    assert.equal(status, "queued");

    // Poll until the worker finishes.
    const done = await waitFor(async () => {
      const v = await (await app.request(`/v1/clones/${jobId}`)).json();
      return v.status === "succeeded" ? v : undefined;
    });
    assert.equal(done.status, "succeeded");
    assert.equal(done.capture.nodeCount, 7);
    assert.equal(done.fileCount, 3);

    // Full result + per-file streaming.
    const result = await (await app.request(`/v1/clones/${jobId}/result`)).json();
    assert.equal(result.files["src/app/page.tsx"].type, "text");
    const bin = result.files["public/assets/cloned/images/a.png"];
    assert.equal(bin.type, "binary");
    const fileRes = await app.request(bin.url);
    assert.equal(fileRes.status, 200);
    assert.equal(Buffer.from(await fileRes.arrayBuffer()).length, 4);

    // Second identical submit → cache hit (200, status cached), no new job.
    const submit2 = await app.request("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: reqBody });
    assert.equal(submit2.status, 200);
    const cached = await submit2.json();
    assert.equal(cached.status, "cached");
    assert.equal(cached.jobId, jobId);

    // noCache bypasses the cache → a fresh queued job.
    const submit3 = await app.request("/v1/clones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, options: { interactions: false, noCache: true } }),
    });
    assert.equal(submit3.status, 202);
    assert.notEqual((await submit3.json()).jobId, jobId);
  });

  it("persists no artifact, clone, bundle, or result-cache row for a challenge rejection", async () => {
    const cacheKey = `challenge-${Date.now()}`;
    const job = await repo.createJob(db, {
      kind: "clone",
      url: "https://ridge.com/",
      options: { verify: false },
      status: "queued",
      cacheKey,
    });
    const rejectChallenge = async (): Promise<CloneJobResult> => {
      throw new CaptureRejectedError({
        isWall: true,
        provider: "cloudflare",
        matchedSignals: ["cloudflare.challenge-platform-url", "text.incorrect-device-time"],
        title: "Just a moment...",
        finalUrl: "https://ridge.com/",
        nodeCount: 347,
        responseStatus: 403,
      });
    };

    await assert.rejects(
      processCloneJob({ db, store, runJob: rejectChallenge, cacheTtlMs: 60_000 }, job.id),
      /ANTI_BOT_CHALLENGE/,
    );
    const failed = await repo.getJob(db, job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /ANTI_BOT_CHALLENGE/);
    assert.equal(await repo.getClone(db, job.id), undefined, "no successful clone/file map row");
    assert.equal(await repo.cacheGetFresh(db, cacheKey, COMPILER_VERSION), undefined, "no result-cache row");
    assert.equal(existsSync(join(blobs, job.id)), false, "no artifact or bundle directory");
  });
});
