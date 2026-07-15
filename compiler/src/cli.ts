#!/usr/bin/env -S npx tsx
import { join, resolve } from "node:path";
import { cpSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { captureSite, REQUIRED_VIEWPORTS, SAMPLE_VIEWPORTS, type CaptureResult } from "./capture/capture.js";
import { fileURLToPath } from "node:url";
import { generateAll } from "./generate/pipeline.js";
import { refineSizing } from "./generate/refineSizing.js";
import { writeJSON, writeText, ensureDir, readJSON, fileExists } from "./util/fsx.js";
import { doneSummary, serveApp } from "./cliSummary.js";
import type { AppFramework } from "./generate/app.js";
import { exportApp } from "./export/deliveryClean.js";

// Delivery cleanup lives in export/deliveryClean.ts (shared with the service
// path); re-exported here so existing importers (cloneSite.ts, runner/regen.ts)
// keep working unchanged.
export { exportApp, stripDeliveryDataCids } from "./export/deliveryClean.js";

export type CloneOptions = {
  url: string;
  runsDir?: string;
  viewports?: number[];
  reuseSource?: string; // path to an existing source/ dir to skip capture
  interactions?: boolean; // Stage 4 — capture & reproduce hover/focus states (opt-in)
  components?: boolean; // Stage 4.5 — extract repeated subtrees into components (opt-in)
  motion?: boolean; // Stage 5 — capture & replay motion (CSS @keyframes / WAAPI / rotating text)
  dense?: boolean; // capture intermediate/wide widths (SAMPLE_VIEWPORTS) to strengthen size inference
  humanizeMode?: "tailwind" | "css"; // styling output — Tailwind utilities (default) or semantic CSS
  framework?: AppFramework; // output framework — Next.js App Router (default) or Vite React
  outDir?: string; // write a clean <outDir>/<siteName>/{app,.clone} layout instead of runs/<id>/<ts>
  refineSizing?: boolean; // iterate render→regen until the clone-probe converges (proxy mode)
  reflow?: boolean; // Reflow trade: flow all heights (cleaner code,
                    // content re-positions between breakpoints; backstopped by the perceptual gate).
                    // ON by default at the CLI (--no-reflow to disable); persisted per-run in clone-options.json.
  screenshots?: boolean; // capture per-viewport screenshots (default on); --no-screenshots skips them for a
                         // faster production clone (validation-only artifact — generation ignores pixels).
  log?: (event: Record<string, unknown>) => void;
};

export type CloneResult = {
  runDir: string;
  sourceDir: string;
  appDir: string;
  sourceUrl: string;
  /** A stable, timestamp-free path to the app (via the `runs/<site>/latest` symlink),
   *  present in runs-layout mode when the symlink could be created. */
  stableAppDir?: string;
  /** Visual assets (image/svg/video) that could not be downloaded — those boxes render
   *  as placeholders. Surfaced in the CLI summary; details in generated/assets.json. */
  visualAssetsMissing?: number;
};

export function siteIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    return (host + (path ? "-" + path : "")).replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 80);
  } catch {
    return "site-" + url.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);
  }
}

// Common multi-part public suffixes — not exhaustive, covers the frequent ones; anything
// else is treated as a single-chunk TLD.
const MULTIPART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz",
  "co.za", "co.jp", "or.jp", "ne.jp", "com.br", "com.mx", "com.ar", "com.sg", "com.hk",
  "co.in", "co.kr", "com.tr", "com.cn",
]);
/** A short, human folder name for a site: the registrable domain's main label, minus
 *  `www.` and the TLD — `www.ion.design` → `ion`, `blog.example.co.uk` → `example`,
 *  `blog.example.co.uk` → `example`. Falls back to the full slug for non-host URLs
 *  (e.g. file://) so it's always a valid, non-empty directory name. */
export function siteName(url: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* not a URL */ }
  host = host.replace(/^www\./i, "");
  const labels = host.split(".").filter(Boolean);
  let name = "";
  if (labels.length <= 1) name = labels[0] ?? "";
  else {
    const tldParts = MULTIPART_TLDS.has(labels.slice(-2).join(".")) ? 2 : 1;
    name = labels[labels.length - 1 - tldParts] ?? labels[0]!;
  }
  name = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return name || siteIdFromUrl(url);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** `--out` layout: a clean, predictable `<outDir>/<siteName>/` folder holding the
 *  deliverable app at `app/` and the reusable working artifacts (capture/IR/validation)
 *  under `.clone/` — so a later `clone-site --out` can expand into the full site without
 *  re-capturing page 1. Single + multi clones of the same site share this folder. */
