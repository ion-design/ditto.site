import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild, irContentExtent } from "../normalize/ir.js";
import type { PageSnapshot } from "../capture/walker.js";
import type { GenNode } from "./render.js";
import { indexByCid } from "./render.js";
import type { AssetGraph } from "../infer/assets.js";
import type { FontGraph } from "../infer/fonts.js";
import type { Section } from "../infer/sections.js";
import type { CaptureResult } from "../capture/capture.js";

export type GateResult = {
  gate: string;
  pass: boolean;
  metrics: Record<string, unknown>;
  issues: string[];
};

// ---------- helpers ----------
function normText(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function pxNum(v: string | undefined): number {
  if (!v) return NaN;
  // include an optional exponent so saturating values like `rounded-full`'s 3.35544e+07px parse
  // as the full magnitude (not just the mantissa 3.35) — pill-radius equivalence depends on it.
  const m = /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(v);
  return m ? parseFloat(m[1]!) : NaN;
}
function withinAbs(a: number, b: number, tol: number): boolean { return Math.abs(a - b) <= tol; }
function withinPct(a: number, b: number, pct: number): boolean {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? true : Math.abs(a - b) / m <= pct;
}
function normColor(v: string | undefined): string { return (v ?? "").replace(/\s+/g, ""); }
function parseRgb(v: string | undefined): [number, number, number, number] | null {
  const m = (v ?? "").match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1]!.split(/[,\/]/).map((s) => parseFloat(s.trim()));
  if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
  return [p[0]!, p[1]!, p[2]!, p.length >= 4 && !Number.isNaN(p[3]!) ? p[3]! : 1];
}
/** Colors are equivalent within a small per-channel tolerance: re-emitting a
 *  computed color (often defined in oklch/wide-gamut on modern SaaS sites) can
 *  round ±1 per channel. Imperceptible, but a real color difference still fails. */
