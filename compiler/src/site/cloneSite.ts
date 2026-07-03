#!/usr/bin/env -S npx tsx
/**
 * clone-site — multi-page / whole-site cloner (Stage 3). Orchestrates:
 *   crawl (discover routes) → select (template-collection policy) → capture each
 *   selected route → structurally confirm collections (capture one sibling, compare
 *   DOM signature) → generate one app with shared layout/chrome + per-route pages,
 *   internal links rewritten to the clone routes → site manifest.
 *
 * Single-route capture keeps the Stage-2 single-load+resize per route; sessions are
 * NOT shared across routes (only the on-disk asset cache is, via content-addressing).
 */
import { basename, join, resolve } from "node:path";
import { captureSite, REQUIRED_VIEWPORTS, type CaptureResult } from "../capture/capture.js";
import { buildIR, type IR } from "../normalize/ir.js";
import { buildAssetGraph, type AssetGraph } from "../infer/assets.js";
import { buildFontGraph, type FontGraph } from "../infer/fonts.js";
import { extractTokens, type Tokens } from "../infer/tokens.js";
import { crawlSite } from "../crawl/crawl.js";
import { selectRoutes, applyConfirmation, type RoutePlan } from "../crawl/routeTemplates.js";
import { structurallySimilar } from "./signature.js";
import { generateSiteApp, routeToSegment, routeKey, type RouteArtifact } from "./generateSite.js";
import { detectSharedChrome, chromeSignatureId } from "./sharedLayout.js";
import { validateSite, type SiteReport } from "./validateSite.js";
import { siteIdFromUrl, namedOutDirs, exportApp, writeLatestPointer } from "../cli.js";
import { writeJSON, readJSON, ensureDir, fileExists, writeText } from "../util/fsx.js";
import { seoInventoryToMarkdown } from "../generate/seo.js";
import type { AppFramework } from "../generate/app.js";
import { existsSync, readdirSync, rmSync, cpSync } from "node:fs";

export type CloneSiteOptions = {
  url: string;
  runsDir?: string;
  maxRoutes?: number;
  maxDepth?: number;
  maxCollectionInstances?: number; // skip reproducing listings of collections larger than this (very large directories)
  validate?: boolean; // build + grade the generated app (default false; opt in for QA)
  interactions?: boolean; // Stage 4 — capture & reproduce hover/focus (opt-in)
  components?: boolean; // Stage 4.5 — extract repeated subtrees per route + chrome (opt-in)
  humanizeMode?: "tailwind" | "css"; // styling output — Tailwind utilities (default) or per-node CSS
  framework?: AppFramework; // output framework — Next.js App Router (default) or Vite React
  reflow?: boolean; // Reflow trade: flow all heights (ON by default, matching single-page; --no-reflow to disable)
  screenshots?: boolean; // capture per-viewport full-page screenshots (validation-only; default tied to `validate`)
  captureConcurrency?: number; // routes captured in parallel (default 3; isolated browser each). 1 = sequential
  validationConcurrency?: number; // validation routes rendered/graded in parallel (default 2)
  viewportConcurrency?: number; // clone viewports rendered in parallel during validation (default 2)
  outDir?: string; // clean <outDir>/<siteName>/{app,.clone} layout; reuses a prior single-page capture as the entry route
  reuseEntrySource?: string; // explicit: a prior single-page source/ dir to reuse as the entry route (skip its re-capture)
  tier?: string;
  log?: (e: Record<string, unknown>) => void;
};

export type CloneSiteResult = {
  runDir: string;
  appDir: string;
  siteId: string;
  plan: RoutePlan;
  routes: RouteArtifact[];
  siteReport?: SiteReport;
  /** Stable, timestamp-free path to the app (via the `runs/<site>/latest` symlink), when created. */
  stableAppDir?: string;
};

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

type Built = { capture: CaptureResult; ir: IR; assetGraph: AssetGraph; fontGraph: FontGraph; tokens: Tokens; sourceDir: string };

