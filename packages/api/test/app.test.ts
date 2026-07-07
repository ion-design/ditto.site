import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectFileMap, type CloneJobResult } from "@cloner/core";
import { createApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { InMemoryBackend, type RunJob } from "../src/backends/inMemory.js";

/** A browser-free fake clone: writes a tiny generated app under the provided temp
 *  base, then returns a real CloneJobResult via collectFileMap. Proves the REST
 *  file-map contract (text inline + binary by reference + per-file streaming)
 *  without launching Chromium. */
const fakeRunJob: RunJob = async (input) => {
  const base = input.runsDir!;
  const app = join(base, "generated", "app");
  mkdirSync(join(app, "src", "app"), { recursive: true });
  mkdirSync(join(app, "public", "assets", "cloned", "images"), { recursive: true });
  writeFileSync(join(app, "package.json"), '{"name":"cloned-app"}\n');
  writeFileSync(join(app, "src", "app", "page.tsx"), "export default function Page(){return <div/>}\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(app, "public", "assets", "cloned", "images", "a.png"), png);
  const files = collectFileMap(base);
  return {
    url: input.url,
    kind: "clone",
    options: input.options ?? {},
    status: "succeeded",
    compilerVersion: "test-0",
    timings: { captureMs: 5, generateMs: 0 },
    files,
    capture: { nodeCount: 42, pollution: false, blocked: false },
    runDir: base,
  } satisfies CloneJobResult;
};

async function waitForResult(app: ReturnType<typeof createApp>, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const view = await (await app.request(`/v1/clones/${jobId}`)).json();
    if (view.status === "succeeded") return await (await app.request(`/v1/clones/${jobId}/result`)).json();
    if (view.status === "failed") throw new Error(String(view.error));
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for clone");
}

test("POST /v1/clones enqueues then completes; binaries by reference; streaming + lifecycle", async () => {
  const store = new InMemoryStore(60_000);
  const app = createApp({ backend: new InMemoryBackend({ store, runJob: fakeRunJob }) });
  try {
    const res = await app.request("/v1/clones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", options: {} }),
    });
    assert.equal(res.status, 202);
    const queued = await res.json();
    assert.ok(queued.jobId);
    assert.equal(queued.status, "queued");

    let body: Record<string, unknown> | undefined;
    body = await waitForResult(app, queued.jobId);
    assert.ok(body);
    assert.equal(body!.status, "succeeded");
    assert.equal(body!.kind, "clone");

    // Text inline.
    const files = body!.files as Record<string, { type: string; content?: string; sha256?: string; url?: string }>;
    const page = files["src/app/page.tsx"];
    assert.ok(page);
    assert.equal(page!.type, "text");
    assert.ok(page!.content!.includes("Page"));
    assert.ok(page!.sha256);

    // Binary by reference (URL, not bytes).
    const bin = files["public/assets/cloned/images/a.png"];
    assert.ok(bin);
    assert.equal(bin!.type, "binary");
    assert.equal(bin!.content, undefined);
    assert.equal(bin!.url, `/v1/clones/${queued.jobId}/files/public/assets/cloned/images/a.png`);

    // Per-file streaming returns the actual bytes.
    const fileRes = await app.request(bin!.url!);
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(bytes.length, 7);

    // Cheap metadata overview (no file contents).
    const meta = await (await app.request(`/v1/clones/${queued.jobId}`)).json();
    assert.equal(meta.fileCount, 3);
    assert.equal(meta.capture.nodeCount, 42);
    assert.equal(meta.totalBytes > 0, true);

    // Full result fetch.
    const result = await app.request(`/v1/clones/${queued.jobId}/result`);
    assert.equal(result.status, 200);

    // Lifecycle events include the service-level creation milestone.
    const events = await (await app.request(`/v1/clones/${queued.jobId}/events`)).json();
    assert.ok(events.events.some((e: { event?: string }) => e.event === "clone_created"));

    // List.
    const list = await (await app.request("/v1/clones")).json();
    assert.equal(list.clones.length, 1);

    // Delete purges; subsequent fetch 404s.
    const del = await app.request(`/v1/clones/${queued.jobId}`, { method: "DELETE" });
    assert.equal((await del.json()).deleted, true);
    assert.equal((await app.request(`/v1/clones/${queued.jobId}`)).status, 404);
  } finally {
    store.clear();
  }
});

test("POST /v1/clones validates the body", async () => {
  const store = new InMemoryStore(60_000);
  const app = createApp({ backend: new InMemoryBackend({ store, runJob: fakeRunJob }) });
  try {
    assert.equal((await app.request("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal(
      (await app.request("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "ftp://x" }) })).status,
      400,
    );
    assert.equal(
      (await app.request("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://x.com", options: { bogus: 1 } }) })).status,
      400,
    );
  } finally {
    store.clear();
  }
});

test("POST /v1/clones normalizes product options and legacy aliases", async () => {
  const store = new InMemoryStore(60_000);
  const app = createApp({ backend: new InMemoryBackend({ store, runJob: fakeRunJob }) });
  try {
    const product = await app.request("/v1/clones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", options: { mode: "multi", styling: "css", framework: "vite" } }),
    });
    assert.equal(product.status, 202);
    const productQueued = await product.json();
    const productBody = await waitForResult(app, productQueued.jobId);
    assert.deepEqual(productBody.options, { mode: "multi", styling: "css", framework: "vite" });

    const legacy = await app.request("/v1/clones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", options: { multiPage: true, humanizeMode: "css" } }),
    });
    assert.equal(legacy.status, 202);
    const legacyQueued = await legacy.json();
    const legacyBody = await waitForResult(app, legacyQueued.jobId);
    assert.deepEqual(legacyBody.options, { mode: "multi", styling: "css", framework: "next" });
  } finally {
    store.clear();
  }
});

test("GET /healthz", async () => {
  const app = createApp({ backend: new InMemoryBackend({ store: new InMemoryStore(1000), runJob: fakeRunJob }) });
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
