/**
 * Source-vs-clone Tailwind diff for the cloner (Stage 4/5 instrument).
 *
 * For a Tailwind-built source, the live `class` attribute is the AUTHORED fluid intent —
 * the exact utility our generator should have inferred. This tool rebuilds the IR (which now carries
 * the source `class` as `srcClass`) and our emitted classes (`buildTailwind().classOf`) IN-PROCESS,
 * both keyed by node id, so the per-node diff is perfectly aligned with zero live-probe flakiness.
 *
 * It then NORMALIZES away faithful, unavoidable differences (colors, design-system spacing tokens,
 * data-*, no-preflight arbitrary transforms) and focuses the diff on the LAYOUT/SIZING utility
 * families — where the class name itself is the signal — to surface the real misses: places we baked
 * per-viewport px where the source expressed ONE fluid rule. Misses are clustered by axis + source
 * utility and ranked by frequency, so one law fixes many nodes.
 *
 *   npx tsx scripts/tw-diff.ts [runDir=output/sample/.clone] [--axis=width] [--samples=N] [--json=path]
 *
 * Run from compiler/.
 */
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { buildIR, isTextChild, type IR, type IRNode } from "../src/normalize/ir.js";
import { buildTailwind } from "../src/generate/tailwind.js";
import { buildColorPalette } from "../src/infer/semanticTokens.js";
import { buildAssetGraph, type AssetGraph } from "../src/infer/assets.js";
import { readJSON } from "../src/util/fsx.js";
import type { CaptureResult } from "../src/capture/capture.js";

function buildAssetMap(assetGraph: AssetGraph): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of assetGraph.entries) {
    if (e.classification === "downloaded" && e.localPath && e.type !== "css") m.set(e.sourceUrl, e.localPath);
  }
  return m;
}

// ---- token parsing -------------------------------------------------------

type Tok = { raw: string; variant: string; core: string };

/** Split a className string into tokens, separating the responsive/state variant prefix
 *  (`md:`, `lg:`, `max-md:`, `hover:`, `2xl:` …) from the core utility. Arbitrary values can
 *  themselves contain `:` inside `[...]`, so only split on `:` that are OUTSIDE brackets. */
function parseClass(cls: string): Tok[] {
  const out: Tok[] = [];
  for (const raw of cls.split(/\s+/).filter(Boolean)) {
    // find the last variant-colon that's outside brackets/parens
    let depth = 0, lastColon = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      else if (ch === ":" && depth === 0) lastColon = i;
    }
    const variant = lastColon >= 0 ? raw.slice(0, lastColon) : "";
    const core = lastColon >= 0 ? raw.slice(lastColon + 1) : raw;
    out.push({ raw, variant, core });
  }
  return out;
}

// ---- sizing-axis classification -----------------------------------------

type Axis = "width" | "height" | "grid-cols" | "grid-rows" | "flex" | "aspect" | "line-clamp";