/** Run `fn` over `items` with at most `limit` running at once, preserving result order. Used to
 *  capture routes with bounded parallelism — each captureSite launches its OWN isolated browser and
 *  writes to its OWN per-route source dir, so concurrent captures share no state and don't race.
 *  Bounded (not unbounded) to stay polite to the live origin and cap memory (full-page work is heavy
 *  on tall pages). limit=1 ⇒ fully sequential (maximally deterministic). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return out;
}

export async function runCloneSite(opts: CloneSiteOptions): Promise<CloneSiteResult> {
  const log = opts.log ?? (() => {});
  const captureConcurrency = Math.max(1, opts.captureConcurrency ?? 3);
  const validate = opts.validate === true;
  const screenshots = opts.screenshots ?? validate;
  const runsDir = opts.runsDir ?? resolve(process.cwd(), "..", "runs");
  // --out: clean <outDir>/<siteName>/.clone working dir (shared with a prior single-page
  // clone) + app/ deliverable. Else the timestamped runs/site-<id>/<ts> layout.
  const out = opts.outDir ? namedOutDirs(opts.outDir, opts.url) : null;
  const siteId = "site-" + siteIdFromUrl(opts.url);
  const runDir = out ? out.runDir : join(runsDir, siteId, timestamp());
  const appDir = join(runDir, "generated", "app");
  ensureDir(runDir);
  // Expand-in-place: reuse a prior single-page capture as the entry route (no re-capture);
  // only the rest of the site is crawled + captured, then ALL routes regenerate together
  // (shared chrome/tokens). Explicit via opts.reuseEntrySource (service), or auto-detected
  // from a prior `clone --out` that left the entry capture in `.clone/source` (CLI).
  const reuseEntrySource = (opts.reuseEntrySource && fileExists(join(opts.reuseEntrySource, "capture", "capture-result.json")) ? opts.reuseEntrySource : null)
    ?? (out && fileExists(join(runDir, "source", "capture", "capture-result.json")) ? join(runDir, "source") : null);

  // 1. Crawl + select.
  log({ event: "crawl_start", url: opts.url });
  const crawl = await crawlSite({ url: opts.url, maxDepth: opts.maxDepth, log });
  let plan = selectRoutes({ entryPath: crawl.entryPath, paths: crawl.paths, maxRoutes: opts.maxRoutes, maxCollectionInstances: opts.maxCollectionInstances });
  writeJSON(join(runDir, "crawl.json"), {
    entryUrl: crawl.entryUrl, origin: crawl.origin, entryPath: crawl.entryPath,
    discovered: crawl.paths.length, depthByPath: crawl.depthByPath, robotsDisallow: crawl.robotsDisallow,
  });
  log({ event: "plan", discovered: crawl.paths.length, selected: plan.selected.length, collections: plan.collections.length });

  const origin = crawl.origin;
  const built = new Map<string, Built>(); // routePath -> artifacts
  const pendingCaptures = new Map<string, Promise<Built | null>>();

  // Capture one route fully (all viewports) into runDir/routes/<key>/source.
  const captureRoute = async (routePath: string, viewports: number[]): Promise<Built | null> => {
    if (built.has(routePath)) return built.get(routePath)!;
    const pendingKey = `${routePath}|${viewports.join(",")}`;
    const pending = pendingCaptures.get(pendingKey);
    if (pending) return pending;
    const work = (async (): Promise<Built | null> => {
      const sourceDir = join(runDir, "routes", routeKey(routePath), "source");
      const url = origin + (routePath === "/" ? "/" : routePath);
      try {
        // Only capture interactions on full (all-viewport) route captures, never the
        // light single-viewport sibling probes used for collection confirmation.
        const full = viewports.length === REQUIRED_VIEWPORTS.length;
        const capture = await captureSite({ url, outDir: sourceDir, viewports, interactions: opts.interactions && full, screenshots, log: () => {} });
        const ir = buildIR(sourceDir, viewports);
        const assetGraph = buildAssetGraph(capture);
        const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, url);
        const tokens = extractTokens(ir);
        const b: Built = { capture, ir, assetGraph, fontGraph, tokens, sourceDir };
        if (viewports.length === REQUIRED_VIEWPORTS.length) built.set(routePath, b);
        log({ event: "route_captured", path: routePath, nodes: ir.doc.nodeCount, vps: viewports.length });
        return b;
      } catch (e) {
        log({ event: "route_capture_failed", path: routePath, error: String(e).slice(0, 200) });
        return null;
      } finally {
        pendingCaptures.delete(pendingKey);
      }
    })();
    pendingCaptures.set(pendingKey, work);
    return work;
  };

  // Expand-in-place: seed the entry route from the reused single-page capture so the
  // capture loop skips it (built.has) — page 1 is never re-captured.
  if (reuseEntrySource) {
    const entrySrc = join(runDir, "routes", routeKey(crawl.entryPath), "source");
    if (resolve(entrySrc) !== resolve(reuseEntrySource)) { rmSync(entrySrc, { recursive: true, force: true }); cpSync(reuseEntrySource, entrySrc, { recursive: true }); }
    try {
      const capture = readJSON<CaptureResult>(join(entrySrc, "capture", "capture-result.json"));
      const ir = buildIR(entrySrc, capture.viewports);
      const assetGraph = buildAssetGraph(capture);
      const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, origin + crawl.entryPath);
      built.set(crawl.entryPath, { capture, ir, assetGraph, fontGraph, tokens: extractTokens(ir), sourceDir: entrySrc });
      log({ event: "route_reused", path: crawl.entryPath, nodes: ir.doc.nodeCount });
    } catch (e) { log({ event: "route_reuse_failed", error: String(e).slice(0, 200) }); }
  }

  // 2. Capture all selected routes (full), bounded-parallel (isolated browser per route).
  await mapLimit(plan.selected, captureConcurrency, (r) => captureRoute(r.path, [...REQUIRED_VIEWPORTS]));

  // 3. Structural confirmation: capture one sibling per collection (light, 1 vp),
  //    compare to the representative; explode collections that aren't real templates.
  const verdicts = new Map<string, boolean>();
  const collectionVerdicts = await mapLimit(plan.collections, captureConcurrency, async (c): Promise<{ template: string; similar: boolean }> => {
    const rep = built.get(c.representative);
    if (!rep || !c.siblingProbe) return { template: c.template, similar: true };
    const sib = await captureRoute(c.siblingProbe, [1280]);
    // A degenerate sample (broken/empty/bot-walled page, e.g. ~2 nodes) carries no
    // structural signal — it must not be allowed to *reject* an otherwise-real
    // collection. Trust the URL grouping (keep collapsed) when either side is
    // degenerate; only an informative sibling can disconfirm.
    if (!sib || sib.ir.doc.nodeCount < 12 || rep.ir.doc.nodeCount < 12) {
      log({ event: "collection_confirm", template: c.template, similar: true, reason: "degenerate_sample" });
      return { template: c.template, similar: true };
    }
    const { similar, score } = structurallySimilar(rep.ir, sib.ir);
    log({ event: "collection_confirm", template: c.template, score: Math.round(score * 1000) / 1000, similar });
    return { template: c.template, similar };
  });
  for (const v of collectionVerdicts) verdicts.set(v.template, v.similar);
  plan = applyConfirmation(plan, verdicts);

  // 3b. Capture any routes newly promoted by an exploded collection (bounded-parallel).
  await mapLimit(plan.selected.filter((r) => !built.has(r.path)), captureConcurrency, (r) => captureRoute(r.path, [...REQUIRED_VIEWPORTS]));

  // 4. Build the link-target map: selected routes → themselves; collapsed collection
  //    instances → their representative's href (so internal links resolve).
  const linkTargets = new Map<string, string>();
  for (const r of plan.selected) linkTargets.set(r.path, routeToSegment(r.path).href);
  for (const c of plan.collections) {
    const repHref = routeToSegment(c.representative).href;
    if (c.listing) linkTargets.set(c.listing, routeToSegment(c.listing).href);
    for (const inst of c.instances) if (!linkTargets.has(inst)) linkTargets.set(inst, repHref);
  }

  // 5. Generate the multi-route app from captured routes (in selected order).
  const routes: RouteArtifact[] = [];
  for (const r of plan.selected) {
    const b = built.get(r.path);
    if (!b) continue;
    routes.push({ routePath: r.path, ir: b.ir, assetGraph: b.assetGraph, fontGraph: b.fontGraph, tokens: b.tokens, sourceDir: b.sourceDir, capture: b.capture, interaction: b.capture.interaction });
  }
  // M4: detect chrome shared across routes (header/footer) to hoist into the layout.
  const entryArtifact = routes.find((r) => r.routePath === crawl.entryPath) ?? routes[0];
  const chrome = entryArtifact ? detectSharedChrome(routes.map((r) => r.ir)) : { headerCount: 0, footerCount: 0 };
  if (chrome.headerCount || chrome.footerCount) log({ event: "shared_chrome", header: chrome.headerCount, footer: chrome.footerCount, sig: entryArtifact ? chromeSignatureId(entryArtifact.ir, chrome) : "" });
  const gen = generateSiteApp({ appDir, routes, linkTargets, origin, entryRoutePath: crawl.entryPath, chrome, components: opts.components, humanizeMode: opts.humanizeMode, framework: opts.framework, reflow: opts.reflow });
  writeJSON(join(runDir, "generated", "extracted-components.json"), gen.extracted);
  writeJSON(join(runDir, "generated", "seo.json"), gen.seoInventory);
  writeText(join(runDir, "generated", "seo.md"), seoInventoryToMarkdown(gen.seoInventory));

  // 6. Site manifest (incl. the CMS-handoff collection map).
  writeJSON(join(runDir, "site-plan.json"), { entry: plan.entry, maxRoutes: plan.maxRoutes, selected: plan.selected, collections: plan.collections, templates: plan.templates, skipped: plan.skipped });
  writeJSON(join(runDir, "site-manifest.json"), {
    sourceUrl: opts.url, origin, entry: crawl.entryPath,
    chrome, extractComponents: !!opts.components, humanizeMode: opts.humanizeMode ?? "tailwind", framework: opts.framework ?? "next", reflow: !!opts.reflow,
    seo: gen.seoInventory.metrics,
    routes: gen.routes.map((r) => ({ ...r, role: plan.selected.find((s) => s.path === r.routePath)?.role ?? "page" })),
    collections: plan.collections.map((c) => ({ template: c.template, instanceCount: c.instanceCount, representative: c.representative, listing: c.listing, confirmed: c.confirmed, instances: c.instances })),
    skipped: plan.skipped, assetsCopied: gen.assetsCopied, assetsMissing: gen.assetsMissing,
    components: gen.components,
  });
  log({ event: "site_generated", routes: gen.routes.length, assetsCopied: gen.assetsCopied });

  // 7. Validate (build + grade per route + site gates), unless disabled.
  let siteReport: SiteReport | undefined;
  if (validate) {
    siteReport = await validateSite(runDir, { tier: opts.tier ?? "stage2", routeConcurrency: opts.validationConcurrency, viewportConcurrency: opts.viewportConcurrency, log });
  }

  let stableAppDir: string | undefined;
  if (out) { exportApp(appDir, out.appDir); log({ event: "exported", app: out.appDir }); }
  else { stableAppDir = writeLatestPointer(runsDir, siteId, runDir); }
  return { runDir, appDir: out ? out.appDir : appDir, siteId, plan, routes, siteReport, stableAppDir };
}

type ManifestForRegen = {
  sourceUrl: string; origin: string; entry: string;
  extractComponents?: boolean;
  humanizeMode?: "tailwind" | "css";
  framework?: AppFramework;
  reflow?: boolean;
  routes: Array<{ routePath: string; href: string }>;
  collections: Array<{ representative: string; listing: string | null; instances: string[] }>;
};

function latestRunFor(runsDir: string, url: string): string | null {
  const siteDir = join(runsDir, "site-" + siteIdFromUrl(url));
  if (!existsSync(siteDir)) return null;
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (existsSync(join(siteDir, runs[i]!, "site-manifest.json"))) return join(siteDir, runs[i]!);
  }
  return null;
}

/**
 * Re-generate (and re-validate) a site from its existing per-route captures — no
 * re-capture. Lets generation/layout changes be iterated quickly (the multi-route
 * analogue of clone-static --reuse).
 */
