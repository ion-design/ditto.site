import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloneJob } from "../src/runCloneJob.js";
import { siteIdFromUrl } from "clone-static";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";

// The "single page first, then expand" speed path: a single-page clone stashes its
// entry capture in captureCacheDir; a later multi-page clone of the SAME url reuses it
// as the entry route (no re-capture) and regenerates the whole site on top of it.
describe("runCloneJob incremental (single → multi reuse)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  let cacheDir: string;
  before(async () => {
    server = await serveDir(join(FIXTURES_DIR, "site"));
    cacheDir = mkdtempSync(join(tmpdir(), "capture-cache-"));
  });
  after(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("reuses the single-page entry capture when expanding to the full site", async () => {
    const url = server.url + "/";

    // 1. Single page first — fast, returns one app; seeds the capture cache.
    const single = await runCloneJob({ url, options: {}, captureCacheDir: cacheDir });
    assert.equal(single.status, "succeeded");
    assert.equal(single.kind, "clone");
    assert.equal(single.captureReused, false, "first (single) job captures fresh");
    assert.ok(single.files["src/app/page.tsx"], "single-page app emitted");

    // 2. Expand to the full multi-route site — reuses page 1's capture (no re-capture),
    //    captures the rest, regenerates ALL routes together.
    const multi = await runCloneJob({ url, options: { mode: "multi" }, captureCacheDir: cacheDir });
    assert.equal(multi.status, "succeeded");
    assert.equal(multi.kind, "clone_site");
    assert.equal(multi.captureReused, true, "multi-page job reused the cached entry capture");
    assert.ok((multi.routes?.length ?? 0) >= 2, `expected >=2 routes, got ${multi.routes?.length}`);
    assert.ok(multi.files["src/app/layout.tsx"], "shared layout emitted");
    const subRoutePages = Object.keys(multi.files).filter((p) => /^src\/app\/.+\/page\.tsx$/.test(p));
    assert.ok(subRoutePages.length >= 1, "at least one sub-route page beyond the entry");

    // Tailwind is the default styling output end-to-end (service path included).
    assert.ok(multi.files["postcss.config.mjs"], "Tailwind toolchain present");
    assert.ok((multi.files["src/app/globals.css"]!.content ?? "").includes("tailwindcss"), "Tailwind globals");
  });

  it("evicts a contaminated entry-cache hit and recaptures instead of reusing it", async () => {
    const url = server.url + "/";
    const isolatedCache = mkdtempSync(join(tmpdir(), "contaminated-capture-cache-"));
    try {
      await runCloneJob({ url, options: {}, captureCacheDir: isolatedCache });
      const source = join(isolatedCache, siteIdFromUrl(url), "source");
      const domPath = join(source, "capture", "dom-1280.json");
      const dom = JSON.parse(readFileSync(domPath, "utf8"));
      dom.doc.title = "Just a moment...";
      dom.doc.url = url;
      dom.root.attrs = { ...(dom.root.attrs ?? {}), class: "cf-chl-widget" };
      writeFileSync(domPath, JSON.stringify(dom));

      const events: Array<Record<string, unknown>> = [];
      const multi = await runCloneJob({
        url,
        options: { mode: "multi" },
        captureCacheDir: isolatedCache,
        log: (event) => events.push(event),
      });
      assert.equal(multi.status, "succeeded");
      assert.equal(multi.captureReused, false, "contaminated frozen entry was not reused");
      assert.ok(events.some((event) => event.event === "entry_capture_cache_rejected" && event.reason === "anti_bot_challenge"));

      const refreshed = JSON.parse(readFileSync(join(source, "capture", "dom-1280.json"), "utf8"));
      assert.notEqual(refreshed.doc.title, "Just a moment...", "clean recapture replaced the evicted cache entry");
    } finally {
      rmSync(isolatedCache, { recursive: true, force: true });
    }
  });
});
