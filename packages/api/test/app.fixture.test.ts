import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runCloneJob } from "@cloner/core";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";
import { createApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { InMemoryBackend } from "../src/backends/inMemory.js";

// End-to-end: real clone of a served fixture through the HTTP layer. Skipped when
// no Chromium is installed.
describe("POST /v1/clones (real clone, served fixture)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  const store = new InMemoryStore(60_000);
  before(async () => {
    server = await serveDir(FIXTURES_DIR);
  });
  after(async () => {
    store.clear();
    await server.close();
  });

  it("clones a fixture and returns the real generated app file map", async () => {
    const app = createApp({ backend: new InMemoryBackend({ store, runJob: runCloneJob }) });
    const res = await app.request("/v1/clones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: server.url + "/components.html", options: { interactions: false, components: true, motion: false } }),
    });
    assert.equal(res.status, 202);
    const queued = await res.json();
    let body: Record<string, unknown> | undefined;
    for (let i = 0; i < 600; i++) {
      const view = await (await app.request(`/v1/clones/${queued.jobId}`)).json();
      if (view.status === "succeeded") {
        body = await (await app.request(`/v1/clones/${queued.jobId}/result`)).json();
        break;
      }
      if (view.status === "failed") assert.fail(view.error);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(body);
    const files = body!.files as Record<string, { type: string }>;
    assert.equal(body!.status, "succeeded");
    assert.ok(files["src/app/page.tsx"], "has page.tsx");
    assert.equal(files["src/app/page.tsx"].type, "text");
    assert.ok(files["package.json"], "has package.json");
    assert.ok((body!.capture as { nodeCount: number }).nodeCount > 0);
    assert.equal((body!.capture as { blocked: boolean }).blocked, false);
  });
});