export async function regenerateSite(runDir: string, opts?: { tier?: string; validate?: boolean; validationConcurrency?: number; viewportConcurrency?: number; log?: (e: Record<string, unknown>) => void }): Promise<CloneSiteResult> {
  const log = opts?.log ?? (() => {});
  const m = readJSON<ManifestForRegen>(join(runDir, "site-manifest.json"));
  const appDir = join(runDir, "generated", "app");
  const routes: RouteArtifact[] = [];
  for (const r of m.routes) {
    const sourceDir = join(runDir, "routes", routeKey(r.routePath), "source");
    if (!fileExists(join(sourceDir, "capture", "capture-result.json"))) continue;
    const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
    const ir = buildIR(sourceDir, capture.viewports);
    const assetGraph = buildAssetGraph(capture);
    const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, m.origin + r.routePath);
    routes.push({ routePath: r.routePath, ir, assetGraph, fontGraph, tokens: extractTokens(ir), sourceDir, capture, interaction: capture.interaction });
  }
  const linkTargets = new Map<string, string>();
  for (const r of m.routes) linkTargets.set(r.routePath, r.href);
  for (const c of m.collections) {
    const repHref = routeToSegment(c.representative).href;
    if (c.listing) linkTargets.set(c.listing, routeToSegment(c.listing).href);
    for (const inst of c.instances) if (!linkTargets.has(inst)) linkTargets.set(inst, repHref);
  }
  const entryArtifact = routes.find((r) => r.routePath === m.entry) ?? routes[0];
  const chrome = entryArtifact ? detectSharedChrome(routes.map((r) => r.ir)) : { headerCount: 0, footerCount: 0 };
  log({ event: "regen", routes: routes.length, chrome });
  rmSync(join(appDir, "src", "app"), { recursive: true, force: true });
  rmSync(join(appDir, "src", "routes"), { recursive: true, force: true });
  const gen = generateSiteApp({ appDir, routes, linkTargets, origin: m.origin, entryRoutePath: m.entry, chrome, components: m.extractComponents, humanizeMode: m.humanizeMode, framework: m.framework, reflow: m.reflow });
  writeJSON(join(runDir, "generated", "extracted-components.json"), gen.extracted);
  writeJSON(join(runDir, "generated", "seo.json"), gen.seoInventory);
  writeText(join(runDir, "generated", "seo.md"), seoInventoryToMarkdown(gen.seoInventory));
  writeJSON(join(runDir, "site-manifest.json"), { ...m, chrome, seo: gen.seoInventory.metrics, components: gen.components, routes: gen.routes.map((r) => ({ ...r, role: (m.routes.find((x) => x.routePath === r.routePath) as { role?: string } | undefined)?.role ?? "page" })) });

  let siteReport: SiteReport | undefined;
  if (opts?.validate === true) siteReport = await validateSite(runDir, { tier: opts?.tier ?? "stage2", routeConcurrency: opts?.validationConcurrency, viewportConcurrency: opts?.viewportConcurrency, log });
  return { runDir, appDir, siteId: "", plan: { entry: m.entry, maxRoutes: 0, selected: [], collections: [], templates: [], skipped: [] }, routes, siteReport };
}

