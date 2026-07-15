/**
 * Integration: real crawlSite (Playwright) over the committed 10-page fixture
 * site (fixtures/crawl-site), served by an in-test http server. Asserts a
 * serial crawl (crawlConcurrency 1) and a parallel crawl (3) discover the
 * identical route set, identical depths, and produce the identical route plan.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlSite, type CrawlResult } from "../src/crawl/crawl.js";
import { selectRoutes } from "../src/crawl/routeTemplates.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "crawl-site");

/** Serve fixtures/crawl-site with extensionless routes: "/" → index.html, "/a" → a.html. */
function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const name = path === "/" ? "index" : path.slice(1);
    const file = join(FIXTURE_DIR, `${name}.html`);
    if (/^[a-z]+$/.test(name) && existsSync(file)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found"); // incl. robots.txt / sitemap.xml — crawl tolerates both
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const EXPECTED_PATHS = ["/", "/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"];
const EXPECTED_DEPTHS: Record<string, number> = { "/": 0, "/a": 1, "/b": 1, "/c": 1, "/d": 2, "/e": 2, "/f": 2, "/g": 2, "/h": 3, "/i": 3 };

describe("crawlSite over the fixture site (integration, real browser)", () => {
  it("concurrency 1 and 3 yield identical route sets, ordering, and plan", async () => {
    const { server, url } = await startServer();
    try {
      const run = (crawlConcurrency: number): Promise<CrawlResult> =>
        crawlSite({ url, crawlConcurrency, settleMs: 25 });
      const serial = await run(1);
      const parallel = await run(3);

      // Full expected discovery (external/mailto/asset links filtered out).
      assert.deepEqual(serial.paths, EXPECTED_PATHS);
      assert.deepEqual(serial.depthByPath, EXPECTED_DEPTHS);

      // Parallel crawl is byte-identical to serial: set, ordering, depths, sources.
      assert.deepEqual(parallel.paths, serial.paths);
      assert.deepEqual(parallel.depthByPath, serial.depthByPath);
      assert.deepEqual(parallel.sourcesByPath, serial.sourcesByPath);

      // And the downstream route plan (what capture consumes) matches exactly.
      const planOf = (c: CrawlResult) => selectRoutes({ entryPath: c.entryPath, paths: c.paths });
      assert.deepEqual(planOf(parallel).selected, planOf(serial).selected);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
