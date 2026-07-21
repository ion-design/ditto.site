/**
 * Site validation (Stage 3, M5). Builds the multi-route app once, serves it, then
 * renders + grades every route with the existing Gates 0–6 + stage-2 pollution/
 * perceptual (reused wholesale from the single-page validator), and adds the
 * site-level gates: link integrity (internal links resolve to generated routes),
 * shared-chrome consistency (M4), and site determinism (regenerate → byte-stable).
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildIR, isTextChild, type IR, type IRNode } from "../normalize/ir.js";
import { toRoutePath } from "../crawl/url.js";
import { detectSections } from "../infer/sections.js";
import { buildAssetGraph } from "../infer/assets.js";
import { buildFontGraph } from "../infer/fonts.js";
import { extractTokens } from "../infer/tokens.js";
import { buildApp, serveStatic, renderApp, findRemoteRefs, type GenNode } from "../validate/render.js";
import { gate1Capture, gate2Assets, gate3Dom, gate4Style, gate5Layout, gatePollution, type GateResult } from "../validate/gates.js";
import { screenshotDiff } from "../validate/validate.js";
import { driveInteractionGate } from "../validate/interactionGate.js";
import { buildReport, reportToMarkdown, type Report } from "../validate/report.js";
import { COMPILER_VERSION } from "../generate/manifest.js";
import { interactionRejectedArtifact } from "../generate/interactive.js";
import { generateSiteApp, routeToSegment, routeKey, type RouteArtifact } from "./generateSite.js";
import { remapChromeCids, type ChromePlan } from "./sharedLayout.js";
import { readJSON, writeJSON, writeText, ensureDir, fileExists } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";
import type { PageSnapshot } from "../capture/walker.js";
import type { AppFramework } from "../generate/app.js";

const DEFAULT_HARNESS = fileURLToPath(new URL("../../.harness", import.meta.url));

type ManifestRoute = { routePath: string; href: string; dir: string; role: string };
type ManifestCollection = { template: string; representative: string; listing: string | null; instances: string[] };
type SiteManifest = { sourceUrl: string; origin: string; entry: string; chrome?: ChromePlan; extractComponents?: boolean; framework?: AppFramework; reflow?: boolean; routes: ManifestRoute[]; collections: ManifestCollection[] };

export type SiteRouteReport = { routePath: string; href: string; role: string; report: Report };
export type SiteReport = {
  sourceUrl: string;
  generatedAt: string;
  buildOk: boolean;
  routesTotal: number;
  routesGates0to6: number;
  routesStage2: number;
  linkIntegrity: GateResult;
  siteDeterminism: GateResult;
  routes: SiteRouteReport[];
};

export type ValidateSiteOptions = {
  harnessDir?: string;
  tier?: string;
  log?: (e: Record<string, unknown>) => void;
  /** Routes to render/grade concurrently after the single shared build. */
  routeConcurrency?: number;
  /** Back-compat alias for routeConcurrency. */
  validationConcurrency?: number;
  /** Viewports to render concurrently within one route render. */
  viewportConcurrency?: number;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return out;
}

function readManifest(runDir: string): SiteManifest {
  return readJSON<SiteManifest>(join(runDir, "site-manifest.json"));
}

function buildRouteArtifacts(runDir: string, m: SiteManifest, viewports: number[]): RouteArtifact[] {
  const out: RouteArtifact[] = [];
  for (const r of m.routes) {
    const sourceDir = join(runDir, "routes", routeKey(r.routePath), "source");
    if (!fileExists(join(sourceDir, "capture", "capture-result.json"))) continue;
    const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
    const ir = buildIR(sourceDir, viewports);
    const assetGraph = buildAssetGraph(capture);
    const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, m.origin + r.routePath);
    const tokens = extractTokens(ir);
    out.push({ routePath: r.routePath, ir, assetGraph, fontGraph, tokens, sourceDir, capture });
  }
  return out;
}

/** Apply the same internal-link rewriting the generator used, to the validation IR,
 *  so the DOM gate compares the rendered href against the *policy* target (collapsed
 *  collection links → representative). Link integrity separately proves they resolve. */