function printResult(url: string, res: CloneSiteResult): void {
  const { plan } = res;
  console.log(`\n# clone-site — ${url}`);
  console.log(`  run: ${res.runDir}`);
  console.log(`  generated ${res.routes.length} route page(s); ${plan.collections.length} collapsed collection(s)\n`);
  for (const r of plan.selected) {
    const built = res.routes.find((x) => x.routePath === r.path);
    console.log(`    ${r.role.padEnd(14)} ${routeToSegment(r.path).href}${built ? "" : "   (capture failed)"}`);
  }
  if (plan.collections.length) {
    console.log(`\n  collapsed collections (1 representative each):`);
    for (const c of plan.collections) console.log(`    ${c.template}  (${c.instanceCount}) → ${c.representative}  ${c.confirmed ? "[confirmed]" : "[unconfirmed]"}`);
  }
  const sr = res.siteReport;
  if (sr) {
    console.log(`\n  validation: build ${sr.buildOk ? "✅" : "❌"} · gates0–6 ${sr.routesGates0to6}/${sr.routesTotal} · stage2 ${sr.routesStage2}/${sr.routesTotal} · links ${sr.linkIntegrity.pass ? "✅" : "❌"} · determinism ${sr.siteDeterminism.pass ? "✅" : "❌"}`);
    for (const r of sr.routes) console.log(`    ${r.report.scorecard.total.toString().padStart(5)}  ${r.report.gates0to6Pass ? "✅" : "❌"} ${r.href}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: clone-site <url> [--styling=tailwind|css] [--framework=next|vite] [--out=<dir>] [--validate]");
    process.exit(1);
  }
  // --out=<dir>: clean <dir>/<siteName>/{app,.clone}; reuses a prior single-page clone's
  // capture as the entry route (expand-in-place). Bare --out defaults to ./output.
  const outArg = args.find((a) => a === "--out" || a.startsWith("--out="));
  const outDir = outArg ? (outArg.includes("=") ? outArg.split("=")[1] : "output") : undefined;
  const maxRoutes = args.find((a) => a.startsWith("--max-routes="))?.split("=")[1];
  const maxCollection = args.find((a) => a.startsWith("--max-collection="))?.split("=")[1];
  const maxDepth = args.find((a) => a.startsWith("--depth="))?.split("=")[1];
  const concurrency = args.find((a) => a.startsWith("--concurrency="))?.split("=")[1];
  const validationConcurrency = args.find((a) => a.startsWith("--validate-concurrency=") || a.startsWith("--validation-concurrency="))?.split("=")[1];
  const viewportConcurrency = args.find((a) => a.startsWith("--viewport-concurrency="))?.split("=")[1];
  const runsArg = args.find((a) => a.startsWith("--runs="))?.split("=")[1];
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1];
  const validate = args.includes("--validate") && !args.includes("--no-validate");
  // Screenshots are only consumed by the (inline) validator, so tie them to it: default no-validate skips the
  // full-page screenshots too — the production fast path (no pixel work AND no second render pass).
  const screenshots = validate;
  const interactions = !args.includes("--no-interactions");
  const components = !args.includes("--no-components");
  const stylingArg = args.find((a) => a.startsWith("--styling="))?.split("=")[1];
  if (stylingArg && stylingArg !== "tailwind" && stylingArg !== "css") {
    console.error(`invalid --styling=${stylingArg}; expected "tailwind" or "css"`);
    process.exit(1);
  }
  // Styling output defaults to Tailwind v4; --css is kept as a compatibility alias.
  const humanizeMode = (stylingArg as "tailwind" | "css" | undefined) ?? (args.includes("--css") ? "css" as const : "tailwind" as const);
  const frameworkArg = args.find((a) => a.startsWith("--framework="))?.split("=")[1] ?? (args.includes("--vite") ? "vite" : undefined);
  if (frameworkArg && frameworkArg !== "next" && frameworkArg !== "vite") {
    console.error(`invalid --framework=${frameworkArg}; expected "next" or "vite"`);
    process.exit(1);
  }
  const framework = (frameworkArg as AppFramework | undefined) ?? "next";
  // Reflow trade ON by default (matches single-page); --no-reflow to disable.
  const reflow = !args.includes("--no-reflow");
  const runsDir = runsArg ? resolve(runsArg) : undefined;

  // --regen[=runDir]: re-generate + re-validate from existing captures (no capture).
  const regenArg = args.find((a) => a === "--regen" || a.startsWith("--regen="));
  if (regenArg) {
    const explicit = regenArg.includes("=") ? resolve(regenArg.split("=")[1]!) : null;
    const runDir = explicit ?? latestRunFor(runsDir ?? resolve(process.cwd(), "..", "runs"), url);
    if (!runDir) { console.error("no existing run to regenerate for " + url); process.exit(1); }
    const res = await regenerateSite(runDir, {
      tier,
      validate,
      validationConcurrency: validationConcurrency ? parseInt(validationConcurrency, 10) : undefined,
      viewportConcurrency: viewportConcurrency ? parseInt(viewportConcurrency, 10) : undefined,
      log: (e) => console.log(JSON.stringify(e)),
    });
    if (basename(runDir) === ".clone") {
      const deliverable = join(runDir, "..", "app");
      const pub = exportApp(res.appDir, deliverable);
      console.log(JSON.stringify({ event: "exported", app: deliverable, ...pub }));
    }
    printResult(url, res);
    console.log(JSON.stringify({ event: "done", runDir: res.runDir }));
    return;
  }

  const res = await runCloneSite({
    url,
    runsDir,
    maxRoutes: maxRoutes ? parseInt(maxRoutes, 10) : undefined,
    maxCollectionInstances: maxCollection ? parseInt(maxCollection, 10) : undefined,
    maxDepth: maxDepth ? parseInt(maxDepth, 10) : undefined,
    captureConcurrency: concurrency ? parseInt(concurrency, 10) : undefined,
    validationConcurrency: validationConcurrency ? parseInt(validationConcurrency, 10) : undefined,
    viewportConcurrency: viewportConcurrency ? parseInt(viewportConcurrency, 10) : undefined,
    validate,
    interactions,
    components,
    humanizeMode,
    framework,
    reflow,
    screenshots,
    outDir,
    tier,
    log: (e) => console.log(JSON.stringify(e)),
  });
  printResult(url, res);
  console.log(JSON.stringify({ event: "done", runDir: res.runDir, app: res.appDir }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