function colorsClose(a: string | undefined, b: string | undefined): boolean {
  const ca = parseRgb(a), cb = parseRgb(b);
  if (!ca || !cb) return normColor(a) === normColor(b);
  return Math.abs(ca[0] - cb[0]) <= 2 && Math.abs(ca[1] - cb[1]) <= 2 &&
         Math.abs(ca[2] - cb[2]) <= 2 && Math.abs(ca[3] - cb[3]) <= 0.04;
}
function normFontFamily(v: string | undefined): string {
  // Compare effective font stacks: drop quotes/case/whitespace, then dedup tokens
  // preserving order. Sites that build font-family from CSS variables often emit
  // the fallback list twice (e.g. `mono, …, monospace, mono, …, monospace`); the
  // clone resolves it once. Both name the same fonts in the same priority order,
  // so they are equivalent — a real primary-font difference is still caught.
  const toks = (v ?? "").replace(/['"]/g, "").replace(/\s+/g, " ").toLowerCase()
    .split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out.join(",");
}

type SrcNode = { node: IRNode; computed: Record<string, string>; bbox: { x: number; y: number; width: number; height: number }; visible: boolean; directText: string };

function collectSrcNodes(ir: IR, vp: number): SrcNode[] {
  const out: SrcNode[] = [];
  const walk = (node: IRNode): void => {
    const computed = node.computedByVp[vp];
    const bbox = node.bboxByVp[vp];
    if (computed && bbox) {
      let directText = "";
      for (const c of node.children) if (isTextChild(c)) directText += c.text;
      out.push({ node, computed, bbox, visible: !!node.visibleByVp[vp], directText });
    }
    for (const c of node.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return out;
}

function hasVisibleElementChild(node: IRNode, vp: number): boolean {
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    if (c.visibleByVp[vp]) return true;
  }
  return false;
}

// ---------- Pollution gate (stage 2): is the captured page degenerate? ----------
// A clone can pass every structural gate while faithfully reproducing the WRONG
// page: an egress/bot wall, a near-empty shell, or a cookie/consent modal that was
// never dismissed (the clone then reproduces the modal, so the perceptual gate is
// fooled too). This gate flags those captures so a "perfect" score can't hide them.
const WALL_RE = /blocked by egress|access denied|access to this page has been denied|are you a (human|robot)|verify you are human|enable javascript to|please enable javascript|checking your browser|just a moment|attention required|request blocked|why have i been blocked|captcha|cf-browser-verification|ddos protection by/i;

export function gatePollution(ir: IR, capture: CaptureResult, viewports: number[]): GateResult {
  const issues: string[] = [];
  const nodeCount = ir.doc.nodeCount;

  // Collect all visible source text once.
  let textChars = 0;
  const textParts: string[] = [];
  const walk = (node: IRNode): void => {
    const anyVisible = Object.values(node.visibleByVp).some(Boolean);
    for (const c of node.children) {
      if (isTextChild(c)) { if (anyVisible) { const t = normText(c.text); if (t) { textParts.push(t); textChars += t.length; } } }
      else walk(c);
    }
  };
  walk(ir.root);
  const allText = textParts.join(" ");
  const wall = WALL_RE.test(allText);

  // Overlay remaining after dismissal (max across viewports), and shortest page.
  // `blocking` = a full-viewport overlay that STILL scroll-locks the page (a modal
  // we could not clear); mere overlay presence (a legit fixed hero/app banner) is
  // tracked but not failed, to avoid false positives on real fixed content.
  let overlaysRemaining = 0;
  let blocking = capture.dismissal?.blocking ?? false;
  for (const pv of capture.perViewport) { overlaysRemaining = Math.max(overlaysRemaining, pv.overlaysRemaining ?? 0); blocking = blocking || !!pv.blocking; }
  let minHeightRatio = Infinity;
  let maxHeightRatio = 0;
  for (const pv of capture.perViewport) {
    if (pv.height > 0) {
      const ratio = pv.scrollHeight / pv.height;
      minHeightRatio = Math.min(minHeightRatio, ratio);
      maxHeightRatio = Math.max(maxHeightRatio, ratio);
    }
  }
  if (!Number.isFinite(minHeightRatio)) minHeightRatio = 1;

  // Scroll-locked-capture contradiction: an email-capture/promo popup that sets
  // body{overflow:hidden;height:100vh} collapses `document.scrollHeight` to EXACTLY the viewport
  // height at EVERY width (ratio ~1.0 across the board) — yet the real page's IN-FLOW content
  // (the IR's sections) still lays out several viewports tall. A genuine one-screen landing page
  // has content extent ~= its scrollHeight, so this only fires when the two disagree: captured
  // scrollHeight pinned to one viewport WHILE the IR content spans multiple. That is a
  // scroll-locked, polluted capture — the overlay detector should have caught it, so fail loudly.
  let maxContentRatio = 0;
  for (const pv of capture.perViewport) {
    if (pv.height > 0) maxContentRatio = Math.max(maxContentRatio, irContentExtent(ir.root, pv.viewport) / pv.height);
  }
  // scrollHeight never exceeds ~1 viewport at any width, but the IR content is 2+ viewports tall.
  const scrollLockedContradiction = maxHeightRatio > 0 && maxHeightRatio < 1.15 && maxContentRatio >= 2;

  // Degenerate signals. Calibrated against real captures: an egress/bot wall is
  // ~3 nodes / ~24 chars; the most minimal legitimate page in the suite
  // (michaelcole.me) is 26 nodes / 640 chars. Thresholds sit safely between.
  if (nodeCount < 12) issues.push(`degenerate DOM: only ${nodeCount} nodes`);
  if (wall && nodeCount < 220) issues.push("bot/egress wall text on a small page");
  if (textChars < 60 && nodeCount < 50) issues.push(`near-empty page: ${textChars} visible text chars, ${nodeCount} nodes`);
  if (blocking) issues.push("a full-viewport modal still scroll-locks the page after dismissal");
  if (scrollLockedContradiction) issues.push(`scroll-locked capture: scrollHeight pinned to ~1 viewport at every width while IR content spans ${round2(maxContentRatio)} viewports`);

  return {
    gate: "pollution",
    pass: issues.length === 0,
    metrics: {
      nodeCount, visibleTextChars: textChars, wallTextDetected: wall,
      overlaysRemaining, blocking, minScrollHeightRatio: round2(minHeightRatio),
      maxScrollHeightRatio: round2(maxHeightRatio), maxContentExtentRatio: round2(maxContentRatio),
      dismissedCount: capture.dismissal?.dismissed.length ?? 0,
      overlaysRemoved: capture.dismissal?.removed ?? 0,
      videoStills: capture.dismissal?.videoStills ?? 0,
    },
    issues,
  };
}

// ---------- Gate 1: capture completeness ----------
export function gate1Capture(ir: IR, viewports: number[], artifacts: { screenshots: Record<number, boolean>; assetsPresent: boolean; fontsPresent: boolean }): GateResult {
  const issues: string[] = [];
  let rootOk = ir.root && ir.root.tag === "body";
  for (const vp of viewports) {
    if (!ir.doc.perViewport[vp]) issues.push(`missing perViewport ${vp}`);
    if (!artifacts.screenshots[vp]) issues.push(`missing screenshot ${vp}`);
    if (!((ir.doc.perViewport[vp]?.scrollHeight ?? 0) > 0)) issues.push(`no scrollHeight ${vp}`);
  }
  if (!rootOk) issues.push("no visible DOM root");
  if (!artifacts.assetsPresent) issues.push("assets-discovered missing");
  if (!artifacts.fontsPresent) issues.push("fonts-discovered missing");
  return { gate: "capture", pass: issues.length === 0, metrics: { viewports }, issues };
}

// ---------- Gate 2: asset/font equivalence ----------
export function gate2Assets(assetGraph: AssetGraph, fontGraph: FontGraph, gen: { remoteRefs: string[]; failed404: string[] }): GateResult {
  const issues: string[] = [];
  let unclassified = 0, zeroByte = 0, skippedNoReason = 0;
  for (const e of assetGraph.entries) {
    if (e.type === "css") continue;
    if (e.classification !== "downloaded" && e.classification !== "skipped") unclassified++;
    if (e.classification === "downloaded" && e.bytes <= 0) zeroByte++;
    if (e.classification === "skipped" && !e.reason) skippedNoReason++;
  }
  if (unclassified > 0) issues.push(`${unclassified} unclassified assets`);
  if (zeroByte > 0) issues.push(`${zeroByte} zero-byte downloaded assets`);
  if (skippedNoReason > 0) issues.push(`${skippedNoReason} skipped assets without reason`);
  if (gen.remoteRefs.length > 0) issues.push(`${gen.remoteRefs.length} generated refs point to remote origin`);
  if (gen.failed404.length > 0) issues.push(`${gen.failed404.length} generated asset refs 404`);
  const fontsResolvedOrFallback = fontGraph.entries.every((f) => f.status === "resolved" || (f.status === "fallback" && f.reason));
  if (!fontsResolvedOrFallback) issues.push("font declarations not resolved/fallback-recorded");
  return {
    gate: "asset_font",
    pass: issues.length === 0,
    metrics: {
      total: assetGraph.entries.filter((e) => e.type !== "css").length,
      downloaded: assetGraph.entries.filter((e) => e.classification === "downloaded" && e.type !== "css").length,
      skipped: assetGraph.entries.filter((e) => e.classification === "skipped" && e.type !== "css").length,
      remoteRefs: gen.remoteRefs.length, failed404: gen.failed404.length,
      failed404Sample: [...new Set(gen.failed404)].slice(0, 6),
      fonts: fontGraph.entries.length,
    },
    issues,
  };
}

// ---------- Gate 3: rendered DOM equivalence ----------
export function gate3Dom(ir: IR, genSnaps: Record<number, PageSnapshot>, viewports: number[], sourceOrigin: string): GateResult {
  const issues: string[] = [];
  let totalVisible = 0, matched = 0;
  let textTotal = 0, textPresent = 0;
  let linksTotal = 0, linksOk = 0;
  let mediaTotal = 0, mediaOk = 0;
  let inventedText = 0;

  // All source text (visible or not) — the deterministic compiler only ever
  // replays captured text, so this is the authoritative "not invented" set.
  const allSrcText = new Set<string>();
  for (const vp of viewports) {
    for (const s of collectSrcNodes(ir, vp)) {
      const t = normText(s.directText);
      if (t.length > 0) allSrcText.add(t);
    }
  }

  for (const vp of viewports) {
    const gen = genSnaps[vp] ? indexByCid(genSnaps[vp]!) : new Map<string, GenNode>();
    const srcNodes = collectSrcNodes(ir, vp);
    const genTextAll = normText([...gen.values()].filter((g) => g.visible).map((g) => g.text).join(" "));
    const srcTextSet = new Set<string>();

    for (const s of srcNodes) {
      if (!s.visible) continue;
      totalVisible++;
      const g = gen.get(s.node.id);
      if (g && (g.tag === s.node.tag || isValidRetag(s.node.tag, g.tag))) matched++;

      const t = normText(s.directText);
      if (t.length > 0) {
        textTotal++;
        srcTextSet.add(t);
        if (genTextAll.includes(t)) textPresent++;
      }
      if (s.node.tag === "a" && s.node.attrs.href) {
        linksTotal++;
        const srcHref = normHref(s.node.attrs.href, sourceOrigin);
        const genHref = g ? normHref(g.attrs.href ?? "", sourceOrigin) : "";
        if (srcHref === genHref) linksOk++;
      }
      if (/^(img|video|svg)$/.test(s.node.tag)) {
        mediaTotal++;
        if (s.node.tag === "svg") { if (g) mediaOk++; }
        else {
          const src = g?.attrs.src ?? "";
          if (g && (src === "" || !src.startsWith("http") || src.includes("127.0.0.1") || src.startsWith("data:"))) mediaOk++;
        }
      }
    }

    // invented visible text > 20 chars not present anywhere in the source DOM
    for (const g of gen.values()) {
      if (!g.visible) continue;
      const t = normText(g.text);
      if (t.length > 20 && !allSrcText.has(t)) {
        const inAnySrc = [...allSrcText].some((s) => s.includes(t) || t.includes(s));
        if (!inAnySrc) inventedText++;
      }
    }
  }

  const matchPct = totalVisible ? matched / totalVisible : 1;
  const textPct = textTotal ? textPresent / textTotal : 1;
  const linkPct = linksTotal ? linksOk / linksTotal : 1;
  const mediaPct = mediaTotal ? mediaOk / mediaTotal : 1;

  if (textPct < 0.999) issues.push(`text presence ${(textPct * 100).toFixed(1)}% (< 100%)`);
  if (matchPct < 0.98) issues.push(`node match ${(matchPct * 100).toFixed(1)}% (< 98%)`);
  if (linkPct < 0.999) issues.push(`link href preserve ${(linkPct * 100).toFixed(1)}%`);
  if (mediaPct < 0.999) issues.push(`media mapping ${(mediaPct * 100).toFixed(1)}%`);
  if (inventedText > 0) issues.push(`${inventedText} invented visible text nodes > 20 chars`);

  return {
    gate: "dom",
    pass: issues.length === 0,
    metrics: {
      nodeMatchPct: round4(matchPct), textPresentPct: round4(textPct),
      linkPct: round4(linkPct), mediaPct: round4(mediaPct),
      totalVisible, matched, textTotal, textPresent, linksTotal, mediaTotal, inventedText,
    },
    issues,
  };
}

// The generator deterministically retags certain source elements to a neutral
// div/span for valid HTML / hydration correctness (a <button>/<a> nested in an
// interactive ancestor; a <ul>/<ol>/<p>/<hN> whose JS-built children violate its
// content model). Those retags preserve cid, geometry, styles, and content — the
// node is faithfully reproduced, just with an HTML-valid tag — so the DOM gate must
// credit them as matched rather than penalize the compiler's own correct transform.
function isValidRetag(srcTag: string, genTag: string): boolean {
  if (genTag !== "div" && genTag !== "span") return false;
  if (srcTag === "a" || srcTag === "button") return true; // nested-interactive → div/span
  return genTag === "div" && /^(ul|ol|menu|dl|p|h[1-6])$/.test(srcTag); // content-model → div
}

function normHref(href: string, origin: string): string {
  if (!href) return "";
  if (href.startsWith("#")) return href;
  try {
    const u = new URL(href, origin);
    return (u.origin + u.pathname).replace(/\/$/, "") + (u.hash || "");
  } catch { return href; }
}

// ---------- Gate 4: computed style equivalence ----------
const EXACT_PROPS = ["display", "position", "flexDirection", "justifyContent", "alignItems", "textAlign", "textTransform", "fontWeight", "zIndex"];
const COLOR_PROPS = ["color", "backgroundColor"];
const PX2_PROPS = ["fontSize", "lineHeight", "letterSpacing", "borderTopLeftRadius"];
const PILL_PX = 1000; // radius at/above which a corner is fully rounded — pill ≡ rounded-full
// padding + gap are authored spacing — kept exact. MARGINS are deferred to the layout gate:
// auto margins resolve from free space (geometry), so a flowed box shifts them to a
// visually-equivalent but different px; the box's PLACEMENT is what matters, enforced there.
const PX4_PROPS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap"];
const PCT_PROPS = ["width", "height"];

export function gate4Style(ir: IR, genSnaps: Record<number, PageSnapshot>, viewports: number[]): GateResult {
  let nodesChecked = 0, nodesPass = 0;
  const propFail: Record<string, number> = {};
  const issues: string[] = [];

  for (const vp of viewports) {
    const gen = genSnaps[vp] ? indexByCid(genSnaps[vp]!) : new Map<string, GenNode>();
    const srcNodes = collectSrcNodes(ir, vp);
    for (const s of srcNodes) {
      if (!s.visible) continue;
      const g = gen.get(s.node.id);
      if (!g || g.tag !== s.node.tag) continue;
      nodesChecked++;
      let nodeOk = true;
      const fails: string[] = [];

      for (const p of EXACT_PROPS) {
        // `flex-start`/`flex-end` and `start`/`end` are equivalent in flex/grid layout
        // (and render identically — the perceptual gate confirms). A source `end` vs a
        // Tailwind `items-end` (→`flex-end`) is not a real divergence, so normalize the
        // synonym before comparing alignment keywords.
        const norm = ALIGN_PROPS.has(p) ? normAlign : (x: string | undefined) => x;
        if (!cmpExact(norm(s.computed[p]), norm(g.computed[p]))) { nodeOk = false; fails.push(p); }
      }
      for (const p of COLOR_PROPS) {
        if (!colorsClose(s.computed[p], g.computed[p])) { nodeOk = false; fails.push(p); }
      }
      if (normFontFamily(s.computed.fontFamily) !== normFontFamily(g.computed.fontFamily)) { nodeOk = false; fails.push("fontFamily"); }
      for (const p of PX2_PROPS) {
        // A "pill" radius (≥ PILL_PX, e.g. the conventional 9999px) and Tailwind's `rounded-full`
        // (which compiles to a saturating 3.4e38px) fully round the corner identically — visually
        // equal, only numerically far apart. Treat any two such large radii as equivalent so the
        // idiomatic `rounded-full` doesn't trip the exact-px compare; real radii stay ±2px.
        if (p === "borderTopLeftRadius" && pxNum(s.computed[p] ?? "") >= PILL_PX && pxNum(g.computed[p] ?? "") >= PILL_PX) continue;
        const eq = p === "letterSpacing"
          ? letterSpacingEquivalent(s.computed[p], g.computed[p])
          : cmpNum(s.computed[p], g.computed[p], 2, 0);
        if (!eq) { nodeOk = false; fails.push(p); }
      }
      for (const p of PX4_PROPS) {
        // `gap: normal` is the initial value and resolves to 0 for flex/grid, so it
        // is equivalent to `gap: 0px`; the clone often renders one where the source
        // computed the other. Normalize before comparing (real gaps still checked).
        const a = p === "gap" ? (s.computed[p] ?? "").replace(/\bnormal\b/g, "0px") : s.computed[p];
        const b = p === "gap" ? (g.computed[p] ?? "").replace(/\bnormal\b/g, "0px") : g.computed[p];
        if (!cmpNum(a, b, 4, 0)) { nodeOk = false; fails.push(p); }
      }
      // width/height (PCT_PROPS) are NOT compared here: rendered box size is geometry, enforced
      // directly by the layout gate (per-leaf size + section bbox) and the perceptual gate. A
      // content-driven box (width/height:auto) reflows to a visually-equivalent but not
      // byte-identical px — the right bar is "same place + size + pixels", not exact computed CSS.
      // background image presence
      const sBg = (s.computed.backgroundImage ?? "none") !== "none";
      const gBg = (g.computed.backgroundImage ?? "none") !== "none";
      if (sBg !== gBg) { nodeOk = false; fails.push("backgroundImage"); }

      if (nodeOk) nodesPass++;
      else {
        for (const f of fails) propFail[f] = (propFail[f] ?? 0) + 1;
        if (process.env.STYLE_DEBUG && (process.env.STYLE_DEBUG === "*" || fails.includes(process.env.STYLE_DEBUG))) {
          const dp = process.env.STYLE_DEBUG === "*" ? fails : [process.env.STYLE_DEBUG];
          console.error(`[style] vp=${vp} cid=${s.node.id} tag=${s.node.tag} fails=${fails.join(",")} ` +
            dp.map((p) => `${p}: src='${s.computed[p]}' gen='${g.computed[p]}'`).join(" | "));
        }
      }
    }
  }

  const passPct = nodesChecked ? nodesPass / nodesChecked : 1;
  if (passPct < 0.95) issues.push(`computed style pass ${(passPct * 100).toFixed(1)}% (< 95%)`);
  const topFails = Object.entries(propFail).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return {
    gate: "style",
    pass: issues.length === 0,
    metrics: { passPct: round4(passPct), nodesChecked, nodesPass, topFailingProps: Object.fromEntries(topFails) },
    issues,
  };
}

function cmpExact(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined) return true; // source didn't constrain it
  return (a ?? "") === (b ?? "");
}
const ALIGN_PROPS = new Set(["alignItems", "justifyContent"]);
/** Collapse flex-relative alignment synonyms to their writing-mode keyword
 *  (`flex-start`→`start`, `flex-end`→`end`) — equivalent in standard layouts. */
function normAlign(v: string | undefined): string | undefined {
  return v === undefined ? v : v.replace(/^flex-/, "");
}
function cmpNum(a: string | undefined, b: string | undefined, abs: number, pct: number): boolean {
  if (a === undefined) return true;
  const na = pxNum(a), nb = pxNum(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return (a ?? "") === (b ?? "");
  return withinAbs(na, nb, abs) || (pct > 0 && withinPct(na, nb, pct));
}

/** Compare two computed `letter-spacing` values within the ±2px style tolerance, treating the keyword
 *  `normal` as `0px`. `letter-spacing: normal` is the initial value and adds no extra spacing (it
 *  computes to 0), so `normal` ≡ `0px`; crucially, Chromium serializes a computed `letter-spacing: 0`
 *  BACK as the keyword `normal`, so a genuinely-zero (or sub-0.1px, snapped-to-zero) tracking shows up
 *  as `normal` on one side and `0px` on the other — a spelling difference that `cmpNum` alone reads as
 *  a NaN → exact-string mismatch. Normalizing the keyword before the numeric compare removes that false
 *  failure while a real tracking delta (> 2px) still fails. Mirrors the `gap: normal → 0px` handling. */
export function letterSpacingEquivalent(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined) return true;
  const norm = (v: string | undefined): string => (v ?? "").replace(/\bnormal\b/g, "0px");
  return cmpNum(norm(a), norm(b), 2, 0);
}

// ---------- Gate 5: layout / section equivalence ----------
export function gate5Layout(ir: IR, genSnaps: Record<number, PageSnapshot>, sections: Section[], viewports: number[], reflow = false): GateResult {
  const issues: string[] = [];
  const perVp: Record<number, Record<string, unknown>> = {};

  for (const vp of viewports) {
    const genSnap = genSnaps[vp];
    if (!genSnap) { issues.push(`no generated render at ${vp}`); continue; }
    const gen = indexByCid(genSnap);
    const srcHeight = ir.doc.perViewport[vp]?.scrollHeight ?? 0;
    const genHeight = genSnap.doc.scrollHeight;
    const heightDelta = srcHeight ? Math.abs(srcHeight - genHeight) / srcHeight : 0;

    // sections present + order + bbox
    let sectionsPresent = 0, sectionsBboxOk = 0;
    const srcSectionYs: number[] = [], genSectionYs: number[] = [];
    for (const sec of sections) {
      const g = gen.get(sec.nodeId);
      const srcBox = sec.bboxByVp[vp];
      if (g) {
        sectionsPresent++;
        if (srcBox) {
          srcSectionYs.push(srcBox.y);
          genSectionYs.push(g.bbox.y);
          const yOk = withinAbs(srcBox.y, g.bbox.y, Math.max(24, srcHeight * 0.03));
          const hOk = withinPct(srcBox.height, g.bbox.height, 0.08);
          const wOk = withinPct(srcBox.width, g.bbox.width, 0.02);
          if (yOk && hOk && wOk) sectionsBboxOk++;
        }
      }
    }
    // The clone must reproduce the source's vertical section order — not be sorted
    // ascending: a fixed/sticky nav can legitimately sit above the fold (y<0) after
    // the main section in DOM order. Compare gen's ordering against the source's.
    const orderOk = sameOrder(srcSectionYs, genSectionYs);

    // leaf bbox position (median delta) AND size (per-leaf width/height within a visual tolerance).
    // Rendered SIZE fidelity lives here, not in the computed-style gate: content-driven boxes
    // (width/height:auto) reflow to visually-equivalent but not byte-identical px, so the right
    // bar is "renders at the same place and size" (here + the perceptual gate), not exact CSS px.
    const srcNodes = collectSrcNodes(ir, vp);
    const deltas: number[] = [];
    let sizeChecked = 0, sizeOk = 0;
    for (const s of srcNodes) {
      if (!s.visible) continue;
      if (hasVisibleElementChild(s.node, vp)) continue; // leaf only
      const g = gen.get(s.node.id);
      if (!g) continue;
      const d = Math.abs(s.bbox.x - g.bbox.x) + Math.abs(s.bbox.y - g.bbox.y);
      deltas.push(d / 2);
      sizeChecked++;
      const wOk = withinAbs(s.bbox.width, g.bbox.width, Math.max(8, s.bbox.width * 0.06));
      const hOk = withinAbs(s.bbox.height, g.bbox.height, Math.max(8, s.bbox.height * 0.06));
      if (wOk && hOk) sizeOk++;
    }
    const medianDelta = median(deltas);
    const leafSizeOkPct = sizeChecked ? sizeOk / sizeChecked : 1;

    const sectionsBboxPct = sections.length ? sectionsBboxOk / sections.length : 1;
    perVp[vp] = {
      srcHeight, genHeight, heightDeltaPct: round4(heightDelta),
      sectionsTotal: sections.length, sectionsPresent, sectionsBboxOkPct: round4(sectionsBboxPct),
      orderOk, leafMedianDelta: round2(medianDelta), leafSamples: deltas.length, leafSizeOkPct: round4(leafSizeOkPct),
    };

    if (heightDelta > 0.05) issues.push(`vp${vp} page height delta ${(heightDelta * 100).toFixed(1)}% (> 5%)`);
    if (sectionsPresent < sections.length) issues.push(`vp${vp} ${sections.length - sectionsPresent} sections missing`);
    if (!orderOk) issues.push(`vp${vp} section order mismatch`);
    if (sections.length && sectionsBboxPct < 0.9) issues.push(`vp${vp} section bbox ok ${(sectionsBboxPct * 100).toFixed(0)}% (< 90%)`);
    // leaf-POSITION median tolerance is generous (the perceptual screenshot gate is the strict
    // visual bar for placement; a small median drift from letting geometry flow is invisible there
    // — section structure + leaf SIZE below stay tight). A large drift still fails. In the opt-in
    // reflow trade (flowed heights re-position content vertically) the bar widens to 2% of the page
    // height (≈160px on a tall mobile page vs the ~72px benign drift) — backstopped by the page-height
    // (≤5%), section-bbox (≥90%), leaf-size (≥92%) and perceptual (≤10–14%) gates, which all stay
    // strict and catch any REAL break (content lost, mis-sized, or visually displaced).
    const posTol = reflow ? Math.max(16, Math.round(srcHeight * 0.02)) : 16;
    if (medianDelta > posTol) issues.push(`vp${vp} leaf median bbox delta ${medianDelta.toFixed(1)}px (> ${posTol}px)`);
    if (leafSizeOkPct < 0.92) issues.push(`vp${vp} leaf size ok ${(leafSizeOkPct * 100).toFixed(0)}% (< 92%)`);
  }

  return { gate: "layout", pass: issues.length === 0, metrics: { perViewport: perVp }, issues };
}

// ---------- Responsive gate: behaviour at NON-captured widths ----------
// The other layout gates render the clone only at the captured widths (375/768/1280/1920),
// so per-node baked-px output scores perfectly there even though it stairsteps between bands
// and off-centres beyond the widest one (the "not truly responsive" failure). This gate
// renders the clone at widths the grader never sampled and asserts source-independent
// invariants that any faithful responsive clone must hold:
//   1. no horizontal overflow the source didn't have (a baked px wider than the window);
//   2. a container the source centres stays centred at every width (not frozen at one band's
//      margins);
//   3. a full-bleed section keeps filling the window.
type ParentOf = Map<string, IRNode | undefined>;
function buildParentMap(ir: IR): ParentOf {
  const m: ParentOf = new Map();
  const walk = (node: IRNode, parent: IRNode | undefined): void => {
    m.set(node.id, parent);
    for (const c of node.children) if (!isTextChild(c)) walk(c, node);
  };
  walk(ir.root, undefined);
  return m;
}
function contentBox(bbox: { x: number; width: number }, cs: Record<string, string>): { left: number; right: number; width: number } {
  const padL = pxNum(cs.paddingLeft) || 0, padR = pxNum(cs.paddingRight) || 0;
  const bL = pxNum(cs.borderLeftWidth) || 0, bR = pxNum(cs.borderRightWidth) || 0;
  const left = bbox.x + padL + bL, right = bbox.x + bbox.width - padR - bR;
  return { left, right, width: right - left };
}
/** Is this source node horizontally centred in its container at `vp` (block-level, in-flow,
 *  symmetric gaps, room to centre)? Mirrors the generator's centring detection. */
function srcCentered(node: IRNode, parent: IRNode, vp: number): boolean {
  const cs = node.computedByVp[vp], nb = node.bboxByVp[vp];
  const pcs = parent.computedByVp[vp], pb = parent.bboxByVp[vp];
  if (!cs || !nb || !pcs || !pb) return false;
  if (!/^(block|flow-root|list-item|flex|grid)$/.test(cs.display || "")) return false;
  if ((cs.position || "static") !== "static" && (cs.position || "static") !== "relative") return false;
  if (/(?:^|-)(?:flex|grid)$/.test(pcs.display || "")) return false; // flex/grid item — parent positions it
  const pc = contentBox(pb, pcs);
  const gapL = nb.x - pc.left, gapR = pc.right - (nb.x + nb.width);
  return gapL > 2 && gapR > 2 && Math.abs(gapL - gapR) <= 1.5 && nb.width < pc.width - 4;
}
/** Does this source node span the full viewport width at ≥2 captured widths (a full-bleed bar)? */
function srcFullBleed(node: IRNode, viewports: number[]): boolean {
  let n = 0;
  for (const vp of viewports) {
    const nb = node.bboxByVp[vp];
    if (!nb) continue;
    if (Math.abs(nb.x) <= 2 && Math.abs(nb.width - vp) <= 2) n++;
    else if (nb.width > 0) return false;
  }
  return n >= 2;
}

export function gateResponsive(ir: IR, probes: Record<number, PageSnapshot>, viewports: number[]): GateResult {
  const issues: string[] = [];
  const widths = Object.keys(probes).map(Number).sort((a, b) => a - b);
  if (widths.length === 0) return { gate: "responsive", pass: true, metrics: { probed: 0, na: true }, issues };

  // Source horizontal-overflow baseline: did the captured page itself scroll horizontally?
  // (A site that legitimately overflows at capture is exempt from the overflow invariant.)
  const srcOverflows = viewports.some((vp) => {
    const pv = ir.doc.perViewport[vp];
    return pv ? pv.scrollWidth > vp + 3 : false;
  });

  const canonical = ir.doc.canonicalViewport;
  const parentOf = buildParentMap(ir);
  const centeredCids: string[] = [];
  const fullBleedCids: string[] = [];
  const walk = (node: IRNode): void => {
    const parent = parentOf.get(node.id);
    if (parent && srcCentered(node, parent, canonical)) centeredCids.push(node.id);
    if (srcFullBleed(node, viewports)) fullBleedCids.push(node.id);
    for (const c of node.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);

  let overflowViolations = 0, centerChecks = 0, centerViolations = 0, bleedChecks = 0, bleedViolations = 0;
  const samples: string[] = [];
  for (const w of widths) {
    const snap = probes[w]!;
    const idx = indexByCid(snap);
    // (1) no unexpected horizontal overflow
    if (!srcOverflows && snap.doc.scrollWidth > w + Math.max(3, w * 0.01)) {
      overflowViolations++;
      if (samples.length < 8) samples.push(`w=${w}: scrollWidth ${snap.doc.scrollWidth} > viewport ${w} (horizontal overflow)`);
    }
    // (2) centred containers stay centred
    for (const cid of centeredCids) {
      const g = idx.get(cid); if (!g || !g.visible) continue;
      const parent = parentOf.get(cid); const pg = parent ? idx.get(parent.id) : undefined;
      if (!pg) continue;
      const pc = contentBox(pg.bbox, pg.computed);
      if (g.bbox.width >= pc.width - 4) continue; // fills here (below its cap) → nothing to centre
      const gapL = g.bbox.x - pc.left, gapR = pc.right - (g.bbox.x + g.bbox.width);
      centerChecks++;
      if (Math.abs(gapL - gapR) > Math.max(2, pc.width * 0.01)) {
        centerViolations++;
        if (samples.length < 8) samples.push(`w=${w} cid=${cid}: off-centre (left ${Math.round(gapL)} vs right ${Math.round(gapR)})`);
      }
    }
    // (3) full-bleed sections keep filling the window
    for (const cid of fullBleedCids) {
      const g = idx.get(cid); if (!g || !g.visible) continue;
      bleedChecks++;
      if (Math.abs(g.bbox.width - w) > Math.max(3, w * 0.01)) {
        bleedViolations++;
        if (samples.length < 8) samples.push(`w=${w} cid=${cid}: full-bleed width ${Math.round(g.bbox.width)} != viewport ${w}`);
      }
    }
  }

  if (overflowViolations > 0) issues.push(`${overflowViolations} probe width(s) overflow horizontally`);
  // A counted violation already cleared the sub-pixel geometric tolerance, so it is a real
  // divergence; tolerate only a ~5% fraction (a rare breakpoint that legitimately re-aligns).
  if (centerViolations > Math.floor(centerChecks * 0.05)) issues.push(`${centerViolations}/${centerChecks} centred-container checks off-centre at non-captured widths`);
  if (bleedViolations > Math.floor(bleedChecks * 0.05)) issues.push(`${bleedViolations}/${bleedChecks} full-bleed checks don't fill the window`);

  return {
    gate: "responsive",
    pass: issues.length === 0,
    metrics: {
      probeWidths: widths, srcOverflows,
      overflowViolations, centerChecks, centerViolations, bleedChecks, bleedViolations,
      centeredContainers: centeredCids.length, fullBleedSections: fullBleedCids.length,
      samples,
    },
    issues,
  };
}

function isSortedAscending(arr: number[]): boolean {
  for (let i = 1; i < arr.length; i++) if (arr[i]! < arr[i - 1]! - 1) return false;
  return true;
}
/** True when `b` orders its elements the same way `a` does (same argsort) — i.e.
 *  the clone reproduces the source's relative vertical section order. */
function sameOrder(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const idx = a.map((_, i) => i);
  const byA = [...idx].sort((x, y) => a[x]! - a[y]!);
  const byB = [...idx].sort((x, y) => b[x]! - b[y]!);
  return byA.every((v, i) => v === byB[i]);
}
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