function rewriteIrLinks(ir: IR, base: string, linkTargets: Map<string, string>): void {
  const rw = (raw: string): string => {
    if (raw.startsWith("#")) return raw;
    const p = toRoutePath(raw, base);
    if (p && linkTargets.has(p)) return linkTargets.get(p)!;
    try { return new URL(raw, base).href; } catch { return raw; }
  };
  const walk = (n: IRNode): void => {
    if (n.attrs.href !== undefined) n.attrs.href = rw(n.attrs.href);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
}

function rebuildLinkTargets(m: SiteManifest): Map<string, string> {
  const lt = new Map<string, string>();
  for (const r of m.routes) lt.set(r.routePath, r.href);
  for (const c of m.collections) {
    const repHref = routeToSegment(c.representative).href;
    if (c.listing) lt.set(c.listing, routeToSegment(c.listing).href);
    for (const inst of c.instances) if (!lt.has(inst)) lt.set(inst, repHref);
  }
  return lt;
}

function viteHtmlPathForHref(href: string): string {
  const clean = href.replace(/^\/+/, "").replace(/\/+$/, "");
  return clean ? `${clean}/index.html` : "index.html";
}

/** Every internal (root-relative or loopback) link in the rendered routes must
 *  resolve to a generated route; external links are allowed. A link resolves if its
 *  path is a generated route href (the policy: link rewriting points internal links
 *  only at generated routes / collapsed representatives) or, as a backstop, a built
 *  file exists (covers Next's export naming). */
function checkLinkIntegrity(snapshotsByRoute: Record<string, Record<number, PageSnapshot>>, outDir: string, validHrefs: Set<string>): GateResult {
  const resolves = (href: string): boolean => {
    let p = href;
    if (/^https?:\/\//.test(p)) {
      if (!/127\.0\.0\.1|localhost/.test(p)) return true; // external — allowed
      try { p = new URL(p).pathname; } catch { return false; }
    }
    if (!p.startsWith("/")) return true; // relative-to-page or anchor — skip
    p = (p.split("#")[0]!.split("?")[0]!).replace(/\/+$/, "") || "/";
    if (validHrefs.has(p)) return true; // a generated route href
    if (p === "/") return existsSync(join(outDir, "index.html"));
    const rel = p.replace(/^\/+/, "").replace(/\/+$/, "");
    return existsSync(join(outDir, rel + ".html")) || existsSync(join(outDir, rel, "index.html"));
  };
  const unresolved = new Set<string>();
  let internal = 0;
  for (const byVp of Object.values(snapshotsByRoute)) {
    for (const snap of Object.values(byVp)) {
      const walk = (n: PageSnapshot["root"]): void => {
        if (n.tag === "a" && n.attrs.href) {
          const h = n.attrs.href;
          const isLocal = h.startsWith("/") || /127\.0\.0\.1|localhost/.test(h);
          if (isLocal && !h.startsWith("//")) { internal++; if (!resolves(h)) unresolved.add(h.split("#")[0]!); }
        }
        for (const c of n.children) if ((c as { text?: string }).text === undefined) walk(c as PageSnapshot["root"]);
      };
      walk(snap.root);
    }
  }
  const issues = unresolved.size ? [`${unresolved.size} internal link target(s) do not resolve: ${[...unresolved].slice(0, 6).join(", ")}`] : [];
  return { gate: "link_integrity", pass: unresolved.size === 0, metrics: { internalLinks: internal, unresolved: unresolved.size, sample: [...unresolved].slice(0, 10) }, issues };
}

function checkSiteDeterminism(runDir: string, m: SiteManifest, viewports: number[]): GateResult {
  const a = mkdtempSync(join(tmpdir(), "site-det-a-"));
  const b = mkdtempSync(join(tmpdir(), "site-det-b-"));
  const issues: string[] = [];
  try {
    const artifacts = buildRouteArtifacts(runDir, m, viewports);
    const lt = rebuildLinkTargets(m);
    generateSiteApp({ appDir: join(a, "app"), routes: artifacts, linkTargets: lt, origin: m.origin, entryRoutePath: m.entry, chrome: m.chrome, components: m.extractComponents, framework: m.framework, reflow: m.reflow });
    generateSiteApp({ appDir: join(b, "app"), routes: artifacts, linkTargets: lt, origin: m.origin, entryRoutePath: m.entry, chrome: m.chrome, components: m.extractComponents, framework: m.framework, reflow: m.reflow });
    const isVite = m.framework === "vite";
    const files = isVite
      ? [
        "AGENTS.md", "ARCHITECTURE.md",
        "index.html", "vite.config.ts", "src/globals.css",
        "public/robots.txt", "public/sitemap.xml", "public/llms.txt",
      ]
      : [
        "AGENTS.md", "ARCHITECTURE.md",
        "src/app/globals.css", "src/app/layout.tsx",
        "src/app/robots.ts", "src/app/sitemap.ts", "src/app/llms.txt/route.ts",
      ];
    if (m.chrome && (m.chrome.headerCount > 0 || m.chrome.footerCount > 0)) files.push(isVite ? "src/ditto-chrome.css" : "src/app/ditto-chrome.css");
    if (isVite && m.chrome && (m.chrome.headerCount > 0 || m.chrome.footerCount > 0)) files.push("src/Chrome.tsx");
    for (const r of m.routes) {
      if (isVite) {
        const base = `src/routes/${routeKey(r.routePath)}`;
        files.push(viteHtmlPathForHref(routeToSegment(r.routePath).href), `${base}/page.tsx`, `${base}/main.tsx`, `${base}/ditto.css`);
      } else {
        const seg = routeToSegment(r.routePath).dir;
        const base = seg ? `src/app/${seg}` : "src/app";
        files.push(`${base}/page.tsx`, `${base}/ditto.css`);
      }
    }
    for (const f of files) {
      const pa = join(a, "app", f), pb = join(b, "app", f);
      if (!existsSync(pa) || !existsSync(pb)) { issues.push(`missing ${f}`); continue; }
      if (readFileSync(pa, "utf8") !== readFileSync(pb, "utf8")) issues.push(`differs: ${f}`);
    }
  } catch (e) {
    issues.push("site determinism error: " + String(e).slice(0, 160));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
  return { gate: "site_determinism", pass: issues.length === 0, metrics: { mismatches: issues.length }, issues };
}

export async function validateSite(runDir: string, opts?: ValidateSiteOptions): Promise<SiteReport> {
  const log = opts?.log ?? (() => {});
  const harnessDir = opts?.harnessDir ?? DEFAULT_HARNESS;
  const tier = opts?.tier ?? "stage2";
  const routeConcurrency = Math.max(1, opts?.routeConcurrency ?? opts?.validationConcurrency ?? 2);
  const viewportConcurrency = Math.max(1, opts?.viewportConcurrency ?? 2);
  const m = readManifest(runDir);
  const linkTargets = rebuildLinkTargets(m);
  const chrome = m.chrome && (m.chrome.headerCount > 0 || m.chrome.footerCount > 0) ? m.chrome : null;
  // Entry IR provides the canonical chrome cids for remapping each route's chrome
  // (so the route IR matches the rendered DOM, whose chrome is the hoisted layout).
  let entryIr: IR | null = null;
  if (chrome) {
    const entrySrc = join(runDir, "routes", routeKey(m.entry), "source");
    if (fileExists(join(entrySrc, "capture", "capture-result.json"))) entryIr = buildIR(entrySrc, [375, 768, 1280, 1920]);
  }
  const appDir = join(runDir, "generated", "app");

  // Build once.
  log({ event: "site_build_start", routes: m.routes.length });
  const build = buildApp(appDir, harnessDir);
  log({ event: "site_build_done", ok: build.ok, ms: build.durationMs });

  const routeReports: SiteRouteReport[] = [];
  const snapshotsByRoute: Record<string, Record<number, PageSnapshot>> = {};
  let anyRejected = false; // a route had interaction patterns that didn't reproduce → prune
  const siteDeterminism = checkSiteDeterminism(runDir, m, [375, 768, 1280, 1920]);

  if (build.ok && build.outDir) {
    const server = await serveStatic(build.outDir);
    try {
      const routeResults = await mapLimit(m.routes, routeConcurrency, async (r): Promise<{ report: SiteRouteReport; snapshots: Record<number, PageSnapshot>; rejected: boolean } | null> => {
        const sourceDir = join(runDir, "routes", routeKey(r.routePath), "source");
        if (!fileExists(join(sourceDir, "capture", "capture-result.json"))) return null;
        const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
        const viewports = capture.viewports;
        const ir = buildIR(sourceDir, viewports);
        rewriteIrLinks(ir, m.origin + r.routePath, linkTargets);
        if (chrome && entryIr) remapChromeCids(ir, entryIr, chrome);
        const sections = detectSections(ir);
        const assetGraph = buildAssetGraph(capture);
        const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, m.origin + r.routePath);
        const renderedDir = join(runDir, "routes", routeKey(r.routePath), "rendered");

        const rr = await renderApp({ url: server.url + r.href, viewports, renderedDir, concurrency: viewportConcurrency });
        const origin = new URL(m.sourceUrl).origin;
        const assetFailed = rr.failedResources.filter((f) => f.includes("/assets/") && !/\.(mp4|webm|mov|m4v|ogv|ogg|mp3|wav|m3u8)(\?|$)/i.test(f));

        const screenshots: Record<number, boolean> = {};
        for (const vp of viewports) screenshots[vp] = fileExists(join(sourceDir, "screenshots", `${vp}.png`));
        const gate0: GateResult = {
          gate: "build",
          pass: build.ok && rr.httpStatus === 200 && rr.runtimeErrors.length === 0,
          metrics: { buildOk: build.ok, http200: rr.httpStatus === 200, noRuntimeErrors: rr.runtimeErrors.length === 0, artifactsPresent: true, buildMs: build.durationMs, runtimeErrorSample: [...new Set(rr.runtimeErrors)].slice(0, 5) },
          issues: [
            ...(build.ok ? [] : ["build failed"]),
            ...(rr.httpStatus === 200 ? [] : [`http ${rr.httpStatus}`]),
            ...(rr.runtimeErrors.length ? [`${rr.runtimeErrors.length} runtime errors`] : []),
          ],
        };
        const gates: Record<string, GateResult> = {
          build: gate0,
          capture: gate1Capture(ir, viewports, { screenshots, assetsPresent: fileExists(join(sourceDir, "assets-discovered.json")), fontsPresent: fileExists(join(sourceDir, "fonts-discovered.json")) }),
          asset_font: gate2Assets(assetGraph, fontGraph, { remoteRefs: findRemoteRefs(rr.snapshots), failed404: assetFailed }),
          dom: gate3Dom(ir, rr.snapshots, viewports, origin),
          style: gate4Style(ir, rr.snapshots, viewports),
          layout: gate5Layout(ir, rr.snapshots, sections, viewports),
          determinism: siteDeterminism.pass ? { gate: "determinism", pass: true, metrics: {}, issues: [] } : { gate: "determinism", pass: false, metrics: {}, issues: ["site determinism failed"] },
          pollution: gatePollution(ir, capture, viewports),
          perceptual: screenshotDiff(sourceDir, renderedDir, viewports, renderedDir, tier),
        };
        // Stage 4: drive this route's recognized interactions in the built clone, and
        // record any that didn't reproduce so they're pruned to static on regenerate.
        let rejected = false;
        if (capture.interaction) {
          gates.interaction = await driveInteractionGate({ url: server.url + r.href, viewports, ir, interaction: capture.interaction });
          const rej = (gates.interaction.metrics.rejected as string[] | undefined) ?? [];
          if (rej.length) { writeJSON(join(sourceDir, "interaction-rejected.json"), interactionRejectedArtifact(rej)); rejected = true; }
          else rmSync(join(sourceDir, "interaction-rejected.json"), { force: true });
        }
        const report = buildReport({ sourceUrl: m.origin + r.routePath, tier, compilerVersion: COMPILER_VERSION, gates });
        log({ event: "route_validated", path: r.routePath, score: report.scorecard.total, g06: report.gates0to6Pass, stage2: report.stage2Pass, failing: Object.entries(report.gates).filter(([, g]) => !g.pass).map(([k]) => k) });
        return { report: { routePath: r.routePath, href: r.href, role: r.role, report }, snapshots: rr.snapshots, rejected };
      });
      for (const result of routeResults) {
        if (!result) continue;
        routeReports.push(result.report);
        snapshotsByRoute[result.report.routePath] = result.snapshots;
        anyRejected = anyRejected || result.rejected;
      }
    } finally {
      await server.close();
    }
  }

  // Prune: regenerate the deliverable with gate-rejected patterns left static (per
  // route's interaction-rejected.json, written above + read by generateSiteApp).
  if (anyRejected) {
    const artifacts = buildRouteArtifacts(runDir, m, [375, 768, 1280, 1920]);
    generateSiteApp({ appDir, routes: artifacts, linkTargets, origin: m.origin, entryRoutePath: m.entry, chrome: m.chrome, components: m.extractComponents, reflow: m.reflow });
    log({ event: "interaction_pruned_site" });
  }

  const validHrefs = new Set<string>(["/", ...m.routes.map((r) => r.href)]);
  const linkIntegrity = build.ok ? checkLinkIntegrity(snapshotsByRoute, build.outDir!, validHrefs) : { gate: "link_integrity", pass: false, metrics: {}, issues: ["no build to check"] };

  const siteReport: SiteReport = {
    sourceUrl: m.sourceUrl,
    generatedAt: new Date().toISOString(),
    buildOk: build.ok,
    routesTotal: routeReports.length,
    routesGates0to6: routeReports.filter((r) => r.report.gates0to6Pass).length,
    routesStage2: routeReports.filter((r) => r.report.stage2Pass).length,
    linkIntegrity,
    siteDeterminism,
    routes: routeReports,
  };
  const validationDir = join(runDir, "validation");
  ensureDir(validationDir);
  writeJSON(join(validationDir, "site-report.json"), siteReport);
  writeText(join(validationDir, "site-report.md"), siteReportMd(siteReport));
  if (build.stderr && !build.ok) writeText(join(runDir, "logs", "site-build.log"), build.stderr);
  log({ event: "site_validated", routes: siteReport.routesTotal, g06: siteReport.routesGates0to6, stage2: siteReport.routesStage2, linkIntegrity: linkIntegrity.pass, siteDeterminism: siteDeterminism.pass });
  return siteReport;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  if (!runDir) { console.error("usage: validate-site <runDir> [--tier=stage2]"); process.exit(1); }
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1];
  const routeConcurrency = args.find((a) => a.startsWith("--route-concurrency=") || a.startsWith("--validate-concurrency="))?.split("=")[1];
  const viewportConcurrency = args.find((a) => a.startsWith("--viewport-concurrency="))?.split("=")[1];
  const report = await validateSite(resolveRun(runDir), {
    tier,
    routeConcurrency: routeConcurrency ? parseInt(routeConcurrency, 10) : undefined,
    viewportConcurrency: viewportConcurrency ? parseInt(viewportConcurrency, 10) : undefined,
    log: (e) => console.log(JSON.stringify(e)),
  });
  console.log("\n" + siteReportMd(report));
}

