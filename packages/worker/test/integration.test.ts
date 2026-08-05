import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type PgBoss from "pg-boss";
import {
  collectFileMap,
  COMPILER_VERSION,
  type CloneJobResult,
  type RunCloneJobInput,
} from "@cloner/core";
import {
  createDb,
  createBoss,
  workClone,
  runMigrations,
  type Db,
} from "@cloner/db";
import { LocalArtifactStore } from "@cloner/storage";
import { createApp, DbBackend } from "@cloner/api";
import {
  acquireTestPostgres,
  hasTestPostgres,
  type EphemeralPg,
} from "@cloner/test-utils";
import { processCloneJob } from "../src/processJob.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(
  fn: () => Promise<T | undefined | null>,
  ms = 30_000,
  step = 300,
): Promise<T> {
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
const seenReuseSources: Array<string | undefined> = [];
const fakeRunJob = async (input: RunCloneJobInput): Promise<CloneJobResult> => {
  const base = input.runsDir!;
  const app = join(base, "generated", "app");
  const source = join(base, "source");
  mkdirSync(join(app, "src", "app"), { recursive: true });
  mkdirSync(join(app, "public", "assets", "cloned", "images"), {
    recursive: true,
  });
  mkdirSync(join(source, "capture"), { recursive: true });
  writeFileSync(
    join(source, "capture", "capture-result.json"),
    JSON.stringify({ url: input.url }),
  );
  writeFileSync(join(app, "package.json"), '{"name":"cloned-app"}\n');
  writeFileSync(
    join(app, "src", "app", "page.tsx"),
    "export default function Page(){return <div/>}\n",
  );
  writeFileSync(
    join(app, "public", "assets", "cloned", "images", "a.png"),
    Buffer.from([1, 2, 3, 4]),
  );
  seenReuseSources.push(input.reuseEntrySource);
  if (input.options?.experimentalReuseCaptureJobId) {
    assert.ok(input.reuseEntrySource);
    assert.equal(
      existsSync(
        join(input.reuseEntrySource, "capture", "capture-result.json"),
      ),
      true,
    );
  }
  const multi = input.options?.mode === "multi";
  return {
    url: input.url,
    kind: multi ? "clone_site" : "clone",
    options: input.options ?? {},
    status: "succeeded",
    compilerVersion: COMPILER_VERSION,
    timings: { captureMs: 1, generateMs: 0 },
    files: collectFileMap(base),
    capture: { nodeCount: 7, pollution: false, blocked: false },
    ...(multi ? { routes: [{ route: "/" }] } : {}),
    runDir: base,
    ...(!multi ? { entryCaptureSourceDir: source } : {}),
  };
};

const experimentalPlan = {
  version: "ion-clone-plan-v1",
  entryRoute: "/",
  staticRoutes: ["/about"],
  manifests: [{ key: "products", entityType: "product" }],
  renderers: [
    {
      key: "product-detail",
      role: "detail",
      pattern: "/products/[slug]",
      captureUrl: "/products/alpha",
      manifestKeys: ["products"],
    },
  ],
  dispositions: [
    { path: "/about", kind: "static" },
    {
      path: "/products/alpha",
      kind: "renderer",
      rendererKey: "product-detail",
    },
  ],
} as const;

describe(
  "M2: async job lifecycle (Postgres queue + DB + worker)",
  { skip: hasTestPostgres() ? false : "no test Postgres" },
  () => {
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
      await workClone(boss, (jobId) =>
        processCloneJob(
          { db, store, runJob: fakeRunJob, cacheTtlMs: 60_000 },
          jobId,
        ),
      );
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
      const submit = await app.request("/v1/clones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reqBody,
      });
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
      const result = await (
        await app.request(`/v1/clones/${jobId}/result`)
      ).json();
      assert.equal(result.files["src/app/page.tsx"].type, "text");
      const bin = result.files["public/assets/cloned/images/a.png"];
      assert.equal(bin.type, "binary");
      const fileRes = await app.request(bin.url);
      assert.equal(fileRes.status, 200);
      assert.equal(Buffer.from(await fileRes.arrayBuffer()).length, 4);

      // Second identical submit → cache hit (200, status cached), no new job.
      const submit2 = await app.request("/v1/clones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reqBody,
      });
      assert.equal(submit2.status, 200);
      const cached = await submit2.json();
      assert.equal(cached.status, "cached");
      assert.equal(cached.jobId, jobId);

      // noCache bypasses the cache → a fresh queued job.
      const submit3 = await app.request("/v1/clones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          options: { interactions: false, noCache: true },
        }),
      });
      assert.equal(submit3.status, 202);
      assert.notEqual((await submit3.json()).jobId, jobId);
    });

    it("restores a cached initial job capture after the artifact-store instance is recreated", async () => {
      seenReuseSources.length = 0;
      const url = `https://example.com/durable-${Date.now()}`;
      let app = createApp({ backend: new DbBackend({ db, boss, store }) });
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          options: { mode: "single", interactions: false },
        }),
      } as const;

      const initial = await app.request("/v1/clones", request);
      const initialJobId = (await initial.json()).jobId as string;
      await waitFor(async () => {
        const status = await (
          await app.request(`/v1/clones/${initialJobId}`)
        ).json();
        return status.status === "succeeded" ? status : undefined;
      });

      const cached = await app.request("/v1/clones", request);
      assert.equal(cached.status, 200);
      assert.equal((await cached.json()).jobId, initialJobId);

      // Simulate a worker/process switch: only the durable artifact directory is
      // retained; no capture-cache directory or object-local state is reused.
      store = new LocalArtifactStore(blobs);
      app = createApp({ backend: new DbBackend({ db, boss, store }) });
      const planned = await app.request("/v1/clones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          options: {
            mode: "multi",
            experimentalContentHandoff: "ion-cms-v1",
            experimentalClonePlan: experimentalPlan,
            experimentalReuseCaptureJobId: initialJobId,
          },
        }),
      });
      assert.equal(planned.status, 202);
      const plannedJobId = (await planned.json()).jobId as string;
      await waitFor(async () => {
        const status = await (
          await app.request(`/v1/clones/${plannedJobId}`)
        ).json();
        if (status.status === "failed") throw new Error(String(status.error));
        return status.status === "succeeded" ? status : undefined;
      });
      assert.ok(
        seenReuseSources.some((source) =>
          source?.includes("reused-entry-source"),
        ),
      );
    });
  },
);