export function namedOutDirs(outDir: string, url: string): { namedDir: string; runDir: string; appDir: string } {
  const namedDir = join(resolve(outDir), siteName(url));
  return { namedDir, runDir: join(namedDir, ".clone"), appDir: join(namedDir, "app") };
}
/** Run the deterministic compiler end-to-end. Capture is skippable via reuseSource. */
export async function runClone(opts: CloneOptions): Promise<CloneResult> {
  // The size-inference SAMPLE set. Defaults to the standard 4 (band) widths; pass `--dense` to
  // also capture intermediate/wide widths (SAMPLE_VIEWPORTS) — the IR feeds those to width
  // inference while still emitting bands only at the standard breakpoints. NOTE: dense capture
  // makes the inference STRICTER (verified at more widths → fewer false relatives), which is more
  // correct but currently nets slightly MORE baked px until container-level natural-size recovery
  // lands; left opt-in for now. A --viewports override sets both sets explicitly.
  const captureViewports = opts.viewports ?? (opts.dense ? [...SAMPLE_VIEWPORTS] : [...REQUIRED_VIEWPORTS]);
  const viewports = opts.viewports ?? [...REQUIRED_VIEWPORTS];
  const log = opts.log ?? (() => {});
  const runsDir = opts.runsDir ?? resolve(process.cwd(), "..", "runs");
  const siteId = siteIdFromUrl(opts.url);
  // --out: predictable <outDir>/<siteName>/.clone working dir + app/ deliverable.
  const out = opts.outDir ? namedOutDirs(opts.outDir, opts.url) : null;
  const runDir = out ? out.runDir : join(runsDir, siteId, timestamp());
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const appDir = join(generatedDir, "app");
  ensureDir(runDir);
  ensureDir(join(runDir, "logs"));

  const logEvents: Record<string, unknown>[] = [];
  const logBoth = (e: Record<string, unknown>) => { logEvents.push(e); log(e); };

  writeJSON(join(runDir, "input.json"), { url: opts.url, siteId, viewports, sampleViewports: captureViewports, startedAt: new Date().toISOString() });

  // 1. Capture (or reuse)
  let capture: CaptureResult;
  if (opts.reuseSource && fileExists(join(opts.reuseSource, "capture", "capture-result.json"))) {
    logBoth({ event: "capture_reuse", from: opts.reuseSource });
    capture = readJSON<CaptureResult>(join(opts.reuseSource, "capture", "capture-result.json"));
    // Copy reuseSource contents would be ideal; instead, point sourceDir at it via re-read.
    // For simplicity the IR is built from reuseSource and other artifacts written into runDir.
    copySourceRef(opts.reuseSource, sourceDir);
  } else {
    capture = await captureSite({ url: opts.url, outDir: sourceDir, viewports: captureViewports, interactions: opts.interactions, motion: opts.motion, screenshots: opts.screenshots, log: logBoth });
  }

  // Stage 4.5: persist the component-extraction choice in the source dir so every
  // generateAll for this run (deliverable + determinism/prune regens, possibly in a
  // separate validate process) reads the same flag and stays deterministic.
  writeJSON(join(sourceDir, "clone-options.json"), { components: !!opts.components, ...(opts.humanizeMode ? { humanizeMode: opts.humanizeMode } : {}), ...(opts.framework ? { framework: opts.framework } : {}), reflow: !!opts.reflow });

  // 2-5. Normalize → infer → generate → emit (shared deterministic pipeline)
  const gen = generateAll({ sourceDir, capture, viewports, sampleViewports: captureViewports, url: opts.url, outDir: generatedDir });
  logBoth({ event: "ir_built", nodes: gen.ir.doc.nodeCount });
  logBoth({ event: "inferred", sections: gen.sections.length, assets: gen.assetGraph.entries.length, fonts: gen.fontGraph.entries.length });
  const visualAssetsMissing = gen.assetGraph.entries.filter((e) => e.impact === "visual_missing").length;
  logBoth({ event: "generated", assetsCopied: gen.assetsCopied, assetsMissing: gen.assetsMissing.length, visualAssetsMissing });

  // When the source capture lacks native probe flags (this sandbox can't reach the
  // live site through the egress proxy), optionally iterate render→regen so the LOCAL clone-probe
  // converges. A no-op with a real source-probe (the source layout is fixed → one pass).
  if (opts.refineSizing) {
    const harness = fileURLToPath(new URL("../.harness", import.meta.url));
    const res = await refineSizing(runDir, harness, { maxIters: 4, log: logBoth });
    logBoth({ event: "refine_sizing_done", ...res });
  }

  writeText(join(runDir, "logs", "compiler.log.jsonl"), logEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");

  let stableAppDir: string | undefined;
  if (out) {
    // Publish the deliverable to <siteName>/app; keep working artifacts in .clone.
    exportApp(appDir, out.appDir);
    logBoth({ event: "exported", app: out.appDir });
  } else {
    // latest pointer (runs/ layout, used by --reuse / regen) + a `latest` symlink so the
    // app has a stable, timestamp-free path that survives copy-paste.
    stableAppDir = writeLatestPointer(runsDir, siteId, runDir);
  }

  return { runDir, sourceDir, appDir: out ? out.appDir : appDir, sourceUrl: opts.url, stableAppDir, visualAssetsMissing };
}

/** Record the newest run for a site in the runs layout: a `latest.json` breadcrumb (used by
 *  `--reuse`/regen) and a `latest` symlink → runDir. Returns the stable app path when the
 *  symlink was created (symlinks can be unavailable, e.g. Windows without privilege — non-fatal). */
export function writeLatestPointer(runsDir: string, siteId: string, runDir: string): string | undefined {
  writeJSON(join(runsDir, siteId, "latest.json"), { runDir, ts: timestamp() });
  const link = join(runsDir, siteId, "latest");
  try {
    // Refresh an existing symlink; refuse (via non-recursive rm) to clobber a real directory.
    rmSync(link, { force: true });
    symlinkSync(runDir, link, "junction");
    return join(link, "generated", "app");
  } catch {
    return undefined;
  }
}

function copySourceRef(from: string, to: string): void {
  // Symlink-free copy of the whole source dir for self-contained runs.
  if (resolve(from) === resolve(to)) return;
  ensureDir(to);
  cpSync(from, to, { recursive: true });
}

/** Latest prior run's source/ dir for a URL (for --reuse: regenerate, skip capture). */
export function latestSourceDir(runsDir: string, url: string): string | null {
  const siteDir = join(runsDir, siteIdFromUrl(url));
  if (!existsSync(siteDir)) return null;
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const src = join(siteDir, runs[i]!, "source");
    if (fileExists(join(src, "capture", "capture-result.json"))) return src;
  }
  return null;
}

