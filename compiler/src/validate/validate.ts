import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { buildIR } from "../normalize/ir.js";
import { detectSections } from "../infer/sections.js";
import { buildAssetGraph } from "../infer/assets.js";
import { buildFontGraph } from "../infer/fonts.js";
import { generateAll } from "../generate/pipeline.js";
import { COMPILER_VERSION } from "../generate/manifest.js";
import { interactionRejectedArtifact } from "../generate/interactive.js";
import { buildApp, serveStatic, renderApp, measureProbeWidths, findRemoteRefs } from "./render.js";
import { driveInteractionGate } from "./interactionGate.js";
import { driveMotionGate, motionExpected } from "./motionGate.js";
import {
  gate1Capture, gate2Assets, gate3Dom, gate4Style, gate5Layout, gateResponsive, gatePollution, type GateResult,
} from "./gates.js";

/** Widths the capture never sampled — the midpoint of every adjacent captured pair (inside each
 *  media band) plus one beyond the widest. The responsive gate renders the clone here to catch
 *  baked-px output that stairsteps between bands or off-centres on a wider monitor. */
export function probeWidthsFor(viewports: number[]): number[] {
  const sorted = [...viewports].sort((a, b) => a - b);
  const mids: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) mids.push(Math.round((sorted[i]! + sorted[i + 1]!) / 2));
  const widest = sorted[sorted.length - 1] ?? 1920;
  return [...mids, Math.round(widest * 4 / 3)];
}
import { buildReport, reportToMarkdown, type Report } from "./report.js";
import { readJSON, writeJSON, writeText, ensureDir, fileExists } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";

const DEFAULT_HARNESS = fileURLToPath(new URL("../../.harness", import.meta.url));

const DETERMINISM_FILES = [
  "manifest.json", "sections.json", "tokens.json", "assets.json", "fonts.json", "components.json", "recipes.json", "recipes.md", "interaction-recipes.json", "interaction-recipes.md", "seo.json", "seo.md", "code-quality.json", "code-quality.md",
  "app/src/app/page.tsx", "app/src/app/ditto.css", "app/src/app/globals.css", "app/src/app/layout.tsx",
  "app/AGENTS.md", "app/ARCHITECTURE.md",
  "app/src/app/content.ts", // Stage 6 — present only when extraction promoted components
  "app/src/app/_cids.ts", // internal data-cid arrays (present only when extraction promoted components)
  "app/src/app/_styles.ts", // internal per-instance class overrides (present only when a component's className varies)
  "app/package.json", "app/next.config.mjs", "app/tsconfig.json",
];

const VITE_DETERMINISM_FILES = [
  "manifest.json", "sections.json", "tokens.json", "assets.json", "fonts.json", "components.json", "recipes.json", "recipes.md", "interaction-recipes.json", "interaction-recipes.md", "seo.json", "seo.md", "code-quality.json", "code-quality.md",
  "app/index.html", "app/vite.config.ts", "app/src/page.tsx", "app/src/main.tsx", "app/src/ditto.css", "app/src/globals.css",
  "app/AGENTS.md", "app/ARCHITECTURE.md",
  "app/src/content.ts",
  "app/src/_cids.ts",
  "app/src/_styles.ts",
  "app/public/robots.txt", "app/public/sitemap.xml", "app/public/llms.txt",
  "app/package.json", "app/tsconfig.json",
];

