import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCrawlPool, type CrawlQueueItem, type VisitOutcome } from "../src/crawl/crawlPool.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fake visitor over a link graph: path -> outgoing links. Records call order. */
function fakeVisitor(graph: Record<string, string[]>, opts?: { delayMs?: () => number; failOn?: Set<string> }) {
  const calls: string[] = [];
  const visit = async (item: CrawlQueueItem): Promise<VisitOutcome> => {
    calls.push(item.path);
    if (opts?.delayMs) await sleep(opts.delayMs());
    if (opts?.failOn?.has(item.path)) throw new Error("boom " + item.path);
    return { ok: true, links: graph[item.path] ?? [] };
  };
  return { visit, calls };
}

const SEED: CrawlQueueItem[] = [{ path: "/", depth: 0 }];

describe("runCrawlPool", () => {
  it("enforces maxVisits exactly, never overshooting under concurrency", async () => {
    // Root links to 100 pages; cap 30 ⇒ exactly 30 visits (root + 29 children),
    // including with a concurrency (7) that does not divide the budget evenly.
    const graph: Record<string, string[]> = { "/": Array.from({ length: 100 }, (_, i) => `/p${String(i).padStart(3, "0")}`) };
    for (const c of [3, 7]) {
      const { visit, calls } = fakeVisitor(graph);
      const res = await runCrawlPool({ seeds: SEED, visit, concurrency: c, maxDepth: 3, maxVisits: 30 });
      assert.equal(res.visits, 30, `concurrency=${c}`);
      assert.equal(res.visited.length, 30);
      assert.equal(calls.length, 30);
    }
  });

  it("never visits a URL twice on a cross-linked graph", async () => {
    // Complete cross-linking: every page links to every other (and itself).
    const pages = ["/", "/a", "/b", "/c", "/d", "/e"];
    const graph = Object.fromEntries(pages.map((p) => [p, pages]));
    const { visit, calls } = fakeVisitor(graph);
    const res = await runCrawlPool({ seeds: SEED, visit, concurrency: 3, maxDepth: 3, maxVisits: 100 });
    assert.deepEqual([...new Set(calls)].sort(), pages.slice().sort());
    assert.equal(calls.length, pages.length); // no duplicates
    assert.equal(res.visits, pages.length);
  });

  it("respects maxDepth on a deep chain", async () => {
    const graph: Record<string, string[]> = { "/": ["/c1"] };
    for (let i = 1; i < 10; i++) graph[`/c${i}`] = [`/c${i + 1}`];
    const { visit, calls } = fakeVisitor(graph);
    const res = await runCrawlPool({ seeds: SEED, visit, concurrency: 3, maxDepth: 3, maxVisits: 100 });
    assert.deepEqual(calls, ["/", "/c1", "/c2", "/c3"]); // depth 0..3 only
    assert.ok(res.visited.every((v) => v.depth <= 3));
  });

  it("is deterministic across runs with randomized per-visit delays (cap binding)", async () => {
    // Branchy graph, budget truncates the crawl — the scheduling-sensitive case.
    const graph: Record<string, string[]> = { "/": ["/a", "/b", "/c", "/d"] };
    for (const top of ["a", "b", "c", "d"]) {
      graph[`/${top}`] = Array.from({ length: 8 }, (_, i) => `/${top}/s${i}`);
      for (let i = 0; i < 8; i++) graph[`/${top}/s${i}`] = [`/${top}`, "/", `/${top}/s${(i + 1) % 8}`];
    }
    const run = async () => {
      const links: Array<[string, number]> = [];
      const { visit, calls } = fakeVisitor(graph, { delayMs: () => Math.floor(Math.random() * 20) });
      const res = await runCrawlPool({
        seeds: SEED, visit, concurrency: 4, maxDepth: 3, maxVisits: 15,
        onLink: (p, d) => links.push([p, d]),
      });
      return { calls, visited: res.visited, links };
    };
    const r1 = await run();
    const r2 = await run();
    assert.deepEqual(r1.calls, r2.calls); // same pages, same order
    assert.deepEqual(r1.visited, r2.visited);
    assert.deepEqual(r1.links, r2.links); // bookkeeping stream identical too
    assert.equal(r1.calls.length, 15);
  });

  it("skips failing URLs, records them, and completes the crawl", async () => {
    const graph: Record<string, string[]> = { "/": ["/ok1", "/bad", "/ok2"], "/ok1": ["/ok3"] };
    const { visit, calls } = fakeVisitor(graph, { failOn: new Set(["/bad"]) });
    const res = await runCrawlPool({ seeds: SEED, visit, concurrency: 2, maxDepth: 3, maxVisits: 100 });
    assert.deepEqual(res.failed, ["/bad"]);
    assert.deepEqual([...new Set(calls)].sort(), ["/", "/bad", "/ok1", "/ok2", "/ok3"]);
    assert.equal(res.visits, 5); // failure consumed budget, crawl still finished
  });

  it("honors canEnqueue (leaf/robots gate) while onLink still sees every link", async () => {
    const graph: Record<string, string[]> = { "/": ["/hub", "/leaf-post"], "/hub": ["/leaf-post"] };
    const seen: string[] = [];
    const { visit, calls } = fakeVisitor(graph);
    await runCrawlPool({
      seeds: SEED, visit, concurrency: 3, maxDepth: 3, maxVisits: 100,
      canEnqueue: (p) => !p.includes("leaf"),
      onLink: (p) => seen.push(p),
    });
    assert.deepEqual(calls.sort(), ["/", "/hub"]); // leaf never navigated
    assert.ok(seen.includes("/leaf-post")); // but recorded for template induction
  });
});