// ---- CLI ----
type ProductMode = "single" | "multi";
type ProductStyling = "tailwind" | "css";
type ProductFramework = AppFramework;

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
}

function firstFlagValue(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const value = flagValue(args, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasAnyFlag(args: string[], names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

function parseProductMode(args: string[]): ProductMode {
  const raw = flagValue(args, "--mode");
  if (!raw) return "single";
  if (raw === "single" || raw === "multi") return raw;
  throw new Error(`invalid --mode=${raw}; expected "single" or "multi"`);
}

function parseProductStyling(args: string[]): ProductStyling {
  const raw = flagValue(args, "--styling");
  if (raw) {
    if (raw === "tailwind" || raw === "css") return raw;
    throw new Error(`invalid --styling=${raw}; expected "tailwind" or "css"`);
  }
  return args.includes("--css") ? "css" : "tailwind";
}

function parseProductFramework(args: string[]): ProductFramework {
  const raw = flagValue(args, "--framework");
  if (raw) {
    if (raw === "next" || raw === "vite") return raw;
    throw new Error(`invalid --framework=${raw}; expected "next" or "vite"`);
  }
  return args.includes("--vite") ? "vite" : "next";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: clone-static <url> [--mode=single|multi] [--styling=tailwind|css] [--framework=next|vite] [--out=<dir>] [--serve] [--open]");
    process.exit(1);
  }
  const mode = parseProductMode(args);
  const styling = parseProductStyling(args);
  const framework = parseProductFramework(args);
  // --serve installs deps + starts the dev server after cloning; --open also launches the browser.
  const open = hasAnyFlag(args, ["--open"]);
  const serve = open || hasAnyFlag(args, ["--serve"]);
  const finish = async (res: { appDir: string; stableAppDir?: string; visualAssetsMissing?: number }) => {
    if (serve) {
      await serveApp(res.appDir, { open });
    } else {
      process.stderr.write(doneSummary({ url, appDir: res.appDir, framework, stableAppDir: res.stableAppDir, visualAssetsMissing: res.visualAssetsMissing }));
    }
  };
  const vpArg = firstFlagValue(args, ["--dev-viewports", "--viewports"]);
  const runsArg = firstFlagValue(args, ["--dev-runs", "--runs"]);
  // --out=<dir>: clean <dir>/<siteName>/{app,.clone} layout (default: ./output when bare --out).
  const outArg = args.find((a) => a === "--out" || a.startsWith("--out="));
  const outDir = outArg ? (outArg.includes("=") ? outArg.split("=")[1] : "output") : undefined;
  const viewports = vpArg ? vpArg.split(",").map((s) => parseInt(s, 10)) : undefined;
  // Best-by-default: interactions (Stage 4) and component extraction (Stage 4.5) are
  // ON unless explicitly disabled. Both are safe — interactions apply nothing on mount
  // and are gate-pruned; extraction is render-identical — so the base clone is unchanged.
  const interactions = !hasAnyFlag(args, ["--dev-no-interactions", "--no-interactions"]);
  const components = !hasAnyFlag(args, ["--dev-no-components", "--no-components"]);
  const motion = !hasAnyFlag(args, ["--dev-no-motion", "--no-motion"]);
  const dense = hasAnyFlag(args, ["--dev-dense", "--dense"]);
  const refineSizingFlag = hasAnyFlag(args, ["--dev-refine-sizing", "--refine-sizing"]);
  // Reflow trade is ON by default (flow all heights → cleaner code; content re-positions between
  // breakpoints, backstopped by the perceptual/layout gates). Pass --no-reflow for sites where it
  // hurts mobile fidelity.
  const reflow = !hasAnyFlag(args, ["--dev-no-reflow", "--no-reflow"]);
  // Screenshots are a validation-only artifact (generation never reads pixels); --no-screenshots skips
  // the per-viewport full-page shots — the dominant capture cost on tall pages — for a faster production clone.
  const screenshots = !hasAnyFlag(args, ["--dev-no-screenshots", "--no-screenshots"]);
  const runsDir = runsArg ? resolve(runsArg) : resolve(process.cwd(), "..", "runs");
  // --reuse: regenerate from the latest existing capture (skip the browser pass).
  const reuseSource = hasAnyFlag(args, ["--dev-reuse", "--reuse"]) ? latestSourceDir(runsDir, url) ?? undefined : undefined;

  if (mode === "multi") {
    const { runCloneSite } = await import("./site/cloneSite.js");
    const maxRoutes = firstFlagValue(args, ["--dev-max-routes", "--max-routes"]);
    const maxCollection = firstFlagValue(args, ["--dev-max-collection", "--max-collection"]);
    const maxDepth = firstFlagValue(args, ["--dev-depth", "--depth"]);
    const concurrency = firstFlagValue(args, ["--dev-concurrency", "--concurrency"]);
    const validationConcurrency = firstFlagValue(args, ["--dev-validate-concurrency", "--validate-concurrency", "--validation-concurrency"]);
    const viewportConcurrency = firstFlagValue(args, ["--dev-viewport-concurrency", "--viewport-concurrency"]);
    const tier = firstFlagValue(args, ["--dev-tier", "--tier"]);
    const validate = hasAnyFlag(args, ["--dev-validate", "--validate"]) && !hasAnyFlag(args, ["--dev-no-validate", "--no-validate"]);
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
      humanizeMode: styling,
      framework,
      reflow,
      screenshots: validate && screenshots,
      outDir,
      tier,
      log: (e) => console.log(JSON.stringify(e)),
    });
    console.log(JSON.stringify({ event: "done", runDir: res.runDir, app: res.appDir, stableApp: res.stableAppDir }));
    await finish(res);
    return;
  }

  const res = await runClone({
    url,
    viewports,
    runsDir,
    interactions,
    components,
    motion,
    dense,
    refineSizing: refineSizingFlag,
    reflow,
    screenshots,
    humanizeMode: styling,
    framework,
    outDir,
    reuseSource,
    log: (e) => console.log(JSON.stringify(e)),
  });
  console.log(JSON.stringify({ event: "done", runDir: res.runDir, app: res.appDir, stableApp: res.stableAppDir }));
  await finish(res);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
