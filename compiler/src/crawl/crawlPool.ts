/**
 * Bounded-parallel BFS pool for crawl discovery. Pure scheduling — the per-URL
 * visit (Playwright navigation + link harvest) is dependency-injected, so the
 * pool's invariants are unit-testable with a fake visitor.
 *
 * Determinism mechanism: the pool runs in *waves*. Each wave takes the
 * (depth, path)-smallest pending entries (up to `concurrency` and the remaining
 * visit budget), runs them in parallel, then BARRIERS: results are merged in the
 * wave's sorted launch order, never completion order. Per-visit latency therefore
 * cannot change which links enter the frontier first, so two runs at the same
 * concurrency visit the exact same pages in the exact same order — even when the
 * visit budget (`maxVisits`) truncates the crawl.
 *
 * Invariants enforced here:
 *  - `maxVisits` can never overshoot: budget is claimed for a whole wave BEFORE
 *    any of its visits launch (wave size = min(concurrency, budget left, pending)).
 *  - No URL is visited twice: a path is marked visited when its wave launches,
 *    and the pending frontier is a Map (one entry per path, best-known depth).
 *  - `maxDepth` respected: links deeper than maxDepth are reported via `onLink`
 *    (record-keeping) but never enqueued; over-depth seeds are dropped.
 *  - Termination: the loop exits only when the frontier is empty or the budget is
 *    spent, and a wave's Promise.all always settles — `visit` rejections are
 *    caught and converted to a failed outcome, so a crashing page skips one URL
 *    without wedging or aborting the crawl.
 */

export type CrawlQueueItem = { path: string; depth: number };

export type VisitOutcome = {
  ok: boolean;
  links: string[]; // normalized route paths harvested from the page ([] on failure)
};

/** Per-URL visit. `slot` ∈ [0, concurrency) identifies the worker lane, letting the
 *  Playwright wiring keep one reusable page per lane (and recreate it on crashes). */
export type VisitFn = (item: CrawlQueueItem, slot: number) => Promise<VisitOutcome>;

export type CrawlPoolOptions = {
  seeds: CrawlQueueItem[];
  visit: VisitFn;
  concurrency?: number; // parallel visits per wave (default 3); 1 = serial BFS
  maxDepth: number; // links at depth > maxDepth are recorded but not visited
  maxVisits: number; // hard cap on visits (attempted navigations, incl. failures)
  /** Gate for whether a harvested link may be enqueued for its own visit
   *  (robots + leaf heuristics live in the caller). Default: enqueue everything. */
  canEnqueue?: (path: string) => boolean;
  /** Called once per harvested link occurrence with the candidate depth
   *  (parent depth + 1) — the caller's depth/source bookkeeping hook. */
  onLink?: (path: string, depth: number) => void;
  /** Called once per completed visit, in deterministic (wave-sorted) order. */
  onVisit?: (item: CrawlQueueItem, outcome: VisitOutcome) => void;
};

export type CrawlPoolResult = {
  visited: CrawlQueueItem[]; // deterministic visit order
  visits: number; // budget consumed (== visited.length; failures count)
  failed: string[]; // visited paths whose visit failed (skipped, crawl continued)
};

export async function runCrawlPool(opts: CrawlPoolOptions): Promise<CrawlPoolResult> {
  // Guard non-finite input (e.g. a bad --crawl-concurrency CLI parse): NaN would
  // make every wave empty and spin this loop forever.
  const concurrency = Number.isFinite(opts.concurrency ?? 3) ? Math.max(1, Math.floor(opts.concurrency ?? 3)) : 3;
  const canEnqueue = opts.canEnqueue ?? ((): boolean => true);
  const pending = new Map<string, number>(); // path -> best-known depth, not yet visited
  const visitedSet = new Set<string>();
  const visited: CrawlQueueItem[] = [];
  const failed: string[] = [];
  let visits = 0;

  for (const s of opts.seeds) {
    if (s.depth > opts.maxDepth) continue;
    const prev = pending.get(s.path);
    if (prev === undefined || prev > s.depth) pending.set(s.path, s.depth);
  }

  while (pending.size > 0 && visits < opts.maxVisits) {
    // Wave = the (depth, path)-smallest pending entries. Sorting here (not at
    // enqueue time) lets a later, shallower rediscovery relax an entry's depth.
    const wave = [...pending.entries()]
      .map(([path, depth]) => ({ path, depth }))
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
      .slice(0, Math.min(concurrency, opts.maxVisits - visits));
    // Claim budget + identity BEFORE launching: the cap cannot overshoot and no
    // concurrent (or later) wave can pick the same path up again.
    visits += wave.length;
    for (const item of wave) {
      pending.delete(item.path);
      visitedSet.add(item.path);
    }
    const outcomes = await Promise.all(
      wave.map(async (item, slot): Promise<VisitOutcome> => {
        try {
          return await opts.visit(item, slot);
        } catch {
          return { ok: false, links: [] }; // failed URL is skipped; crawl continues
        }
      }),
    );
    // Barrier passed — merge in wave (sorted-launch) order, not completion order.
    for (let i = 0; i < wave.length; i++) {
      const item = wave[i]!;
      const out = outcomes[i]!;
      visited.push(item);
      if (!out.ok) failed.push(item.path);
      opts.onVisit?.(item, out);
      const childDepth = item.depth + 1;
      for (const link of out.links) {
        opts.onLink?.(link, childDepth);
        if (childDepth > opts.maxDepth) continue;
        if (visitedSet.has(link)) continue;
        if (!canEnqueue(link)) continue;
        const prev = pending.get(link);
        if (prev === undefined || prev > childDepth) pending.set(link, childDepth);
      }
    }
  }
  return { visited, visits, failed };
}