export async function validateRun(runDir: string, opts?: { harnessDir?: string; tier?: string; log?: (e: Record<string, unknown>) => void }): Promise<Report> {
  const log = opts?.log ?? (() => {});
  const harnessDir = opts?.harnessDir ?? DEFAULT_HARNESS;
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const appDir = join(generatedDir, "app");
  const renderedDir = join(runDir, "rendered");
  const validationDir = join(runDir, "validation");
  ensureDir(validationDir);

  const input = readJSON<{ url: string; viewports: number[]; siteId: string }>(join(runDir, "input.json"));
  const url = input.url;
  // Opt-in reflow trade: the generator flowed geometry that re-positions content (a deliberate
  // fidelity-for-cleanliness trade), so the layout gate uses a wider leaf-position tolerance — the
  // perceptual + size + section-structure + page-height gates remain the strict visual bar.
  const reflowOpt = fileExists(join(sourceDir, "clone-options.json"))
    && !!readJSON<{ reflow?: boolean }>(join(sourceDir, "clone-options.json")).reflow;
  const viewports = input.viewports;
  const origin = new URL(url).origin;
  const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
  const rejPath = join(sourceDir, "interaction-rejected.json");

  // Always validate the current interaction runtime first. Otherwise a stale rejection file can
  // suppress DittoWire during generation, causing the gate to re-reject an interaction that now works.
  generateAll({ sourceDir, capture, viewports, sampleViewports: capture.viewports, url, outDir: generatedDir, ignoreRejectedInteractions: true });

  // Stage 5: match generation — carry @keyframes only when motion was captured, so the
  // motion gate's expectations line up with what the clone actually emitted.
  const ir = buildIR(sourceDir, viewports, { motion: !!capture.motion });
  const sections = detectSections(ir);
  const assetGraph = buildAssetGraph(capture);
  const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, url);

  // ---- Gate 0: build + render ----
  log({ event: "build_start" });
  const build = buildApp(appDir, harnessDir);
  log({ event: "build_done", ok: build.ok, ms: build.durationMs });

  let snapshots: Record<number, import("../capture/walker.js").PageSnapshot> = {};
  let runtimeErrors: string[] = [];
  let httpStatus = 0;
  let failedResources: string[] = [];
  // Stage 4: interaction gate (N/A auto-pass when no interactions were captured).
  let interactionGate: GateResult = { gate: "interaction", pass: true, metrics: { patterns: 0, na: true }, issues: [] };
  // Stage 5: motion gate (N/A auto-pass when no motion was captured/expected).
  let motionGate: GateResult = { gate: "motion", pass: true, metrics: { animations: 0, na: true }, issues: [] };
  // Responsive gate: clone snapshots at widths BETWEEN/BEYOND the captured set.
  let probeSnaps: Record<number, import("../capture/walker.js").PageSnapshot> = {};
  if (build.ok && build.outDir) {
    const server = await serveStatic(build.outDir);
    try {
      const r = await renderApp({ url: server.url + "/", viewports, renderedDir });
      snapshots = r.snapshots; runtimeErrors = r.runtimeErrors; httpStatus = r.httpStatus; failedResources = r.failedResources;
      probeSnaps = await measureProbeWidths({ url: server.url + "/", widths: probeWidthsFor(viewports) });
      if (capture.interaction) {
        interactionGate = await driveInteractionGate({ url: server.url + "/", viewports, ir, interaction: capture.interaction });
        log({ event: "interaction_gate", pass: interactionGate.pass, metrics: interactionGate.metrics });
        // Feed the gate's verdict back: patterns that didn't reproduce are recorded so
        // generation leaves them static (rather than shipping a broken interaction).
        const rejected = (interactionGate.metrics.rejected as string[] | undefined) ?? [];
        if (rejected.length) writeJSON(rejPath, interactionRejectedArtifact(rejected));
        else rmSync(rejPath, { force: true });
      }
      if (capture.motion && motionExpected(ir, capture.motion)) {
        motionGate = await driveMotionGate({ url: server.url + "/", viewports, ir, motion: capture.motion });
        log({ event: "motion_gate", pass: motionGate.pass, metrics: motionGate.metrics });
      }
    } catch (e) {
      // A render crash (e.g. a page.goto timeout on trickling media, or a Playwright fault)
      // must NOT escape reportless — otherwise validation/ stays empty and the run looks
      // un-validated. Record the error as a runtime error so httpStatus stays 0, gate 0 fails
      // with a visible issue, and the normal downstream path writes report.json as usual.
      runtimeErrors.push(`render error: ${e instanceof Error ? e.message : String(e)}`);
      log({ event: "render_error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      await server.close();
    }
  }
  // Video/audio elements stream and their requests are aborted ("failed") when the
  // render snapshot is taken before the stream finishes — the file is materialized,
  // so this is not an asset failure. Only count non-streaming assets.
  const assetFailed = failedResources.filter(
    (f) => f.includes("/assets/") && !/\.(mp4|webm|mov|m4v|ogv|ogg|mp3|wav|m3u8)(\?|$)/i.test(f),
  );
  const artifactsPresent = ["manifest.json", "sections.json", "tokens.json", "assets.json", "fonts.json"].every((f) => fileExists(join(generatedDir, f)));
  const gate0Issues: string[] = [];
  if (!build.ok) gate0Issues.push("build failed: " + build.stderr.split("\n").filter(Boolean).slice(-3).join(" | "));
  if (httpStatus !== 200) gate0Issues.push(`http status ${httpStatus}`);
  if (runtimeErrors.length) gate0Issues.push(`${runtimeErrors.length} runtime errors`);
  if (!artifactsPresent) gate0Issues.push("missing required artifacts");
  // De-duplicate runtime errors and keep a sample so the report is debuggable.
  const uniqueErrors = [...new Set(runtimeErrors)].slice(0, 5);
  const gate0: GateResult = {
    gate: "build",
    pass: build.ok && httpStatus === 200 && runtimeErrors.length === 0 && artifactsPresent,
    metrics: { buildOk: build.ok, http200: httpStatus === 200, noRuntimeErrors: runtimeErrors.length === 0, artifactsPresent, buildMs: build.durationMs, runtimeErrorSample: uniqueErrors },
    issues: gate0Issues,
  };

  // ---- Gate 1: capture completeness ----
  const screenshots: Record<number, boolean> = {};
  for (const vp of viewports) screenshots[vp] = fileExists(join(sourceDir, "screenshots", `${vp}.png`));
  const gate1 = gate1Capture(ir, viewports, {
    screenshots,
    assetsPresent: fileExists(join(sourceDir, "assets-discovered.json")),
    fontsPresent: fileExists(join(sourceDir, "fonts-discovered.json")),
  });

  // ---- Gate 2: asset/font ----
  const remoteRefs = findRemoteRefs(snapshots);
  const gate2 = gate2Assets(assetGraph, fontGraph, { remoteRefs, failed404: assetFailed });

  // ---- Gates 3,4,5 ----
  const gate3 = gate3Dom(ir, snapshots, viewports, origin);
  const gate4 = gate4Style(ir, snapshots, viewports);
  const gate5 = gate5Layout(ir, snapshots, sections, viewports, reflowOpt);

  // ---- Gate 6: determinism ----
  const gate6 = checkDeterminism(sourceDir, capture, viewports, url);

  // ---- Stage 2 gates: pollution + perceptual ----
  const pollution = gatePollution(ir, capture, viewports);
  const perceptual = screenshotDiff(sourceDir, renderedDir, viewports, validationDir, opts?.tier);

  // ---- Responsive gate: fluidity/centering at non-captured widths (diagnostic; not in 0–6) ----
  const responsive = gateResponsive(ir, probeSnaps, viewports);

  const gates: Record<string, GateResult> = {
    build: gate0, capture: gate1, asset_font: gate2, dom: gate3, style: gate4,
    layout: gate5, determinism: gate6, pollution, perceptual, responsive, interaction: interactionGate, motion: motionGate,
  };

  const report = buildReport({ sourceUrl: url, tier: opts?.tier ?? "unknown", compilerVersion: COMPILER_VERSION, gates });
  writeJSON(join(validationDir, "report.json"), report);
  writeText(join(validationDir, "report.md"), reportToMarkdown(report));
  if (build.stderr && !build.ok) writeText(join(runDir, "logs", "build.log"), build.stderr);
  log({ event: "validated", status: report.status, score: report.scorecard.total, gates0to6: report.gates0to6Pass });

  // Prune: if the interaction gate rejected any patterns, regenerate the deliverable
  // app with them excluded (left static) — so the shipped clone never reproduces an
  // interaction that the gate proved doesn't work. Base DOM/CSS is unchanged (only
  // DittoWire wiring drops), so the graded gates still hold.
  const rejectedN = ((interactionGate.metrics.rejected as string[] | undefined) ?? []).length;
  if (rejectedN) {
    generateAll({ sourceDir, capture, viewports, sampleViewports: capture.viewports, url, outDir: generatedDir });
    log({ event: "interaction_pruned", patterns: rejectedN });
  }

  return report;
}

function checkDeterminism(sourceDir: string, capture: CaptureResult, viewports: number[], url: string): GateResult {
  const a = mkdtempSync(join(tmpdir(), "det-a-"));
  const b = mkdtempSync(join(tmpdir(), "det-b-"));
  const issues: string[] = [];
  const cloneOpts = fileExists(join(sourceDir, "clone-options.json"))
    ? readJSON<{ framework?: "next" | "vite" }>(join(sourceDir, "clone-options.json"))
    : {};
  const files = cloneOpts.framework === "vite" ? VITE_DETERMINISM_FILES : DETERMINISM_FILES;
  try {
    generateAll({ sourceDir, capture, viewports, sampleViewports: capture.viewports, url, outDir: join(a, "generated"), ignoreRejectedInteractions: true });
    generateAll({ sourceDir, capture, viewports, sampleViewports: capture.viewports, url, outDir: join(b, "generated"), ignoreRejectedInteractions: true });
    for (const f of files) {
      const pa = join(a, "generated", f), pb = join(b, "generated", f);
      const ea = existsSync(pa), eb = existsSync(pb);
      if (!ea && !eb) continue; // optional file (e.g. content.ts) not generated by either run
      if (ea !== eb) { issues.push(`nondeterministic presence: ${f}`); continue; }
      if (readFileSync(pa, "utf8") !== readFileSync(pb, "utf8")) issues.push(`differs: ${f}`);
    }
  } catch (e) {
    issues.push("determinism run error: " + String(e));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
  return { gate: "determinism", pass: issues.length === 0, metrics: { filesCompared: files.length, mismatches: issues.length }, issues };
}

function readPng(path: string): PNG | null {
  try { return PNG.sync.read(readFileSync(path)); } catch { return null; }
}

// Perceptual pass threshold (fraction of differing pixels at the worst viewport).
// Heavier tiers carry more legitimately-irreproducible pixels — hero photography,
// gradients, residual animation/video frames — so the bar loosens with difficulty.
export const PERCEPTUAL_THRESHOLD: Record<string, number> = { easy: 0.1, medium: 0.12, hard: 0.14, stage2: 0.16 };

export function screenshotDiff(sourceDir: string, renderedDir: string, viewports: number[], validationDir: string, tier?: string): GateResult {
  const perVp: Record<number, number> = {};
  const issues: string[] = [];
  let worst = 0;
  for (const vp of viewports) {
    const srcPng = readPng(join(sourceDir, "screenshots", `${vp}.png`));
    const genPng = readPng(join(renderedDir, "screenshots", `${vp}.png`));
    if (!srcPng || !genPng) { perVp[vp] = 1; worst = 1; issues.push(`vp${vp} missing screenshot`); continue; }
    const w = Math.min(srcPng.width, genPng.width);
    const h = Math.min(srcPng.height, genPng.height);
    const a = cropTo(srcPng, w, h);
    const b = cropTo(genPng, w, h);
    const diff = new PNG({ width: w, height: h });
    const diffPx = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
    const ratio = diffPx / (w * h);
    perVp[vp] = Math.round(ratio * 10000) / 10000;
    worst = Math.max(worst, ratio);
    // include height mismatch penalty signal
    if (Math.abs(srcPng.height - genPng.height) / Math.max(srcPng.height, 1) > 0.05) {
      issues.push(`vp${vp} screenshot height mismatch ${srcPng.height} vs ${genPng.height}`);
    }
  }
  const threshold = PERCEPTUAL_THRESHOLD[tier ?? "hard"] ?? 0.14;
  const worstPct = Math.round(worst * 10000) / 10000;
  if (worstPct > threshold) issues.push(`worst viewport diff ${(worstPct * 100).toFixed(1)}% (> ${(threshold * 100).toFixed(0)}%)`);
  return { gate: "perceptual", pass: worst <= threshold, metrics: { perViewport: perVp, worstDiffPct: worstPct, threshold }, issues };
}

function cropTo(png: PNG, w: number, h: number): PNG {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (png.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = png.data[si]!; out.data[di + 1] = png.data[si + 1]!;
      out.data[di + 2] = png.data[si + 2]!; out.data[di + 3] = png.data[si + 3]!;
    }
  }
  return out;
}