/** Does an arbitrary value `[…]` (already unwrapped) denote a BAKED fixed length (px/rem)? */
function isBakedLen(v: string): boolean {
  return /^-?[\d.]+(px|rem|em)$/.test(v);
}
/** Does an arbitrary value denote a FLUID length (%, vw/vh, fr, auto/min/max-content, calc with %/vw)? */
function isFluidLen(v: string): boolean {
  if (/^-?[\d.]+(%|vw|vh|svh|lvh|dvh|svw|lvw|dvw|fr)$/.test(v)) return true;
  if (/^(auto|min-content|max-content|fit-content|stretch)$/.test(v)) return true;
  if (/(%|vw|vh|fr|min-content|max-content|fit-content)/.test(v) && /^(calc|min|max|clamp|repeat|fit-content)\(/.test(v)) return true;
  return false;
}

/** Spacing-scale numbers (`w-24`, `h-2.5`, `w-93`) are FIXED px. Fractions (`w-1/2`) are fluid. */
function spacingIsFixed(rest: string): boolean {
  return /^-?[\d.]+$/.test(rest); // pure number → fixed scale step; a fraction has a '/'
}

type AxisVerdict = { fluid?: string; baked?: string };

/** Classify a single core utility onto an axis with a fluid|baked verdict.
 *  Returns null for utilities that are not on a sizing axis. */
function classify(core: string): { axis: Axis; v: AxisVerdict } | null {
  // grid templates
  let m = core.match(/^grid-(cols|rows)-(.+)$/);
  if (m) {
    const axis: Axis = m[1] === "cols" ? "grid-cols" : "grid-rows";
    const val = m[2]!;
    if (/^\d+$/.test(val)) return { axis, v: { fluid: `grid-${m[1]}-N` } };       // fixed-count fluid grid
    if (val === "none" || val === "subgrid") return { axis, v: { fluid: val } };
    if (val.startsWith("[")) {
      const inner = val.slice(1, -1);
      // baked iff it contains an explicit px/rem track and NO fr/%/min/max/auto
      const hasFixed = /[\d.]+(px|rem)/.test(inner);
      const hasFluid = /(fr|%|min-content|max-content|auto|minmax|repeat)/.test(inner);
      if (hasFixed && !hasFluid) return { axis, v: { baked: `grid-${m[1]}-[px]` } };
      if (hasFixed && hasFluid) return { axis, v: { baked: `grid-${m[1]}-[mixed-px]` } }; // partly baked
      return { axis, v: { fluid: `grid-${m[1]}-[fr]` } };
    }
    return { axis, v: { fluid: `grid-${m[1]}-${val}` } };
  }
  // aspect-ratio
  m = core.match(/^aspect-(.+)$/);
  if (m) {
    const val = m[1]!;
    if (val === "square" || val === "video" || val === "auto") return { axis: "aspect", v: { fluid: `aspect-${val}` } };
    if (val.startsWith("[")) {
      const inner = val.slice(1, -1);
      // clean ratio like [16/9] is fluid intent; [auto_42_/_42] baked-from-px
      if (/^\d+\s*\/\s*\d+$/.test(inner.replace(/_/g, " "))) return { axis: "aspect", v: { fluid: "aspect-[ratio]" } };
      return { axis: "aspect", v: { baked: "aspect-[baked]" } };
    }
    return { axis: "aspect", v: { fluid: `aspect-${val}` } };
  }
  // line-clamp
  m = core.match(/^line-clamp-(.+)$/);
  if (m) return { axis: "line-clamp", v: { fluid: /^\d+$/.test(m[1]!) ? "line-clamp-N" : `line-clamp-${m[1]}` } };
  // flex shorthand / grow / shrink / basis (all width-flow on the main axis)
  if (/^(flex-1|flex-auto|flex-initial|grow|grow-0|shrink|shrink-0)$/.test(core)) return { axis: "flex", v: { fluid: core } };
  m = core.match(/^basis-(.+)$/);
  if (m) {
    const val = m[1]!;
    if (val === "full" || val === "auto" || /\d+\/\d+/.test(val)) return { axis: "flex", v: { fluid: `basis-${val.includes("/") ? "frac" : val}` } };
    if (val.startsWith("[")) { const inner = val.slice(1, -1); return isBakedLen(inner) ? { axis: "flex", v: { baked: "basis-[px]" } } : { axis: "flex", v: { fluid: "basis-[fluid]" } }; }
    return { axis: "flex", v: { baked: "basis-px" } }; // basis-24 etc
  }
  // width / height (incl. min-/max-)
  m = core.match(/^(min-|max-)?([wh])-(.+)$/);
  if (m) {
    const axis: Axis = m[2] === "w" ? "width" : "height";
    const val = m[3]!;
    const fam = `${m[1] ?? ""}${m[2]}`; // w, min-w, max-w, h, …
    if (/^(full|screen|auto|fit|min|max|svh|lvh|dvh|svw|lvw|dvw|prose)$/.test(val)) return { axis, v: { fluid: `${fam}-${val}` } };
    if (/^\d+\/\d+$/.test(val)) return { axis, v: { fluid: `${fam}-frac` } };          // w-1/2
    if (/^(screen-|3xl|2xl|xl|lg|md|sm|xs|7xl|6xl|5xl|4xl)/.test(val) && fam === "max-w") return { axis, v: { fluid: `max-w-${val}` } }; // named cap
    if (val.startsWith("[")) {
      const inner = val.slice(1, -1);
      if (inner.startsWith("var(")) return { axis, v: { fluid: `${fam}-[var]` } };       // token-driven → fluid-ish
      if (isFluidLen(inner)) return { axis, v: { fluid: `${fam}-[fluid]` } };
      if (isBakedLen(inner)) return { axis, v: { baked: `${fam}-[px]` } };
      return { axis, v: {} };
    }
    if (spacingIsFixed(val)) return { axis, v: { baked: `${fam}-num` } };               // w-24, h-93 → fixed scale
    return { axis, v: {} };
  }
  return null;
}

type NodeAxisInfo = Record<Axis, { srcFluid: Set<string>; srcBaked: Set<string>; cloFluid: Set<string>; cloBaked: Set<string> }>;

function emptyAxisInfo(): NodeAxisInfo {
  const mk = () => ({ srcFluid: new Set<string>(), srcBaked: new Set<string>(), cloFluid: new Set<string>(), cloBaked: new Set<string>() });
  return { width: mk(), height: mk(), "grid-cols": mk(), "grid-rows": mk(), flex: mk(), aspect: mk(), "line-clamp": mk() };
}

function collectAxis(cls: string, info: NodeAxisInfo, side: "src" | "clo"): void {
  for (const t of parseClass(cls)) {
    const c = classify(t.core);
    if (!c) continue;
    const bucket = info[c.axis];
    if (c.v.fluid) (side === "src" ? bucket.srcFluid : bucket.cloFluid).add(c.v.fluid);
    if (c.v.baked) (side === "src" ? bucket.srcBaked : bucket.cloBaked).add(c.v.baked);
  }
}

// ---- main ----------------------------------------------------------------

const argv = process.argv.slice(2);
const runDir = resolve(argv.find((a) => !a.startsWith("--")) ?? "output/sample/.clone");
const axisFilter = (argv.find((a) => a.startsWith("--axis="))?.split("=")[1] ?? "") as Axis | "";
const sampleN = parseInt(argv.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? "20", 10);
const jsonOut = argv.find((a) => a.startsWith("--json="))?.split("=")[1];

const inspectIds = (argv.find((a) => a.startsWith("--ids="))?.split("=")[1] ?? "").split(",").filter(Boolean);

const sourceDir = join(runDir, "source");
const input = readJSON<{ url: string; viewports: number[] }>(join(runDir, "input.json"));
const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
const cloneOpts = readJSON<{ reflow?: boolean }>(join(sourceDir, "clone-options.json"));

const ir: IR = buildIR(sourceDir, capture.viewports, { motion: !!capture.motion, bandViewports: input.viewports });
const assetGraph = buildAssetGraph(capture);
const palette = buildColorPalette(ir);
const tw = buildTailwind(ir, buildAssetMap(assetGraph), palette.varForColor, { interaction: capture.interaction, reflow: !!cloneOpts.reflow });
const classOf = tw.classOf;

// --ids inspect mode: dump src/clone class + per-vp height geometry for specific nodes, then exit.
if (inspectIds.length) {
  const idx = new Map<string, IRNode>();
  const idxWalk = (n: IRNode): void => { idx.set(n.id, n); for (const c of n.children) if (!isTextChild(c)) idxWalk(c); };
  idxWalk(ir.root);
  for (const id of inspectIds) {
    const n = idx.get(id);
    if (!n) { console.log(`${id}: NOT FOUND`); continue; }
    const vps = ir.doc.sampleViewports;
    console.log(`\n${id} <${n.tag}>`);
    console.log(`  src:   ${n.srcClass ?? "(none)"}`);
    console.log(`  clone: ${classOf.get(id) ?? "(none)"}`);
    console.log(`  bboxH: ${vps.map((vp) => n.bboxByVp[vp]?.height ?? "·").join("/")}`);
  }
  process.exit(0);
}

// Per-axis miss tally + per (axis, srcUtil) cluster + sample rows.
type MissRow = { id: string; tag: string; text: string; axis: Axis; srcUtil: string; cloBaked: string; source: string; clone: string };
const misses: MissRow[] = [];
const clusterCount = new Map<string, number>();         // "axis · srcUtil" → count
const axisMiss = new Map<Axis, number>();
let nNodes = 0, nSrc = 0, nClone = 0, nBoth = 0;

function textOf(n: IRNode): string {
  for (const c of n.children) if (isTextChild(c) && c.text.trim()) return c.text.trim().slice(0, 40);
  return "";
}

function walk(n: IRNode): void {
  nNodes++;
  const src = n.srcClass ?? "";
  const clo = classOf.get(n.id) ?? "";
  if (src) nSrc++;
  if (clo) nClone++;
  if (src && clo) {
    nBoth++;
    const info = emptyAxisInfo();
    collectAxis(src, info, "src");
    collectAxis(clo, info, "clo");
    for (const axis of Object.keys(info) as Axis[]) {
      const b = info[axis];
      // MISS = source expressed a fluid rule on this axis, clone baked px (or token absent) and
      // produced NO fluid utility of its own on that axis.
      const cloneHasFluid = b.cloFluid.size > 0;
      if (b.srcFluid.size > 0 && !cloneHasFluid && (b.cloBaked.size > 0 || (b.srcBaked.size === 0 && axisExpectedInClone(axis, clo)))) {
        const srcUtil = [...b.srcFluid].sort().join("+");
        const cloBaked = [...b.cloBaked].sort().join("+") || "(absent)";
        misses.push({ id: n.id, tag: n.tag, text: textOf(n), axis, srcUtil, cloBaked, source: src, clone: clo });
        const key = `${axis} · ${srcUtil}`;
        clusterCount.set(key, (clusterCount.get(key) ?? 0) + 1);
        axisMiss.set(axis, (axisMiss.get(axis) ?? 0) + 1);
      }
    }
  }
  for (const c of n.children) if (!isTextChild(c)) walk(c);
}

/** For line-clamp/aspect a missing clone utility is itself the miss; for width/height/grid we only
 *  count a miss when the clone actually baked something (handled by cloBaked.size>0). */
function axisExpectedInClone(axis: Axis, _clone: string): boolean {
  return axis === "line-clamp" || axis === "aspect";
}

walk(ir.root);

// ---- report --------------------------------------------------------------

console.log(`\n=== tw-diff: ${runDir} ===`);
console.log(`nodes=${nNodes}  withSrcClass=${nSrc}  withCloneClass=${nClone}  both=${nBoth}`);
console.log(`\n--- real misses by axis (source fluid, clone baked/absent) ---`);
const totalMiss = misses.length;
for (const [axis, n] of [...axisMiss.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${axis.padEnd(11)} ${n}`);
}
console.log(`  ${"TOTAL".padEnd(11)} ${totalMiss}`);

console.log(`\n--- top miss clusters (axis · source-util → count) ---`);
for (const [key, n] of [...clusterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)}  ${key}`);
}

const shown = axisFilter ? misses.filter((m) => m.axis === axisFilter) : misses;
console.log(`\n--- sample miss rows${axisFilter ? ` [axis=${axisFilter}]` : ""} (${Math.min(sampleN, shown.length)} of ${shown.length}) ---`);
for (const m of shown.slice(0, sampleN)) {
  console.log(`\n  ${m.id} <${m.tag}> ${m.text ? `“${m.text}”` : ""}  [${m.axis}: src ${m.srcUtil} → clone ${m.cloBaked}]`);
  console.log(`    src:   ${m.source}`);
  console.log(`    clone: ${m.clone}`);
}

if (jsonOut) {
  writeFileSync(resolve(jsonOut), JSON.stringify({ stats: { nNodes, nSrc, nClone, nBoth, totalMiss }, axisMiss: Object.fromEntries(axisMiss), clusters: Object.fromEntries([...clusterCount.entries()].sort((a, b) => b[1] - a[1])), misses }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