function resolveRun(p: string): string {
  // Accept either a concrete run dir or a site dir (use its latest timestamp).
  if (existsSync(join(p, "site-manifest.json"))) return p;
  return p;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

function siteReportMd(s: SiteReport): string {
  const lines: string[] = [
    `# Site clone validation — ${s.sourceUrl}`,
    ``,
    `- Build: ${s.buildOk ? "✅" : "❌"}`,
    `- Routes passing Gates 0–6: **${s.routesGates0to6} / ${s.routesTotal}**`,
    `- Routes passing stage-2 bar: **${s.routesStage2} / ${s.routesTotal}**`,
    `- Link integrity: ${s.linkIntegrity.pass ? "✅" : "❌ " + s.linkIntegrity.issues.join("; ")}`,
    `- Site determinism: ${s.siteDeterminism.pass ? "✅" : "❌ " + s.siteDeterminism.issues.join("; ")}`,
    ``,
    `| Route | Role | Score | G0–6 | Stage2 | Failing |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of s.routes) {
    const failing = Object.entries(r.report.gates).filter(([, g]) => !g.pass).map(([k]) => k).join(", ") || "—";
    lines.push(`| ${r.href} | ${r.role} | ${r.report.scorecard.total} | ${r.report.gates0to6Pass ? "✅" : "❌"} | ${r.report.stage2Pass ? "✅" : "❌"} | ${failing} |`);
  }
  return lines.join("\n") + "\n";
}
