import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloneJob } from "../src/runCloneJob.js";
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
});
