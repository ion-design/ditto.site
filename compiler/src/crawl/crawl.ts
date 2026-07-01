/**
 * Site crawl: discover same-origin route paths from one entry URL, bounded and
 * deterministic. Sources: robots.txt (respected), sitemap.xml (incl. sitemap
 * indexes), the entry page's links, and a bounded BFS over discovered internal
 * links. Discovery is intentionally *lightweight* (load + harvest hrefs) — the
 * heavy single-load+resize capture runs later, only on the selected routes.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { toRoutePath, segmentsOf } from "./url.js";

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type CrawlResult = {
  entryUrl: string;
  entryPath: string;
  origin: string;
  paths: string[]; // sorted unique route paths (includes entry)
  depthByPath: Record<string, number>; // link-distance from entry (sitemap-only: segment count)
  sourcesByPath: Record<string, string[]>; // "entry" | "link" | "sitemap"
  robotsDisallow: string[];
};

export type CrawlOptions = {
  url: string;
  maxDepth?: number; // BFS link-distance cap (default 3)
  maxDiscoverPages?: number; // cap on lightweight navigations (default 30)
  maxSitemapUrls?: number; // cap on sitemap <loc> entries consumed (default 2000)
  respectRobots?: boolean; // default true
  log?: (e: Record<string, unknown>) => void;
};

/** Parse robots.txt into the Disallow prefixes that apply to our crawler (the
 *  catch-all `User-agent: *` group). Deterministic; unknown directives ignored. */
export function parseRobotsDisallow(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let inStar = false;
  let sawGroup = false;
  const disallow: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      // A run of consecutive user-agent lines shares the next rule block.
      if (!sawGroup) inStar = value === "*" || inStar;
      else { inStar = value === "*"; sawGroup = false; }
    } else if (field === "disallow") {
      sawGroup = true;
      if (inStar && value) disallow.push(value);
    } else if (field === "allow" || field === "sitemap" || field === "crawl-delay") {
      sawGroup = true;
    }
  }
  return [...new Set(disallow)].sort();
}

export function isAllowed(path: string, disallow: string[]): boolean {
  for (const d of disallow) {
    if (d === "/") return false;
    // robots prefixes may contain a trailing * — treat as prefix match either way.
    const prefix = d.replace(/\*+$/, "");
    if (prefix && path.startsWith(prefix)) return false;
  }
  return true;
}

async function fetchText(ctx: BrowserContext, url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const resp = await ctx.request.get(url, { timeout: timeoutMs, failOnStatusCode: false });
    if (!resp.ok()) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/** Extract route paths from sitemap.xml (following one level of sitemap indexes). */
async function fetchSitemapPaths(ctx: BrowserContext, origin: string, base: string, cap: number, log: (e: Record<string, unknown>) => void): Promise<string[]> {
  const out = new Set<string>();
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  const seenSitemaps = new Set<string>();
  const queue = [origin + "/sitemap.xml", origin + "/sitemap_index.xml"];
  let fetched = 0;
  while (queue.length && out.size < cap && fetched < 12) {
    const sm = queue.shift()!;
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    const text = await fetchText(ctx, sm);
    if (!text) continue;
    fetched++;
    const isIndex = /<sitemapindex/i.test(text);
    let m: RegExpExecArray | null;
    locRe.lastIndex = 0;
    while ((m = locRe.exec(text)) !== null) {
      const loc = m[1]!.replace(/&amp;/g, "&");
      if (isIndex) {
        if (seenSitemaps.size + queue.length < 12) queue.push(loc);
      } else {
        const p = toRoutePath(loc, base);
        if (p) out.add(p);
        if (out.size >= cap) break;
      }
    }
  }
  if (out.size) log({ event: "sitemap", urls: out.size, sitemaps: fetched });
  return [...out];
}

/** A path whose last segment looks like a content slug/id — a leaf we record but
 *  don't navigate into during discovery (it seldom links to new site structure). */
function looksLikeLeaf(path: string): boolean {
  const segs = segmentsOf(path);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1]!;
  return last.includes("-") || last.length >= 14 || /^\d/.test(last) || segs.length >= 3;
}

async function harvestLinks(page: Page, base: string): Promise<string[]> {
  const hrefs = await Promise.race([
    page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))),
    new Promise<string[]>((res) => setTimeout(() => res([]), 8000)),
  ]).catch(() => [] as (string | null)[]);
  const out = new Set<string>();
  for (const h of hrefs) {
    const p = toRoutePath(h, base);
    if (p) out.add(p);
  }
  return [...out];
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const log = opts.log ?? (() => {});
  const maxDepth = opts.maxDepth ?? 3;
  const maxDiscoverPages = opts.maxDiscoverPages ?? 30;
  const maxSitemapUrls = opts.maxSitemapUrls ?? 2000;
  const respectRobots = opts.respectRobots ?? true;

  const base = opts.url;
  const origin = new URL(base).origin;
  const entryPath = toRoutePath(base, base) ?? "/";

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
  const depthByPath: Record<string, number> = {};
  const sourcesByPath: Record<string, string[]> = {};
  let robotsDisallow: string[] = [];
  const addSource = (p: string, s: string): void => {
    (sourcesByPath[p] ??= []);
    if (!sourcesByPath[p]!.includes(s)) sourcesByPath[p]!.push(s);
  };

  try {
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } });

    // robots.txt
    if (respectRobots) {
      const robotsText = await fetchText(ctx, origin + "/robots.txt");
      if (robotsText) { robotsDisallow = parseRobotsDisallow(robotsText); log({ event: "robots", disallow: robotsDisallow.length }); }
    }
    const allow = (p: string): boolean => !respectRobots || isAllowed(p, robotsDisallow);

    // sitemap
    const sitemapPaths = await fetchSitemapPaths(ctx, origin, base, maxSitemapUrls, log);
    for (const p of sitemapPaths) {
      if (!allow(p)) continue;
      if (!(p in depthByPath)) depthByPath[p] = segmentsOf(p).length; // proxy depth for sitemap-only
      addSource(p, "sitemap");
    }

    // BFS from entry (lightweight navigations)
    depthByPath[entryPath] = 0;
    addSource(entryPath, "entry");
    const queue: Array<{ path: string; depth: number }> = [{ path: entryPath, depth: 0 }];
    const visited = new Set<string>();
    let navs = 0;
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    while (queue.length && navs < maxDiscoverPages) {
      queue.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
      const { path, depth } = queue.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      if (depth > maxDepth) continue;
      const url = origin + (path === "/" ? "/" : path);
      let ok = true;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1200);
      } catch { ok = false; }
      navs++;
      if (!ok) { log({ event: "discover_nav_fail", path }); continue; }
      const links = await harvestLinks(page, base);
      log({ event: "discovered", path, depth, links: links.length, navs });
      for (const l of links) {
        if (!allow(l)) continue;
        addSource(l, "link");
        if (!(l in depthByPath) || depthByPath[l]! > depth + 1) depthByPath[l] = depth + 1;
        // Record every discovered path (template induction needs them all), but only
        // *navigate into* likely hub/listing pages — descending into every content
        // leaf (blog post, doc article) is wasteful and rarely reveals new structure.
        if (!visited.has(l) && depth + 1 <= maxDepth && !looksLikeLeaf(l)) queue.push({ path: l, depth: depth + 1 });
      }
    }
    await ctx.close();
  } finally {
    await browser.close();
  }

  const paths = Object.keys(depthByPath).sort();
  log({ event: "crawl_done", paths: paths.length });
  return { entryUrl: base, entryPath, origin, paths, depthByPath, sourcesByPath, robotsDisallow };
}
