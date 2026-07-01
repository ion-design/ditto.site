import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCloneJob } from "../src/runCloneJob.js";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";

// Multi-page clone job: crawl a served fixture site (index → blog → faq) and clone
// all routes into one Next app. Skipped without Chromium.
describe("runCloneJob multi-page (served fixture site)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  before(async () => {
    server = await serveDir(join(FIXTURES_DIR, "site"));
  });
  after(async () => {
    await server.close();
  });

  it("crawls + clones multiple routes into one app (clone_site)", async () => {
    const res = await runCloneJob({ url: server.url + "/", options: { mode: "multi", interactions: false, components: false } });
    assert.equal(res.kind, "clone_site");
    assert.ok(res.routes && res.routes.length >= 2, `expected >=2 routes, got ${res.routes?.length}`);
    assert.ok(res.files["src/app/layout.tsx"], "shared layout emitted once");
    assert.ok(res.files["src/app/page.tsx"], "home route page");
    assert.ok(res.files["AGENTS.md"], "generated AGENTS.md emitted");
    assert.ok(res.files["ARCHITECTURE.md"], "generated ARCHITECTURE.md emitted");
    assert.ok(res.files["src/app/robots.ts"], "robots route emitted");
    assert.ok(res.files["src/app/sitemap.ts"], "sitemap route emitted");
    assert.ok(res.files["src/app/llms.txt/route.ts"], "llms route emitted");
    assert.ok((res.files["src/app/llms.txt/route.ts"]!.content ?? "").includes("Build faster with Acme"), "generated llms includes captured route content");
    const subRoutePages = Object.keys(res.files).filter((p) => /^src\/app\/.+\/page\.tsx$/.test(p));
    assert.ok(subRoutePages.length >= 1, "at least one sub-route page");
    assert.ok(res.capture.nodeCount > 0);
  });
});
