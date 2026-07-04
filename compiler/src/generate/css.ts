import type { IR, IRNode, StyleMap } from "../normalize/ir.js";
import { isTextChild, irContentExtent } from "../normalize/ir.js";
import type { TokenResolver } from "../infer/tokens.js";

/** Finalize a decls map: reference design tokens (var(--…)) where the value is tokenized
 *  — fidelity-neutral (tokens hold the literal value). */
function finalizeDecls(m: Map<string, string>, resolver?: TokenResolver): Map<string, string> {
  if (resolver) for (const [k, v] of m) { const t = resolver(k, v); if (t) m.set(k, t); }
  return m;
}

/**
 * The fidelity engine. Emits per-node CSS that replays the captured computed
 * styles, with per-viewport overrides under media-query bands. Combined with the
 * UA reset (see RESET_CSS) so that "skipping a default value" reliably falls back
 * to the CSS initial value rather than a browser UA default.
 *
 * Geometry is exact because computed width/height are reported per the element's
 * own box-sizing (verified empirically), so replaying box-sizing + width + height
 * + padding + border reconstructs the same border-box.
 */

// Reset that neutralizes UA defaults to CSS initial values, so default-skipping
// in the generator is correct. box-sizing defaults to border-box (matches the
// overwhelming majority of modern sites; content-box is emitted per-node).
export const RESET_CSS = `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid currentColor; }
html { -webkit-text-size-adjust: 100%; line-height: normal; }
body { margin: 0; }
ul, ol, menu { list-style: none; }
a { color: inherit; text-decoration: none; }
button, input, select, textarea, optgroup { font: inherit; color: inherit; background: transparent; border: 0; padding: 0; margin: 0; text-align: inherit; letter-spacing: inherit; }
button { cursor: pointer; }
table { border-collapse: separate; border-spacing: 0; }
img, picture, video, canvas, svg { display: inline-block; }
/* Lottie runtime fit: the player re-mounts its svg/canvas into an absolute overlay that fills
   the host's captured (per-viewport, definite) box. Force that runtime media to fit the box so
   an aspect-mismatched viewBox (e.g. a portrait animation in a shorter, letterboxed source box)
   can't inflate past the pinned height. Scoped to the runtime-marked host only. */
[data-ditto-lottie] > div > svg, [data-ditto-lottie] > div > canvas { width: 100%; height: 100%; display: block; }
h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd { margin: 0; }
/* Neutralize UA text defaults to inherit so the generator's default-skipping is
   correct: a property equal to its inherited value is simply not emitted. */
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
b, strong, th { font-weight: inherit; }
em, i, cite, var, dfn, address, q { font-style: inherit; }
small, big, sub, sup { font-size: inherit; }
sub, sup { vertical-align: inherit; }
code, kbd, samp, pre, tt, var { font-family: inherit; font-size: inherit; }
mark { background-color: transparent; color: inherit; }
abbr[title] { text-decoration: none; }
fieldset, legend { min-width: 0; }
`;

const CAPTURE_VIEWPORT_HEIGHTS: Record<number, number> = {
  375: 812,
  480: 854,
  640: 960,
  768: 1024,
  1024: 768,
  1280: 800,
  1536: 864,
  1920: 1080,
  2560: 1440,
};

function isViewportHeight(value: string, width: number): boolean {
  if (!value.endsWith("px")) return false;
  const expected = CAPTURE_VIEWPORT_HEIGHTS[width] ?? Math.round(width * 0.66);
  return Math.abs(pf(value) - expected) <= 1;
}

// Inherited properties — skipped when they equal the parent's value (inheritance
// reproduces them), only emitted on the node that introduces a change.
const INHERITED = new Set([
  "color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
  "letterSpacing", "wordSpacing", "textAlign", "textTransform", "whiteSpace",
  "wordBreak", "overflowWrap", "textWrap", "textIndent", "fontVariantCaps", "fontFeatureSettings",
  "listStyleType", "listStylePosition", "writingMode", "direction", "cursor",
  "textShadow", "visibility", "textDecorationColor", "webkitTextStroke",
  "webkitTextFillColor",
]);

// Properties handled in dedicated blocks (not the generic loop).
const SPECIAL = new Set([
  "width", "height", "minHeight", "boxSizing",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
]);

// Generic properties to emit, with the value treated as a removable default.
const GENERIC: Array<{ prop: string; def: string | string[] }> = [
  { prop: "display", def: "__never__" }, // always emit display
  { prop: "position", def: "static" },
  { prop: "top", def: "auto" }, { prop: "right", def: "auto" },
  { prop: "bottom", def: "auto" }, { prop: "left", def: "auto" },
  { prop: "float", def: "none" }, { prop: "clear", def: "none" },
  { prop: "zIndex", def: "auto" },
  // visibility is INHERITED, so the parent-equality skip keeps descendants of a
  // hidden subtree clean; without this entry a node hidden at the canonical
  // viewport could never emit `visibility:hidden` at all (the only other path is
  // per-band and gated on being shown at base).
  { prop: "visibility", def: "visible" },
  { prop: "opacity", def: "1" }, { prop: "isolation", def: "auto" },
  { prop: "mixBlendMode", def: "normal" },
  { prop: "minWidth", def: ["0px", "auto"] }, { prop: "maxWidth", def: "none" },
  { prop: "maxHeight", def: "none" },
  { prop: "marginTop", def: "0px" }, { prop: "marginRight", def: ["0px", "auto"] },
  { prop: "marginBottom", def: "0px" }, { prop: "marginLeft", def: ["0px", "auto"] },
  { prop: "paddingTop", def: "0px" }, { prop: "paddingRight", def: "0px" },
  { prop: "paddingBottom", def: "0px" }, { prop: "paddingLeft", def: "0px" },
  { prop: "borderTopLeftRadius", def: "0px" }, { prop: "borderTopRightRadius", def: "0px" },
  { prop: "borderBottomRightRadius", def: "0px" }, { prop: "borderBottomLeftRadius", def: "0px" },
  { prop: "flexDirection", def: "row" }, { prop: "flexWrap", def: "nowrap" },
  { prop: "justifyContent", def: "normal" }, { prop: "alignItems", def: "normal" },
  { prop: "alignContent", def: "normal" }, { prop: "alignSelf", def: "auto" },
  { prop: "flexGrow", def: "0" }, { prop: "flexShrink", def: "1" },
  { prop: "flexBasis", def: "auto" }, { prop: "order", def: "0" },
  { prop: "gap", def: ["normal", "0px"] }, { prop: "rowGap", def: ["normal", "0px"] },
  { prop: "columnGap", def: ["normal", "0px"] },
  { prop: "gridTemplateColumns", def: "none" }, { prop: "gridTemplateRows", def: "none" },
  { prop: "gridTemplateAreas", def: "none" },
  { prop: "gridAutoFlow", def: "row" }, { prop: "gridAutoRows", def: "auto" },
  { prop: "gridAutoColumns", def: "auto" }, { prop: "justifyItems", def: ["normal", "legacy"] },
  { prop: "gridColumnStart", def: "auto" }, { prop: "gridColumnEnd", def: "auto" },
  { prop: "gridRowStart", def: "auto" }, { prop: "gridRowEnd", def: "auto" },
  { prop: "overflowX", def: "visible" }, { prop: "overflowY", def: "visible" },
  { prop: "objectFit", def: "fill" }, { prop: "objectPosition", def: "50% 50%" },
  { prop: "aspectRatio", def: "auto" }, { prop: "verticalAlign", def: "baseline" },
  // Inherited properties: rely solely on the parent-equality skip (never an
  // absolute default), otherwise e.g. text-align:left looks like a "default" and
  // gets dropped, letting the node wrongly inherit a parent's center.
  { prop: "color", def: "__never__" },
  { prop: "fontFamily", def: "__never__" }, { prop: "fontSize", def: "__never__" },
  { prop: "fontWeight", def: "__never__" }, { prop: "fontStyle", def: "__never__" },
  { prop: "lineHeight", def: "__never__" }, { prop: "letterSpacing", def: "__never__" },
  { prop: "wordSpacing", def: "__never__" }, { prop: "textAlign", def: "__never__" },
  { prop: "textTransform", def: "__never__" }, { prop: "textDecorationLine", def: "none" },
  { prop: "textDecorationStyle", def: "solid" },
  { prop: "whiteSpace", def: "__never__" }, { prop: "wordBreak", def: "__never__" },
  { prop: "overflowWrap", def: "__never__" }, { prop: "textIndent", def: "__never__" },
  // text-wrap: elide the initial `wrap`; emit `balance`/`pretty`/`nowrap`/`stable`.
  { prop: "textWrap", def: "wrap" },
  { prop: "textShadow", def: "__never__" }, { prop: "fontVariantCaps", def: "__never__" },
  { prop: "fontFeatureSettings", def: "__never__" }, { prop: "listStyleType", def: "__never_list__" },
  { prop: "listStylePosition", def: "__never__" }, { prop: "writingMode", def: "__never__" },
  { prop: "direction", def: "__never__" },
  { prop: "backgroundColor", def: ["rgba(0, 0, 0, 0)", "transparent"] },
  { prop: "backgroundImage", def: "none" }, { prop: "backgroundSize", def: "auto" },
  { prop: "backgroundPosition", def: ["0% 0%", "0px 0px"] }, { prop: "backgroundRepeat", def: "repeat" },
  { prop: "backgroundClip", def: "border-box" }, { prop: "backgroundOrigin", def: "padding-box" },
  { prop: "backgroundAttachment", def: "scroll" }, { prop: "backgroundBlendMode", def: "normal" },
  { prop: "boxShadow", def: "none" }, { prop: "filter", def: "none" },
  { prop: "backdropFilter", def: "none" }, { prop: "transform", def: "none" },
  { prop: "translate", def: "none" }, { prop: "rotate", def: "none" }, { prop: "scale", def: "none" },
  { prop: "transformOrigin", def: "__skip_if_no_transform__" }, { prop: "clipPath", def: "none" },
  { prop: "maskImage", def: "none" }, { prop: "webkitBackgroundClip", def: ["border-box", "initial"] },
  { prop: "webkitTextFillColor", def: "__skip__" }, { prop: "webkitTextStroke", def: "__stroke__" },
  { prop: "animationName", def: "none" }, { prop: "animationDuration", def: "0s" },
  { prop: "animationTimingFunction", def: "ease" }, { prop: "animationDelay", def: "0s" },
  { prop: "animationIterationCount", def: "1" }, { prop: "animationDirection", def: "normal" },
  { prop: "animationFillMode", def: "none" },
  { prop: "cursor", def: "auto" }, { prop: "pointerEvents", def: "auto" },
  { prop: "tableLayout", def: "auto" }, { prop: "borderCollapse", def: "separate" },
  { prop: "borderSpacing", def: ["0px", "0px 0px"] },
];

const REPLACED = new Set(["img", "svg", "video", "canvas", "picture", "iframe", "input", "textarea", "select", "hr", "object", "embed"]);
const ANIMATION_PROPS = new Set(["animationName", "animationDuration", "animationTimingFunction", "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode"]);

function kebab(prop: string): string {
  if (prop.startsWith("webkit")) return "-webkit-" + kebab(prop[6]!.toLowerCase() + prop.slice(7));
  return prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function isDefault(def: string | string[], value: string): boolean {
  return Array.isArray(def) ? def.includes(value) : def === value;
}

export type Band = { vp: number; media: string | null };

export function computeBands(viewports: number[], canonical: number): Band[] {
  const sorted = [...viewports].sort((a, b) => a - b);
  const mids: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) mids.push(Math.floor((sorted[i]! + sorted[i + 1]!) / 2));
  return sorted.map((vp, i) => {
    if (vp === canonical) return { vp, media: null };
    const left = i === 0 ? 0 : mids[i - 1]! + 1;
    const right = i === sorted.length - 1 ? Infinity : mids[i]!;
    let media: string;
    if (left <= 0) media = `@media (max-width: ${right}px)`;
    else if (right === Infinity) media = `@media (min-width: ${left}px)`;
    else media = `@media (min-width: ${left}px) and (max-width: ${right}px)`;
    return { vp, media };
  });
}

/** Rewrite url(...) tokens in a CSS value to local asset paths; unknown remote
 * urls become a transparent placeholder so the generated app never 404s or
 * points back to the origin (rubric Gate 2). */
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function rewriteUrls(value: string, assetMap: Map<string, string>): string {
  return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_full, _q, u: string) => {
    if (u.startsWith("data:")) return `url(${u})`;
    const local = assetMap.get(u);
    if (local) return `url("${local}")`;
    return `url("${TRANSPARENT_GIF}")`;
  });
}

/** A fluid full-bleed element: its rendered box spans the full viewport width at EVERY
 *  captured viewport (a fixed-px element can't equal 375 AND 1280 AND 1920) and sits at
 *  the left edge. Such elements were authored fluid (width:100%/auto, or an absolute bar
 *  pinned `left:0;right:0`); the capture only ever saw the resolved px, so emitting that
 *  px locks the clone to the captured widths and it stops filling a wider window (the
 *  "page isn't full-width" bug — body, full-bleed sections, sticky nav bars, full-screen
 *  background layers). Dropping the px (→ width:auto, or insets-determined for the pinned
 *  absolute case) restores the fluidity while still resolving to the identical px at every
 *  captured viewport, so the layout gate (measured at those exact widths) is unmoved.
 *  Three guards keep this safe — only TRUE full-bleed converts:
 *   - in-flow block-level box (block/flow-root/list-item/flex/grid), not a flex/grid item;
 *   - out-of-flow (absolute/fixed) box pinned to BOTH horizontal edges (left≈0 && right≈0);
 *   - NO horizontal margins / positional offsets: a negative-margin "breakout" row
 *     (width:1280;margin-left:-640;left:320 — a full-bleed scroller inside a padded
 *     container) spans the viewport via offsets calibrated to its explicit width, so that
 *     width is load-bearing and must be kept. */
function isFluidFullBleed(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  // Replaced elements (img/svg/video/canvas/iframe…) and opaque custom elements size to
  // their INTRINSIC dimensions under width:auto, not to the container — a full-bleed <svg>
  // would render at its viewBox width at every viewport. Their captured px is load-bearing.
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const nearZero = (v: string | undefined): boolean => v != null && v !== "auto" && Math.abs(parseFloat(v)) <= 1.5;
  const zeroOrAuto = (v: string | undefined): boolean => v == null || v === "auto" || Math.abs(parseFloat(v)) <= 1.5;
  let samples = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    const bb = node.bboxByVp[vp];
    if (!cs || !bb) continue;
    const disp = cs.display || "";
    const blockish = disp === "block" || disp === "flow-root" || disp === "list-item" || disp === "flex" || disp === "grid";
    if (!blockish) return false;
    // Horizontal margins make the width load-bearing (negative-margin breakout) — never drop it.
    if (!nearZero(cs.marginLeft) || !nearZero(cs.marginRight)) return false;
    const pos = cs.position || "static";
    if (pos === "absolute" || pos === "fixed") {
      if (!(nearZero(cs.left) && nearZero(cs.right))) return false; // width is real unless both insets pin it
    } else {
      // static | relative | sticky. A sticky box generates a normal in-flow box: its WIDTH fills the
      // containing block exactly as static/relative does (position:sticky only shifts the box's offset
      // while scrolling, never its resolved width). So a sticky wrapper that spans the viewport at
      // every captured width was authored fluid (width:100%/auto) and must NOT freeze to the canonical
      // px — frozen at 1280, a `justify-content:center` sticky banner pushes its inner content off a
      // 375 viewport. Treat sticky identically to the static/relative fluid-fill branch.
      if (!(zeroOrAuto(cs.left) && zeroOrAuto(cs.right))) return false; // positioned breakout: width is real
      const pdisp = parentNode?.computedByVp[vp]?.display || "";
      if (/flex|grid/.test(pdisp)) return false; // flex/grid item: auto width ≠ fill
    }
    if (Math.abs(bb.x) > 1.5) return false;          // starts at the left edge
    if (Math.abs(bb.width - vp) > 1.5) return false; // spans the full viewport
    samples++;
  }
  return samples >= 2; // proven fluid only if it tracked ≥2 distinct viewport widths
}

/** A full-bleed flex/grid ITEM. Its box spans the full viewport at every captured width and
 *  sits at the left edge, but its containing block is a column flex / grid that does NOT
 *  stretch it on the cross axis (e.g. a `flex-direction:column; align-items:center` <main>).
 *  There, `width:auto` shrinks the item to its content instead of filling — so isFluidFullBleed
 *  (which would drop the width) correctly refuses it. Such an item was authored `width:100%`
 *  (or align-self:stretch); replaying the resolved px locks it to the capture width and leaves
 *  a dead gutter on wider windows (framer's full-bleed sections under a centered column <main>).
 *  Emitting `width:100%` restores the fluidity and still resolves to the identical px at every
 *  captured viewport, so the layout gate is unmoved. Row flex is excluded (a 100% item would
 *  overflow its siblings); only a box that already fills the viewport at ≥2 widths, starts at
 *  x≈0, and has no horizontal margins qualifies. */
function isFluidFillItem(node: IRNode, layoutParent: IRNode | undefined, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  if (!layoutParent) return false;
  const nearZero = (v: string | undefined): boolean => v != null && v !== "auto" && Math.abs(parseFloat(v)) <= 1.5;
  let samples = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    const bb = node.bboxByVp[vp];
    const pcs = layoutParent.computedByVp[vp];
    if (!cs || !bb || !pcs) continue;
    const pdisp = pcs.display || "";
    const columnFlex = /flex/.test(pdisp) && /column/.test(pcs.flexDirection || "row");
    const isGrid = /grid/.test(pdisp);
    if (!columnFlex && !isGrid) return false;                  // only non-stretching cross-axis contexts
    if (!nearZero(cs.marginLeft) || !nearZero(cs.marginRight)) return false;
    const pos = cs.position || "static";
    if (pos === "absolute" || pos === "fixed") return false;   // pinned boxes are isFluidFullBleed's job
    if (Math.abs(bb.x) > 1.5) return false;                    // starts at the left edge
    if (Math.abs(bb.width - vp) > 1.5) return false;           // spans the full viewport
    samples++;
  }
  return samples >= 2;
}

/** How a node's width is emitted. The capture only ever saw a node's *resolved px* at the
 *  four sampled widths, so the default ("fixed") replays that px under each media band — which
 *  is exact AT those widths but frozen between/beyond them (the "stairstep" + off-centre-on-a-
 *  wide-monitor bugs). When the per-viewport samples prove the width was authored *relative*
 *  to its container, emit the relative form instead: it resolves to the IDENTICAL px at every
 *  captured viewport (so gates 0–6, measured only at those widths, are unmoved) yet scales
 *  fluidly everywhere else — the same generalisation `isFluidFullBleed` already applies to
 *  full-viewport elements, extended to "fills/centres within its container". */
export type WidthPlan = { kind: "fixed" } | { kind: "auto" } | { kind: "percent"; pct: string } | { kind: "percentVp"; pctByVp: Record<number, string> } | { kind: "flexfill" } | { kind: "fill" } | { kind: "fillcap"; cap: string } | { kind: "basis"; px: string } | { kind: "basisFull" };
const PLAN_FIXED: WidthPlan = { kind: "fixed" };

const pf = (v: string | undefined): number => { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : 0; };
// Snap sub-pixel geometry: integer when within 0.1px (measurement jitter), else at most 1 decimal
// — matching the Tailwind arbitrary-length rounding (tailwind.ts:snapLen) so CSS and utility output
// agree and frozen sub-pixel noise (204.797px) never ships. Transforms/border widths format elsewhere.
const fmtPx = (n: number): string => `${(Math.abs(n - Math.round(n)) < 0.1 ? Math.round(n) : Math.round(n * 10) / 10)}px`;
const viewportHeightFor = (vp: number): number => CAPTURE_VIEWPORT_HEIGHTS[vp] ?? Math.round(vp * 0.66);

type GeometryPlan = {
  heightByVp?: Record<number, string>;
  aspectByVp?: Record<number, string>;
  leftByVp?: Record<number, string>;
  topByVp?: Record<number, string>;
};
const GEOMETRY_NONE: GeometryPlan = {};

function cleanPct(n: number): number {
  return Math.round(n * 2) / 2;
}

function snapAspectRatio(ratio: number): { value: string; ratio: number } | null {
  const candidates: Array<[number, number]> = [
    [1, 1], [4, 3], [3, 2], [8, 5], [16, 9], [5, 4], [2, 1],
    [3, 4], [2, 3], [9, 16],
  ];
  for (const [w, h] of candidates) {
    const r = w / h;
    if (Math.abs(ratio - r) <= 0.025) return { value: `${w} / ${h}`, ratio: r };
  }
  const rounded = Math.round(ratio * 1000) / 1000;
  if (!(rounded > 0.1 && rounded < 10)) return null;
  return { value: String(rounded), ratio: rounded };
}

/** Content-box width of `node`'s containing block at `vp`: the parent's content box for an
 *  in-flow box, or the viewport for the root (`<body>`, whose containing block is `<html>`/
 *  the initial containing block). Returns null when not measurable. */
function containingWidthAt(node: IRNode, parentNode: IRNode | undefined, vp: number): number | null {
  if (!parentNode) return vp; // root: % / auto resolve against the viewport width
  const pcs = parentNode.computedByVp[vp]; const pb = parentNode.bboxByVp[vp];
  if (!pcs || !pb) return null;
  const w = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
  return w > 0 ? w : null;
}

/** Decide a node's width treatment from its per-viewport samples. Three relative forms, each
 *  proven against ALL sampled viewports so it reproduces the captured px exactly:
 *   (a) centred max-width container (`max-width:W; margin:0 auto`) → width:auto + auto margins
 *       at every width, so it stays centred on any monitor instead of freezing at the widest
 *       captured band's margins;
 *   (b) a block that fills its container's content width at every width → width:auto (the
 *       block default) so it tracks a fluid ancestor instead of a baked px;
 *   (c) a stable fractional width (`width:N%`) → emit the percentage.
 *  Conservative by construction: only fires for in-flow, block-level, non-(flex/grid-item)
 *  boxes, and (b)/(c) require the px to actually VARY across viewports (an authored-fixed px
 *  cannot track a varying container), so a genuinely fixed width is never converted. */
function planWidth(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): { plan: WidthPlan; centerAlways: boolean } {
  const none = { plan: PLAN_FIXED, centerAlways: false };
  // Replaced/custom elements size to intrinsic dimensions under auto/%, not the container.
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return none;

  type Sample = { w: number; bw: number; cw: number; ml: number; mr: number; maxW: number | null; gapL: number; gapR: number; borderBox: boolean; visible: boolean };
  const samples: Sample[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb) continue;
    // A viewport where the node (or its containing block) is display:none / zero-box contributes no
    // geometry: its computed box is 0×0, margins report the unresolved `auto`, and the containing width
    // is 0. Skip it rather than bailing the whole inference — a container hidden at some breakpoints can
    // still be provably centred at the widths where it IS painted (judged over the visible samples below).
    const paintedHere = !!node.visibleByVp[vp] && nb.width > 0;
    if (!paintedHere) continue;
    // Block-LEVEL, in-flow only: margin-auto centring and auto/100% fill apply to these; an
    // inline / inline-block / flex-item box is positioned differently, so bail conservatively.
    if (!/^(block|flow-root|list-item|flex|grid)$/.test(cs.display || "")) return none;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return none;
    if ((cs.float || "none") !== "none") return none; // float + width:auto shrink-wraps, not fills
    const pdisp = parentNode?.computedByVp[vp]?.display || "";
    if (/(?:^|-)(?:flex|grid)$/.test(pdisp)) return none; // flex/grid item — parent layout owns sizing
    const w = pf(cs.width); const cw = containingWidthAt(node, parentNode, vp);
    if (!(w > 0) || cw == null) return none;
    let cl: number, cr: number;
    if (parentNode) {
      const pcs = parentNode.computedByVp[vp]!; const pb = parentNode.bboxByVp[vp]!;
      cl = pb.x + pf(pcs.paddingLeft) + pf(pcs.borderLeftWidth);
      cr = pb.x + pb.width - pf(pcs.paddingRight) - pf(pcs.borderRightWidth);
    } else { cl = 0; cr = vp; }
    const maxW = cs.maxWidth && cs.maxWidth.endsWith("px") ? pf(cs.maxWidth) : null;
    samples.push({
      w, bw: nb.width, cw, ml: pf(cs.marginLeft), mr: pf(cs.marginRight), maxW,
      gapL: nb.x - cl, gapR: cr - (nb.x + nb.width), borderBox: (cs.boxSizing || "border-box") !== "content-box",
      visible: !!node.visibleByVp[vp] && nb.width > 0,
    });
  }
  if (samples.length < 2) return none;

  const close = (a: number, b: number, abs: number, pct: number): boolean => Math.abs(a - b) <= Math.max(abs, pct * Math.max(Math.abs(a), Math.abs(b)));
  const span = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
  const zeroMargins = samples.every((s) => Math.abs(s.ml) <= 1.5 && Math.abs(s.mr) <= 1.5);

  // (a) Centred max-width container: border-box, a px max-width cap AT EVERY sample, and every
  // sample's border box equals min(containerWidth, cap) — filling when narrower than the cap, centred
  // (symmetric positive gaps) when wider. Reproduces `margin:0 auto` centring with a per-viewport cap.
  // The cap need NOT be a single constant: a fluid `max-width: min(Wpx, 100vw − 2·gutter)` resolves to
  // a DIFFERENT px per width (e.g. 311/673/1145/1272), so requiring a constant cap wrongly rejected the
  // commonest centred container and left it PLAN_FIXED with literal per-band `mx-*` (off-centre at any
  // non-captured width). We accept per-viewport caps and let the normal per-band `max-width` emission
  // carry them; `mx-auto` (from centerAlways) then centres at EVERY width. Fidelity is preserved
  // because each sample's `min(cw, maxW_vp)` reproduces the captured box exactly at that width. The
  // `sawCenter` requirement below is the load-bearing guard: a box that merely FILLS (never shows
  // symmetric free-space gaps) is NOT proven centred and stays PLAN_FIXED with its literal margins.
  // A display:none / zero-box sample has no geometry to prove centring against (its computed box is
  // 0×0 and its margins report the unresolved `auto`). Judge case (a) only over the VISIBLE samples —
  // a container centred wherever it is actually painted is centred everywhere via `mx-auto`, even if it
  // is hidden at some breakpoints. (≥2 visible samples still required so the inference has evidence.)
  const vis = samples.filter((s) => s.visible);
  if (vis.length >= 2 && vis.every((s) => s.maxW != null && s.borderBox)) {
    let ok = true;
    let sawCenter = false;
    for (const s of vis) {
      if (!close(s.bw, Math.min(s.cw, s.maxW!), 1.5, 0.01)) { ok = false; break; }
      if (s.cw > s.maxW! + 4) { // room to centre — must actually be centred, not left-aligned
        if (s.gapL > 1 && s.gapR > 1 && Math.abs(s.gapL - s.gapR) <= 1.5) sawCenter = true;
        else { ok = false; break; }
      }
    }
    if (ok && sawCenter) return { plan: { kind: "auto" }, centerAlways: true };
  }

  // (b) Fills its container: border box == container content width at every (varying) width and
  // no horizontal margins → it was authored width:auto/100%. Emit auto so it tracks the container.
  if (zeroMargins && span(samples.map((s) => s.bw)) > 8 && samples.every((s) => close(s.bw, s.cw, 1.5, 0.01))) {
    return { plan: { kind: "auto" }, centerAlways: false };
  }

  // (c) Stable fraction of the container (width:N%): own width / container width ~constant in
  // (0,1) across viewports whose px actually varies, no horizontal margins.
  if (zeroMargins && span(samples.map((s) => s.w)) > 8) {
    const ratios = samples.map((s) => s.w / s.cw);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (mean > 0.04 && mean < 0.985 && span(ratios) <= 0.006) {
      return { plan: { kind: "percent", pct: `${Math.round(mean * 1e5) / 1e3}%` }, centerAlways: false };
    }
  }

  return none;
}

/** Parse a computed grid track list ("284.5px 284.5px 284.5px", possibly with `[line-name]`
 *  groups) into px numbers; null if any token is not a px length (getComputedStyle resolves
 *  fr/auto/min-content/minmax to used px, so a non-px token means something we can't model). */
function parseTracks(v: string | undefined): number[] | null {
  if (!v || v === "none") return null;
  const toks = v.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const out: number[] = [];
  for (const t of toks) { if (!/^-?\d+(?:\.\d+)?px$/.test(t)) return null; out.push(parseFloat(t)); }
  return out;
}

/** Re-express a grid container's computed (px-resolved) `grid-template-columns` as a fluid
 *  template — `fr` for tracks that scale with the container, `px` for genuinely fixed tracks —
 *  so the grid (and the items its tracks size) tracks the window instead of freezing at baked
 *  px. getComputedStyle reports `repeat(3,1fr)` as `"284px 284px 284px"`, which the engine
 *  bakes; unlike flex, grid items have no shrink fallback, so they pin to those px.
 *
 *  Returns a per-viewport map of the fluid template (or null if nothing is recoverable). The
 *  column count may CHANGE across widths (a responsive `grid-cols-3 → grid-cols-6` breakpoint):
 *  we group the sampled widths by track count and solve the `fr` template independently within
 *  each regime, so each regime collapses its baked-px tracks to one fluid template (the per-width
 *  px variation inside a regime stops spawning bands) while the real column-count change stays a
 *  single honest band. A regime is recovered only when its `fr` model PROVABLY reproduces every
 *  captured track in it; otherwise those widths keep their baked px. */
function frTemplate(samples: { tracks: number[]; gap: number; content: number }[], n: number): string | null {
  if (samples.length < 2 || n < 1) return null;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const span = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  // The fr model only holds when the tracks + gaps fill the container.
  for (const s of samples) if (Math.abs(sum(s.tracks) + (n - 1) * s.gap - s.content) > Math.max(2, 0.01 * s.content)) return null;
  const fixed: boolean[] = [];
  for (let i = 0; i < n; i++) { const col = samples.map((s) => s.tracks[i]!); fixed[i] = span(col) <= Math.max(1.5, 0.01 * Math.max(...col)); }
  if (fixed.every(Boolean)) return null; // intentionally fixed grid — keep baked (correctly fixed)
  // Each fluid track must hold a CONSTANT share of the free space left after fixed tracks + gaps
  // (the defining property of an fr track). Otherwise it isn't a clean fr and we bail.
  const free = samples.map((s) => s.content - (n - 1) * s.gap - sum(s.tracks.filter((_, i) => fixed[i])));
  if (free.some((f) => f <= 0)) return null;
  const share: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (fixed[i]) continue;
    const shares = samples.map((s, k) => s.tracks[i]! / free[k]!);
    if (span(shares) > 0.01) return null;
    share[i] = shares.reduce((a, b) => a + b, 0) / shares.length;
  }
  const sumShare = sum(share);
  const minFluid = Math.min(...share.filter((_, i) => !fixed[i]));
  // Verify the fr distribution reproduces every captured track within tolerance before committing.
  for (let k = 0; k < samples.length; k++) {
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const predicted = free[k]! * (share[i]! / sumShare);
      if (Math.abs(predicted - samples[k]!.tracks[i]!) > Math.max(1.5, 0.01 * samples[k]!.tracks[i]!)) return null;
    }
  }
  const last = samples[samples.length - 1]!;
  // A "fixed" track that resolves to ~0px is an EMPTY content (`auto`) track, not an authored 0px
  // column — the source's `grid-cols-[1fr_auto]` where the second track currently holds nothing.
  // Emit `auto` (renders identically to 0px here, but reads as the authored rule and grows if content
  // ever appears) instead of the bug-looking `0px`. A genuinely fixed non-zero px track stays px.
  return share.map((sh, i) => fixed[i] ? (Math.abs(last.tracks[i]!) < 0.5 ? "auto" : `${Math.round(last.tracks[i]! * 100) / 100}px`) : `${Math.round((sh / minFluid) * 1000) / 1000}fr`).join(" ");
}

/** Per-viewport fluid `grid-template-columns`. A responsive grid usually keeps its tracks fluid
 *  (`repeat(N, 1fr)`) and changes the COLUMN COUNT at breakpoints (4 → 3 → 2) — between breakpoints
 *  the columns shrink with the window, then one rolls over. The engine bakes each width's resolved
 *  px (`grid-cols-[300px_300px_300px_300px]`), which freezes the columns so they JUMP at breakpoints
 *  instead of shrinking. We group the sampled widths by column count and solve each regime
 *  independently: an equal-track regime becomes `repeat(N, minmax(0,1fr))` (Tailwind `grid-cols-N`),
 *  a mixed fixed+fluid regime keeps its solved `fr` template. Returns a vp→template map so each
 *  breakpoint band emits its own count (the per-width px collapse to one fluid rule per regime, and
 *  1fr reproduces the captured px exactly — gate-neutral — while restoring the smooth shrink). */
/** Which columns of a grid are CONTENT-sized (`auto`), provable from the sizing probe. For each track
 *  we find the in-flow grid cell that starts at that track's x-offset and compare the track width to
 *  the cell's max-content (`wMax`): if they match at EVERY given viewport, the track sizes to its
 *  content → `auto` (the source's authored value), not a baked px. An auto track renders identically
 *  to its captured px (content == wMax) but reads as the rule and drops the decimal. Returns a per-
 *  track boolean mask; all-false (so a no-op) when there's no probe data, a track has no matching
 *  single-column cell, or the cell content doesn't fill the track (a genuinely fixed px column). */
function gridAutoTrackMask(node: IRNode, vps: number[], count: number): boolean[] {
  const mask = new Array<boolean>(count).fill(true);
  let any = false;
  for (const vp of vps) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const tracks = cs ? parseTracks(cs.gridTemplateColumns) : null;
    if (!cs || !nb || !tracks || tracks.length !== count) return new Array<boolean>(count).fill(false);
    const gap = pf(cs.columnGap && cs.columnGap !== "normal" ? cs.columnGap : cs.gap);
    let x = nb.x + pf(cs.paddingLeft) + pf(cs.borderLeftWidth);
    const starts = tracks.map((t) => { const s = x; x += t + gap; return s; });
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      let cellWMax: number | undefined;
      for (const c of node.children) {
        if (isTextChild(c)) continue;
        const ccs = c.computedByVp[vp]; const cb = c.bboxByVp[vp];
        if (!ccs || !cb || !c.visibleByVp[vp] || (ccs.display || "") === "none") continue;
        if (ccs.position === "absolute" || ccs.position === "fixed") continue; // out of flow
        if (Math.abs(cb.x - starts[i]!) <= 2) { cellWMax = c.sizingByVp?.[vp]?.wMax; break; }
      }
      if (cellWMax === undefined || Math.abs(tracks[i]! - cellWMax) > Math.max(1.5, 0.02 * tracks[i]!)) mask[i] = false;
      else any = true;
    }
  }
  return any ? mask : new Array<boolean>(count).fill(false);
}

function fluidGridColumns(node: IRNode, viewports: number[]): Map<number, string> | null {
  // A SINGLE fixed-px grid track that FILLS its container at every sampled viewport is a full-bleed
  // fill column baked as `grid-cols-[Npx]` (a full-viewport hero carousel `uwp-carousel` with one
  // track = the viewport width, re-baked per breakpoint). It freezes at the nearest band's px, so the
  // grid — and everything it lays out — over-widens at any unsampled width (the splide02 hero measuring
  // 768px inside a 572px window: the whole hero subtree inherits the frozen track). Re-express the lone
  // track as `minmax(0,1fr)` (fills, reproduces the captured px exactly — gate-neutral). This is proven
  // purely from the box geometry (track == content), so it is safe even on a REPLACED/custom-element
  // grid, which the general solver below (it walks children) correctly still skips.
  {
    const filled: { vp: number; content: number }[] = [];
    for (const vp of viewports) {
      const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
      if (!cs || !nb) continue;
      if (!/^(grid|inline-grid)$/.test(cs.display || "")) continue;
      const tracks = parseTracks(cs.gridTemplateColumns);
      if (!tracks || tracks.length !== 1) { filled.length = 0; break; }        // must be single-track at EVERY grid vp
      const gap = pf(cs.columnGap && cs.columnGap !== "normal" ? cs.columnGap : cs.gap);
      if (gap !== 0) { filled.length = 0; break; }
      const content = nb.width - pf(cs.paddingLeft) - pf(cs.paddingRight) - pf(cs.borderLeftWidth) - pf(cs.borderRightWidth);
      if (content <= 0) { filled.length = 0; break; }
      if (Math.abs(tracks[0]! - content) > Math.max(1.5, 0.01 * content)) { filled.length = 0; break; } // track must FILL
      filled.push({ vp, content });
    }
    if (filled.length >= 2) {
      const m = new Map<number, string>();
      for (const f of filled) m.set(f.vp, "minmax(0, 1fr)");
      return m;
    }
  }
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  type S = { vp: number; tracks: number[]; gap: number; content: number };
  // Replace a solved template's fixed `Npx` tracks with `auto` where the column provably sizes to its
  // cell's content (gridAutoTrackMask) — matches the source's `auto` and drops the decimal px.
  const withAuto = (tmpl: string, grp: { vp: number; tracks: number[] }[]): string => {
    const toks = tmpl.split(/\s+/);
    if (toks.length !== grp[0]!.tracks.length) return tmpl; // repeat()/auto-fit forms — leave alone
    const mask = gridAutoTrackMask(node, grp.map((s) => s.vp), toks.length);
    if (!mask.some(Boolean)) return tmpl;
    return toks.map((t, i) => (mask[i] && /px$/.test(t)) ? "auto" : t).join(" ");
  };
  const perVp: S[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb) continue;
    if (!/^(grid|inline-grid)$/.test(cs.display || "")) continue;   // skip non-grid widths, don't bail
    const tracks = parseTracks(cs.gridTemplateColumns);
    if (!tracks || tracks.length < 1) continue;
    const gapRaw = cs.columnGap && cs.columnGap !== "normal" ? cs.columnGap : cs.gap;
    const content = nb.width - pf(cs.paddingLeft) - pf(cs.paddingRight) - pf(cs.borderLeftWidth) - pf(cs.borderRightWidth);
    if (content <= 0) continue;
    perVp.push({ vp, tracks, gap: pf(gapRaw), content });
  }
  if (perVp.length < 2) return null;
  // FIRST try the idiomatic auto-fit grid: a SINGLE `repeat(auto-fit, minmax(MIN, 1fr))` that
  // reproduces the column COUNT at every captured width — columns shrink (1fr) then roll over when
  // they'd fall below MIN. Valid only when every sample has equal tracks and one MIN satisfies
  // floor((content+gap)/(MIN+gap)) = count everywhere; the per-sample MIN windows must intersect.
  // A genuinely breakpoint-driven grid (counts that no single MIN explains) fails this and falls
  // through to the per-regime grid-cols-N below, so auto-fit never mis-fires.
  const everyEqual = perVp.every((s) => Math.max(...s.tracks) - Math.min(...s.tracks) <= Math.max(1.5, 0.02 * Math.max(...s.tracks)));
  const countsSeen = new Set(perVp.map((s) => s.tracks.length));
  if (everyEqual && countsSeen.size >= 2) { // count must actually CHANGE — else it's a fixed grid-cols-N, not a rollover
    let lo = 0, hi = Infinity;
    for (const s of perVp) {
      const N = s.tracks.length, C = s.content, g = s.gap;
      lo = Math.max(lo, (C + g) / (N + 1) - g);   // need < N+1 cols ⇒ MIN strictly above this
      hi = Math.min(hi, (C + g) / N - g);          // need ≥ N cols ⇒ MIN at or below this
    }
    if (lo + 0.5 < hi) {
      const minCol = Math.min(...perVp.flatMap((s) => s.tracks)); // the column width just before rollover ≈ authored MIN
      // Leave a little room below the theoretical upper bound. Some real source grids sit exactly
      // at the rollover threshold at a captured viewport; emitting that exact min can wrap a card at
      // intermediate/browser-rounded widths even though the source stayed in the larger column count.
      const MIN = Math.max(1, Math.floor(Math.min(Math.max(minCol, lo + 0.5), hi - 0.5)));
      const tmpl = `repeat(auto-fit, minmax(${MIN}px, 1fr))`;
      const result = new Map<number, string>();
      for (const s of perVp) result.set(s.vp, tmpl);
      return result;
    }
  }
  const byCount = new Map<number, S[]>();
  for (const s of perVp) { const c = s.tracks.length; const g = byCount.get(c); if (g) g.push(s); else byCount.set(c, [s]); }
  const result = new Map<number, string>();
  for (const [count, samples] of byCount) {
    // Every sample in the regime has ~equal tracks ⇒ a candidate `repeat(N, 1fr)`. (1fr divides the
    // container content evenly, reproducing the equal baked px at each captured width.)
    const allEqual = samples.every((s) => Math.max(...s.tracks) - Math.min(...s.tracks) <= Math.max(1.5, 0.02 * Math.max(...s.tracks)));
    // `repeat(N,1fr)` divides the CONTAINER content among the tracks — valid only when the tracks +
    // gaps actually FILL the container (the same fill law frTemplate enforces before solving an fr
    // model). A fixed-track scrolling list (`overflow-x:auto` with `grid-cols-[173.5px…]` × 50 summing
    // to 8675px inside a 1066px container) has equal tracks too, but rewriting it as `repeat(50,1fr)`
    // shrinks every slide to viewport/50 and kills the horizontal scroll. When the equal tracks
    // OVERFLOW the container, keep the baked fixed-px template (fall through, leaving these vps unset).
    const fillsContainer = samples.every((s) => Math.abs(s.tracks.reduce((a, b) => a + b, 0) + (count - 1) * s.gap - s.content) <= Math.max(2, 0.01 * s.content));
    const tmpl = (allEqual && fillsContainer) ? `repeat(${count}, minmax(0, 1fr))` : (samples.length >= 2 ? frTemplate(samples, count) : null);
    if (tmpl) { const t2 = withAuto(tmpl, samples); for (const s of samples) result.set(s.vp, t2); continue; }
    // Rescue a MIXED-track regime where frTemplate bailed only because the column PROPORTIONS
    // change at a breakpoint — the ridge footer signup grid is 70/30 (`2.333fr 1fr`) at ≥768 but
    // 60/40 at 375, so one fr model can't span all four widths. Partition the regime by its
    // proportional signature and solve each sub-regime that has ≥2 samples on its own; frTemplate
    // re-verifies reproduction within each, so a wrong split can NEVER emit (it just bails to baked).
    // Single-sample sub-regimes (an isolated mobile width) stay baked — one width can't prove an fr.
    if (allEqual || samples.length < 2) continue;
    const byShare = new Map<string, S[]>();
    for (const s of samples) {
      const total = s.tracks.reduce((a, b) => a + b, 0);
      const sig = total > 0 ? s.tracks.map((t) => Math.round((t / total) * 20) / 20).join("_") : "x";
      const g = byShare.get(sig); if (g) g.push(s); else byShare.set(sig, [s]);
    }
    for (const grp of byShare.values()) {
      if (grp.length < 2) continue;
      const t = frTemplate(grp, count);
      if (t) { const t2 = withAuto(t, grp); for (const s of grp) result.set(s.vp, t2); }
    }
    // Content-classification rescue: label each column `auto` (provably content-sized — its cell's
    // max-content fills the track) or fluid, and group widths by that signature. This handles a grid
    // whose FLUID column moves position across a breakpoint: `1fr auto auto` below lg
    // (logo column is the spacer) and `auto 1fr auto` at/above it (center column is the spacer) —
    // including the mobile regime the px-only frTemplate can't fit (two columns vary because an auto
    // column's content reflows). For a signature with exactly ONE non-auto column that VARIES with the
    // container while the grid fills its container, emit `auto`/`1fr` directly: the auto columns
    // reproduce their content, the single fluid column absorbs the rest. Verifiable, matches source.
    {
      const byAuto = new Map<string, S[]>();
      for (const s of samples) {
        if (result.has(s.vp)) continue;
        const sig = gridAutoTrackMask(node, [s.vp], count).map((b) => b ? "a" : "f").join("");
        const g = byAuto.get(sig); if (g) g.push(s); else byAuto.set(sig, [s]);
      }
      for (const [sig, grp] of byAuto) {
        if (grp.length < 2) continue;
        const frIdx: number[] = []; for (let i = 0; i < count; i++) if (sig[i] === "f") frIdx.push(i);
        if (frIdx.length !== 1) continue;                  // exactly one fluid (spacer) column
        const fi = frIdx[0]!; const frVals = grp.map((s) => s.tracks[fi]!);
        if (Math.max(...frVals) - Math.min(...frVals) <= Math.max(2, 0.02 * Math.max(...frVals))) continue; // a constant non-auto column is fixed px, not fr
        if (grp.some((s) => Math.abs(s.tracks.reduce((a, b) => a + b, 0) + (count - 1) * s.gap - s.content) > Math.max(2, 0.01 * s.content))) continue; // grid must fill its container
        const tmpl = Array.from({ length: count }, (_, i) => i === fi ? "1fr" : "auto").join(" ");
        for (const s of grp) result.set(s.vp, tmpl);
      }
    }
    // Final rescue: the FLUID track changes POSITION across a breakpoint: `1fr auto auto`
    // below lg (the spacer is track 0) and `auto 1fr auto` at/above it (the spacer
    // moves to track 1). The proportional partition above can't cluster these (the fill track's share
    // of the container varies continuously), so partition instead by WHICH track is the LARGEST — the
    // fill track absorbs the free space, so it is ≈ the widest — and solve each group with frTemplate,
    // which re-verifies reproduction at every width (a wrong grouping just bails to baked). Skip widths
    // a prior rescue already solved. This collapses the per-breakpoint baked-px pile to one `…1fr…`
    // template per regime, so the nav flows on resize instead of jumping at each band.
    const byFill = new Map<number, S[]>();
    for (const s of samples) {
      if (result.has(s.vp)) continue;
      let mi = 0; for (let i = 1; i < s.tracks.length; i++) if (s.tracks[i]! > s.tracks[mi]!) mi = i;
      const g = byFill.get(mi); if (g) g.push(s); else byFill.set(mi, [s]);
    }
    if (byFill.size < 1) continue;
    for (const grp of byFill.values()) {
      if (grp.length < 2) continue;
      const t = frTemplate(grp, count);
      if (t) { const t2 = withAuto(t, grp); for (const s of grp) result.set(s.vp, t2); }
    }
  }
  return result.size ? result : null;
}

/** Per-viewport fluid `grid-template-rows`. Deliberately NARROWER than `fluidGridColumns`: grid
 *  COLUMNS fill the container width (always definite), so a baked column track is almost always a
 *  fluid `fr`; grid ROWS are content-sized by default and the container's height is usually
 *  indefinite, so a baked `grid-rows-[Npx]` is most often a frozen *content* height that belongs to
 *  the height path, not an `fr`. We re-express ONLY the safe case: an EQUAL multi-track regime whose
 *  tracks fill the container's content HEIGHT under normal/stretch packing, on a grid that is
 *  actually responsive (its row count OR row size changes across viewports — the `fr` signature, the
 *  same "must vary" bar `frTemplate` applies to columns). Equal tracks summing to the content height
 *  are already an even split, so `repeat(N, minmax(0,1fr))` reproduces them EXACTLY at each captured
 *  height WITHOUT changing the container's height (the rows still total the same) — gate-neutral, no
 *  vertical cascade. Unequal tracks (differing content rows), single-track rows (a frozen content
 *  height), and fully-constant equal rows (an ambiguous authored-fixed grid) are left baked. The row
 *  count may change across breakpoints (a card grid rewrapping 3→4→6 rows); we group by count and
 *  emit one `grid-rows-N` per regime as a band. */
function fluidGridRows(node: IRNode, viewports: number[]): Map<number, string> | null {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  // A subgrid's row tracks are INHERITED from the parent grid, not independent sizes —
  // getComputedStyle resolves `subgrid` to the parent's px, so a viewport where this node is subgrid
  // looks like ordinary (often coincidentally-equal) px tracks. Re-expressing those as `1fr` severs
  // the inheritance and forces an even split the parent never had. If the node is subgrid at ANY
  // sampled width, it's a subgrid element everywhere — leave its rows alone.
  if (viewports.some((vp) => /subgrid/.test(node.computedByVp[vp]?.gridTemplateRows || ""))) return null;
  type S = { vp: number; tracks: number[] };
  const ok: S[] = [];
  let singleRowRegime = false;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb) continue;
    if (!/^(grid|inline-grid)$/.test(cs.display || "")) continue;   // skip non-grid widths, don't bail
    const tracks = parseTracks(cs.gridTemplateRows);
    if (!tracks) continue;                                          // subgrid/auto/fr/non-px — not a baked px regime
    // A baked SINGLE row is often carrying an authored/media height. Replacing it with `1fr` is only
    // safe when some other declaration already confers the same definite height; collectNodeRules
    // does not currently thread that fact into this helper, so leave single-row grids baked.
    if (tracks.length < 2) { singleRowRegime = true; continue; }
    // `align-content` must not inject free space between the tracks (space-*/center/start/end leave
    // gaps that `1fr` would absorb); only normal/stretch packs the tracks so they fill the box.
    if (!/^(normal|stretch)$/.test(cs.alignContent || "normal")) continue;
    const rowGap = cs.rowGap && cs.rowGap !== "normal" ? cs.rowGap : cs.gap;
    const contentH = nb.height - pf(cs.paddingTop) - pf(cs.paddingBottom) - pf(cs.borderTopWidth) - pf(cs.borderBottomWidth);
    if (contentH <= 0) continue;
    const sum = tracks.reduce((a, b) => a + b, 0) + (tracks.length - 1) * pf(rowGap);
    if (Math.abs(sum - contentH) > Math.max(2, 0.01 * contentH)) continue;   // tracks must fill the content box
    // Equal tracks only — an even split is exactly what `1fr` reproduces. UNEQUAL rows at ANY width
    // prove the rows are content-driven (cards of differing height), so an equal-rows regime at a
    // OTHER width is just coincidental content, not an `fr` structure: bail entirely and keep the
    // whole grid's rows baked.
    if (Math.max(...tracks) - Math.min(...tracks) > Math.max(1.5, 0.02 * Math.max(...tracks))) return null;
    ok.push({ vp, tracks });
  }
  if (singleRowRegime || ok.length < 1) return null;   // wrapping/collapsing grid — not a stable tile grid
  // The `fr` signature: a genuinely responsive grid changes its row COUNT or row SIZE across the
  // captured widths. A grid whose equal rows are identical at every width is an ambiguous
  // authored-fixed candidate (in an indefinite-height container `1fr` would collapse to content) —
  // leave it baked.
  const counts = new Set(ok.map((s) => s.tracks.length));
  const sizes = new Set(ok.map((s) => Math.round(s.tracks[0]!)));
  if (counts.size < 2 && sizes.size < 2) return null;
  const result = new Map<number, string>();
  for (const s of ok) result.set(s.vp, `repeat(${s.tracks.length}, minmax(0, 1fr))`);
  return result;
}

/** A single-row grid whose height comes from a recovered height/aspect law can use the authored
 * `1fr` row again. Without the definite-height law this is unsafe: an indefinite one-row grid
 * collapses to content and loses the media frame height. */
function singleFluidGridRow(node: IRNode, viewports: number[]): Map<number, string> | null {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  const result = new Map<number, string>();
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!/^(grid|inline-grid)$/.test(cs.display || "")) return null;
    const tracks = parseTracks(cs.gridTemplateRows);
    if (!tracks || tracks.length !== 1) return null;
    const rowGap = cs.rowGap && cs.rowGap !== "normal" ? cs.rowGap : cs.gap;
    const contentH = nb.height - pf(cs.paddingTop) - pf(cs.paddingBottom) - pf(cs.borderTopWidth) - pf(cs.borderBottomWidth);
    if (contentH <= 0 || pf(rowGap) !== 0) return null;
    if (Math.abs(tracks[0]! - contentH) > Math.max(1.5, 0.01 * contentH)) return null;
    result.set(vp, "repeat(1, minmax(0, 1fr))");
    painted++;
  }
  return painted >= 2 ? result : null;
}

/** A large structural/media box whose captured height is a viewport-height expression with a lower
 * and/or upper clamp. Cursor's demo frames are the canonical example: every sampled height equals
 * `clamp(MIN, 70vh, MAX)`, but the engine only sees the resolved px row height. */
function viewportHeightLaw(node: IRNode, viewports: number[]): Record<number, string> | null {
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return null;
  const samples: Array<{ vp: number; h: number; vh: number }> = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return null;
    const h = nb.height;
    if (!(h >= 120)) return null;
    samples.push({ vp, h, vh: viewportHeightFor(vp) });
  }
  if (samples.length < 2) return null;
  const hs = samples.map((s) => s.h);
  if (Math.max(...hs) - Math.min(...hs) <= 8) return null;
  // Keep this on structural/media boxes. Text-heavy boxes are too likely to be content-height.
  if (node.children.some((c) => isTextChild(c) && c.text.trim())) return null;

  const minH = Math.min(...hs);
  const maxH = Math.max(...hs);
  const pctCandidates = new Set<number>();
  for (const s of samples) {
    if (s.h > minH + 1) pctCandidates.add(cleanPct((s.h / s.vh) * 100));
  }
  for (const pct of pctCandidates) {
    if (!(pct >= 20 && pct <= 100)) continue;
    const css = `clamp(${fmtPx(minH)}, ${pct}vh, ${fmtPx(maxH)})`;
    const ok = samples.every((s) => {
      const predicted = Math.max(minH, Math.min(maxH, s.vh * pct / 100));
      return Math.abs(predicted - s.h) <= Math.max(1.5, 0.01 * s.h);
    });
    if (!ok) continue;
    const out: Record<number, string> = {};
    for (const s of samples) out[s.vp] = css;
    return out;
  }
  return null;
}

/** A media/card frame whose height is derived from its width by aspect-ratio, optionally capped by
 * max-height. Emits an aspect-ratio law and drops the baked height/grid-row px. Per-viewport ratios
 * are allowed because responsive designs often switch aspect by breakpoint. */
function aspectHeightLaw(node: IRNode, viewports: number[]): Record<number, string> | null {
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return null;
  type S = { vp: number; w: number; h: number; maxH: number; ratio?: { value: string; ratio: number } };
  const samples: S[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return null;
    if (!(nb.width > 0 && nb.height > 0)) return null;
    if (node.children.some((c) => isTextChild(c) && c.text.trim())) return null;
    const maxH = cs.maxHeight && cs.maxHeight !== "none" ? pf(cs.maxHeight) : Infinity;
    const unclamped = !Number.isFinite(maxH) || nb.height < maxH - 1.5;
    samples.push({ vp, w: nb.width, h: nb.height, maxH, ratio: unclamped ? snapAspectRatio(nb.width / nb.height) ?? undefined : undefined });
  }
  if (samples.length < 2) return null;
  if (!samples.some((s) => s.ratio)) return null;
  const ratios = [...new Map(samples.filter((s) => s.ratio).map((s) => [s.ratio!.value, s.ratio!])).values()];
  const out: Record<number, string> = {};
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const ordered = [
      s.ratio,
      ...ratios.sort((a, b) => Math.abs((samples.findIndex((x) => x.ratio?.value === a.value) - i)) - Math.abs((samples.findIndex((x) => x.ratio?.value === b.value) - i))),
    ].filter((x): x is { value: string; ratio: number } => !!x);
    let chosen: { value: string; ratio: number } | undefined;
    for (const r of ordered) {
      const predicted = Math.min(s.w / r.ratio, s.maxH);
      if (Math.abs(predicted - s.h) > Math.max(1.5, 0.01 * s.h)) continue;
      // Aspect-ratio + max-height also transfers into a max-WIDTH: per CSS transferred sizing, a box
      // with `aspect-ratio:R` and `max-height:M` cannot exceed `R × M` wide (the height cap back-computes
      // a width cap). The height-only check above accepts any ratio that makes min(w/R, M) ≈ h at a
      // clamped viewport, but a ratio whose transferred max-width (R × M) is narrower than the measured
      // box would clamp the clone's width below the source (a 1.66:1 box forced square to its 420px cap).
      // Require the measured width to fit under the transferred cap at every clamped sample.
      if (Number.isFinite(s.maxH) && s.w > r.ratio * s.maxH + Math.max(1.5, 0.01 * s.w)) continue;
      chosen = r; break;
    }
    if (!chosen) return null;
    out[s.vp] = chosen.value;
  }
  // Must remove a real baked dimension/band: either height varies, or the aspect ratio changes.
  const hs = samples.map((s) => s.h);
  if (Math.max(...hs) - Math.min(...hs) <= 8 && new Set(Object.values(out)).size < 2) return null;
  return out;
}

/** A lottie mount box: the container the runtime player re-mounts its svg/canvas into. The player
 * sizes that svg by the animation's aspect at the container's width, so without a pinned height the
 * mount inflates to the aspect height (overlapping neighbours). Treat it as replaced-like — pin the
 * captured per-viewport border-box height (the source-constrained size) so the aspect-fit svg fills
 * a definite box. Per viewport, like img/video height emission. */
function lottieMountHeight(node: IRNode, viewports: number[]): Record<number, string> | null {
  const out: Record<number, string> = {};
  let any = false;
  for (const vp of viewports) {
    const nb = node.bboxByVp[vp];
    if (!nb || !node.visibleByVp[vp] || (node.computedByVp[vp]?.display || "") === "none") continue;
    if (!(nb.height > 0)) continue;
    out[vp] = fmtPx(nb.height);
    any = true;
  }
  return any ? out : null;
}

function mediaHeightGeometry(node: IRNode, viewports: number[]): Pick<GeometryPlan, "heightByVp" | "aspectByVp"> {
  const heightByVp = viewportHeightLaw(node, viewports);
  if (heightByVp) return { heightByVp };
  const aspectByVp = aspectHeightLaw(node, viewports);
  if (aspectByVp) return { aspectByVp };
  return {};
}

/** A grid item whose width is determined by its (now-fluid) track span, so the baked px is
 *  redundant and freezes it. True when the parent is a grid at every width, the item is in-flow
 *  and stretches to fill its track (the default), and its width actually VARIES across widths
 *  (proving it's track-driven, not a fixed/min-content item). Dropping the width then lets the
 *  fluid tracks size it; at the captured widths it resolves to the same px (gate-neutral). */
function isGridItemFill(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    if (!cs || !pcs) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue; // not painted here → no width to judge
    if (!/^(grid|inline-grid)$/.test(pcs.display || "")) return false;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    // Item must stretch to fill its track (default). justify-self:auto defers to the grid's
    // justify-items; a center/start/end on either shrink-wraps the item to content instead.
    const js = cs.justifySelf || "auto";
    const effective = js === "auto" || js === "normal" ? (pcs.justifyItems || "normal") : js;
    if (!/^(normal|stretch|legacy|auto)$/.test(effective)) return false;
    const w = pf(cs.width); if (!(w > 0)) return false;
    widths.push(w);
  }
  // The justify-items:stretch check above guarantees the item fills its track, so its width is
  // track-driven and `width:auto` reproduces it — whether or not the track px varies. (A grid that
  // is max-width-capped, or only painted at one breakpoint, leaves a CONSTANT cell width that the
  // old "must vary" gate wrongly kept as baked px — the "Trusted by" logo cells.)
  return widths.length >= 1;
}

/** A flex item whose width comes from an explicit width/`flex-basis:auto` and that, with its
 *  siblings, equally FILLS a single-line flex row. The engine bakes the resolved px as the
 *  basis; unlike a `flex:1` item (basis 0, which re-distributes), this freezes whenever the
 *  baked basis no longer overflows the live container (no shrink fires) — the `flex gap w-1/3`
 *  card-row freeze. Re-expressing it as `flex:1 1 0` reproduces the equal fill at every captured
 *  width (gate-neutral) and scales fluidly. Gated hard: row-direction, single-line, all in-flow
 *  siblings equal-width AND collectively filling the row, item width varies across widths. */
function isFlexFillItem(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !pb) continue;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;
    const dir = pcs.flexDirection || "row";
    if (dir !== "row" && dir !== "row-reverse") return false;     // width is the main axis
    if ((pcs.flexWrap || "nowrap") !== "nowrap") return false;     // single line (multi-line ≠ one row)
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if ((cs.flexBasis || "auto") !== "auto") return false;        // basis!=auto already self-distributes
    if (pf(cs.flexGrow) > 0) return false;                        // already grows (fluid) — leave it
    // All in-flow, visible flex siblings must share ~equal width AND fill the row.
    const sw: number[] = [];
    for (const c of parentNode.children) {
      if (isTextChild(c)) continue;
      const scs = c.computedByVp[vp]; const sb = c.bboxByVp[vp];
      if (!scs || !sb || !c.visibleByVp[vp]) continue;
      const sp = scs.position || "static";
      if (sp === "absolute" || sp === "fixed") continue;
      sw.push(sb.width);
    }
    if (sw.length < 2) return false;
    if (Math.max(...sw) - Math.min(...sw) > Math.max(2, 0.02 * Math.max(...sw))) return false; // not equal
    const gap = pf(pcs.columnGap && pcs.columnGap !== "normal" ? pcs.columnGap : pcs.gap);
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    const total = sw.reduce((a, b) => a + b, 0) + (sw.length - 1) * gap;
    if (Math.abs(total - content) > Math.max(2, 0.02 * content)) return false; // doesn't fill the row
    widths.push(pf(cs.width));
  }
  return widths.length >= 2 && Math.max(...widths) - Math.min(...widths) > 8;
}

/** A CIRCULAR-DEPENDENCY flex/grid item whose width has NO in-flow source and would collapse to 0.
 *
 *  A Splide (and similar JS carousel) slide is a `shrink-0` flex item whose width is set only by the
 *  library's INJECTED inline `width:Npx`. The sizing probe therefore reads it as content/fill-sized
 *  (`wAuto`/`wFill` both true), so generation drops the width. But the slide's only in-flow children
 *  FILL it (`w-full h-full`, often `aspect-square`) — they take their width FROM the slide. With the
 *  slide's width dropped and every child filling, nothing establishes a definite width: the slide, the
 *  fill children, and the track all resolve to 0×0 (the "Explore Our Oven Range" carousel collapsing
 *  to a −640px hole).
 *
 *  Detect exactly that circular case and pin the captured px so the fill children have a definite basis:
 *    - the node is an IN-FLOW flex or grid ITEM with `flex-shrink:0` (a carousel slide, never shrinks),
 *    - it has a definite positive captured width at every painted viewport,
 *    - it has NO in-flow width source: every in-flow ELEMENT child either FILLS it
 *      (probe `wFill && !wAuto` → width derives from the slide) or is absolutely/fixed positioned,
 *      and at least one such fill child exists (the thing that would collapse).
 *  Requires probe data (older captures return false → inert). Scoped hard so it fires only on the
 *  genuine circular collapse, never on a normal content-sized shrink-0 item. */
function isCircularShrinkSlide(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !pcs || !nb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue; // judge only where painted
    if (!/^(flex|inline-flex|grid|inline-grid)$/.test(pcs.display || "")) return false; // parent must lay it out as a flex/grid item
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;               // in-flow item only
    if ((cs.float || "none") !== "none") return false;
    if (pf(cs.flexShrink) !== 0) return false;                              // a slide is shrink-0 (never collapses to content)
    if (!(nb.width > 0) || !(pf(cs.width) > 0)) return false;               // need a definite captured px to pin
    // No in-flow width source: every in-flow element child fills the slide (its width derives from the
    // slide) or is out of flow; at least one fill child must exist (else nothing collapses).
    let fillChildren = 0;
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      const ccs = c.computedByVp[vp]; const cb = c.bboxByVp[vp];
      if (!ccs || !cb || !c.visibleByVp[vp] || (ccs.display || "") === "none") continue;
      const cpos = ccs.position || "static";
      if (cpos === "absolute" || cpos === "fixed") continue;                // out of flow → no width contribution
      const csz = c.sizingByVp?.[vp];
      // A block-level in-flow box (block/flex/grid/table/list-item) takes its width FROM its
      // container by definition: its `width:auto` computed size IS the fill size, so the probe
      // reports wAuto AND wFill both true — indistinguishable from a genuine content-sized source.
      // Such a child still DERIVES its width from the slide (it never establishes one), so it must
      // count as a fill child, not veto the circular case. Only wFill matters for a block child;
      // wAuto is redundant with it. Inline / inline-block children (whose auto width is genuinely
      // content-derived and can size the slide) keep the strict wFill && !wAuto test.
      const cDisp = ccs.display || "";
      const blockLevel = /^(block|flex|grid|table|list-item|flow-root)$/.test(cDisp);
      if (csz && csz.wFill === true && (blockLevel || csz.wAuto === false)) { fillChildren++; continue; } // fills/derives width from the slide
      return false;                                                         // a genuine in-flow width source → not circular
    }
    if (fillChildren === 0) return false;
    painted++;
  }
  return painted >= 1;
}

/** A FULL-WIDTH carousel slide: a `shrink-0` flex-ROW item whose border box FILLS its flex
 *  container's content width at every painted viewport (a full-viewport hero slide in a Splide list;
 *  the slides sit side by side and the track clips via overflow). The naive emission `width:100%` on
 *  a `shrink-0` flex item does NOT stay at 100%: flex sizes the item from its MAX-CONTENT (the
 *  shrink-0 item can't drop below it), and a full-bleed slide's max-content (its absolutely-positioned
 *  aspect-ratio media) freezes the whole list wider than the container at any unsampled width (the
 *  splide02 hero list measuring 768px inside a 572px window). Emitting `flex-basis:100%` gives the
 *  slide a DEFINITE main size = the container content width, so the flex row stays exactly one
 *  container wide at every width (gate-neutral at samples, correct in between). Distinct from
 *  isCircularShrinkSlide (a FIXED-width sub-container slide that pins its captured px). */
function isFullWidthShrinkSlide(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;       // flex parent
    const dir = pcs.flexDirection || "row";
    if (dir !== "row" && dir !== "row-reverse") return false;                // width is the main axis
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if (pf(cs.flexShrink) !== 0) return false;                              // a slide is shrink-0
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false;   // margins make the width load-bearing
    if ((cs.boxSizing || "border-box") === "content-box") return false;     // basis:100% would overflow by padding
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (Math.abs(nb.width - content) > 1.5) return false;                    // must actually FILL the flex container
    painted++;
  }
  return painted >= 1;
}

/** A flex/grid ITEM whose border box fills its container's content width at every viewport —
 *  cross-axis stretch in a column, a sole/spanning item in a row, a full-span grid cell. We were
 *  baking the resolved fill width per viewport, which freezes it AND (the px differs per width)
 *  spawns a wall of breakpoint variants. Emitting `width:100%` restores the fill and resolves to
 *  the identical px at every sampled width (gate-neutral — width:100% IS the container content
 *  width). Gated: in-flow, border-box, no horizontal margins (those make the width load-bearing),
 *  the box ACTUALLY fills (border box == container content, within 1.5px) at every width, and the
 *  width varies (proving it tracks a fluid container, not a fixed box). */
function isFillsContainerWidth(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue;  // not painted here (width 0) → judge only where it renders
    if (!/^(flex|inline-flex|grid|inline-grid)$/.test(pcs.display || "")) return false;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if ((cs.boxSizing || "border-box") === "content-box") return false; // width:100% would overflow by padding
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false; // margins make the width load-bearing
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (Math.abs(nb.width - content) > 1.5) return false;           // must actually fill the container
    widths.push(nb.width);
  }
  return widths.length >= 2 && Math.max(...widths) - Math.min(...widths) > 8;
}

/** A REPLACED element (img/video/svg/canvas) that fills its containing block at every painted width —
 *  width == container content width across viewports, guarded by object-fit cover/contain/fill or
 *  max-width:100% so `w-full` can't overflow. The sizing probe skips replaced elements, so a fill
 *  thumbnail (a card image, a hero photo) otherwise bakes per-viewport px (`w-[18.75rem]` +
 *  `max-md:w-[10.25rem]`) that won't track a fluid cell — leaving the image narrower than its
 *  cell/caption at widths the capture didn't sample. → `w-full`, which fills at any width. For an
 *  absolutely-positioned image the parent must be the containing block (positioned). */
function replacedFillsContainer(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || !REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue; // judge only where it renders
    // Form controls (textarea/input/select) have no intrinsic ASPECT to distort — a `w-full` chat
    // input that fills its container is just that, so skip the image-aspect guards below for them.
    const isFormControl = node.tag === "textarea" || node.tag === "input" || node.tag === "select";
    // `object-fit:fill` is the DEFAULT, so it's NOT a fill signal. A fixed-PX-height replaced element
    // with no object-fit is an intrinsic-aspect icon/logo (a 32px nav SVG, a square brand logo) —
    // forcing width:100% distorts it. Genuine fills are object-fit cover/contain media, or a
    // height:auto responsive image (which keeps aspect via auto height).
    const hasObjectFit = /cover|contain/.test(cs.objectFit || "");
    if (!isFormControl && !hasObjectFit && /px$/.test(cs.height || "")) return false;
    if (!isFormControl && !hasObjectFit && (cs.maxWidth || "") !== "100%") return false;
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false; // margins make width load-bearing
    const pos = cs.position || "static";
    if (pos === "absolute" || pos === "fixed") {
      if (!/^(relative|absolute|fixed|sticky)$/.test(pcs.position || "")) return false; // parent isn't the CB
    } else if (pos !== "static" && pos !== "relative") return false;
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (Math.abs(nb.width - content) > 2) return false; // must actually fill the container
    painted++;
  }
  return painted >= 1;
}

function sourceWidthFillIntent(node: IRNode): boolean {
  if (!REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  return /\bw-full\b/.test(node.srcClass || "");
}

function sourceMarginAutoIntent(node: IRNode): boolean {
  return /(?:^|\s)mx-auto(?:\s|$)/.test(node.srcClass || "");
}

function sourceFixedSizeIntent(node: IRNode): boolean {
  // Tailwind's `size-*` is an authored square sizing contract. If the sizing probe later drops it
  // as "content-sized", circular icon wrappers collapse to their inner img and lose their apparent
  // padding (Astro integration tabs: `size-12 lg:size-16`). `size-fit` is deliberately excluded:
  // that one is content-derived and should stay auto.
  return /(?:^|\s)(?:[a-z0-9-]+:)*size-(?!fit(?:\s|$))\S+/.test(node.srcClass || "");
}

// An authored, definite length unit (px/rem/em/…) — the same predicate the capture-side probe uses to
// call a dimension "load-bearing". Rejects auto/%/keywords and viewport/container units (those are
// fluid laws the width/height passes already recover); a bare number (`0`) is not definite. Used to
// read the arbitrary-value inner of a `h-[…]` / `w-[…]` source utility.
function isDefiniteAuthoredLength(inner: string): boolean {
  const v = inner.trim().toLowerCase();
  if (!v) return false;
  if (/^(auto|min-content|max-content|fit-content|inherit|initial|unset|revert)$/.test(v)) return false;
  if (/%|vw|vh|vmin|vmax|svw|lvw|dvw|svh|lvh|dvh|\bfr\b/.test(v)) return false;
  return /(?:^|[\s(*/+-])[\d.]+(?:px|rem|em|cm|mm|in|pt|pc|ex|ch|q)\b/.test(v);
}

/** Does the SOURCE class author an explicit, definite fixed height on this axis — `h-[<len>]`,
 *  `min-h-[<len>]`, or the token forms (`h-<n>`, `h-px`) — at one or more breakpoints, corroborated by
 *  geometry? This is the emission-side twin of the capture probe's authored-height guard: a banded
 *  authored fixed height (`h-[4rem] sm:h-[4.5rem] md:h-[6.25rem]`) can still probe hFill/hAuto when the
 *  box is a grid/flex item whose fill child (or stretched track) reproduces the box height — the
 *  fill↔content cycle — so the probe alone would drop the baked band to `h-full`/auto. When the source
 *  authors a definite height AND every painted viewport has a definite computed height matching its
 *  bbox (the authored value actually resolved to that px), trust the baked per-band px. Geometry
 *  corroboration keeps this from firing on a fluid/percentage box that merely mentions a fixed h-token
 *  under an inactive variant. */
function sourceFixedHeightIntent(node: IRNode, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  if (!authorsFixedAxis(node.srcClass, "h")) return false;
  return fixedAxisGeometryHolds(node, "h", viewports);
}

/** The WIDTH twin of sourceFixedHeightIntent: the source authors a definite `w-[<len>]`/`min-w-[<len>]`
 *  (or token) width, corroborated by a definite computed width == bbox at every painted viewport. A
 *  banded authored fixed width on a shrink-0 item (a testimonial avatar `h-[2.5rem] w-[2.5rem] shrink-0`
 *  whose img child fills it) probes wAuto/wFill and would otherwise be dropped, collapsing the box to
 *  its child's intrinsic size. Trust the authored fixed width. */
function sourceFixedWidthIntent(node: IRNode, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  if (!authorsFixedAxis(node.srcClass, "w")) return false;
  return fixedAxisGeometryHolds(node, "w", viewports);
}

// True when the source class authors a definite fixed length on the given axis at any breakpoint:
// `h-[4rem]` / `min-w-[24px]` (arbitrary), `h-px`, or a numeric token `w-24` (Tailwind's spacing scale
// is a fixed rem length). `full`/`auto`/`screen`/fraction/`min`/`max`/`fit`/`svh`… tokens are fluid and
// excluded. Variant-prefixed forms count (banded authored heights), matching the source-intent parser.
function authorsFixedAxis(srcClass: string | undefined, axis: "h" | "w"): boolean {
  if (!srcClass) return false;
  for (const raw of srcClass.split(/\s+/).filter(Boolean)) {
    const colon = lastTopLevelColon(raw);
    const core = colon >= 0 ? raw.slice(colon + 1) : raw;
    const m = new RegExp(`^(?:min-)?${axis}-(.+)$`).exec(core);
    if (!m) continue;
    const val = m[1]!;
    if (val.startsWith("[") && val.endsWith("]")) {
      if (isDefiniteAuthoredLength(val.slice(1, -1))) return true;
      continue;
    }
    if (val === "px") return true;                 // 1px
    if (/^\d+(?:\.\d+)?$/.test(val)) return true;   // spacing-scale token (fixed rem)
  }
  return false;
}

// Index of the variant/core separating colon at bracket depth 0 (so `h-[calc(1px:2)]` is not split on
// an interior colon), mirroring parseSourceClass in the tailwind emitter.
function lastTopLevelColon(raw: string): number {
  let depth = 0, last = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) last = i;
  }
  return last;
}

// Geometry corroboration for an authored fixed height/width: at EVERY painted viewport the node has a
// definite (px, non-auto) computed value on the axis that equals its measured bbox extent. This proves
// the authored fixed length actually resolved to the captured box (so the baked per-band px is the
// authored value), not a fluid/percentage box that merely carries a fixed token under an inactive
// variant. Requires ≥1 painted sample.
function fixedAxisGeometryHolds(node: IRNode, axis: "h" | "w", viewports: number[]): boolean {
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const val = axis === "h" ? cs.height : cs.width;
    const ext = axis === "h" ? nb.height : nb.width;
    if (!val || val === "auto" || !/px$/.test(val)) return false;
    if (!(ext > 0)) return false;
    if (Math.abs(pf(val) - ext) > Math.max(1.5, 0.01 * ext)) return false;
    painted++;
  }
  return painted >= 1;
}

const ABSOLUTE_MEDIA_FILL_TAGS = new Set(["img", "picture", "video"]);

/** An absolutely-positioned media layer authored as a full-cover background: `position:absolute;
 *  inset:0; width:100%; height:100%` or the equivalent. The source capture reports the resolved
 *  pixel width/height at each sampled viewport, so a `<picture>` wrapper can get frozen at the
 *  widest captured card size and leave the underlying card background exposed on wider screens.
 *  This is deliberately narrower than `replacedFillsContainer`: only media tags, all four zero
 *  insets, no margins, positioned parent, and measured coverage of the parent's padding box. */
function absoluteMediaCoversParent(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || !ABSOLUTE_MEDIA_FILL_TAGS.has(node.tag) || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "absolute" && pos !== "fixed") return false;
    if (pos === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pcs.position || "")) return false;
    const sideVals = [cs.top, cs.right, cs.bottom, cs.left];
    if (sideVals.some((v) => v == null || v === "" || v === "auto" || Math.abs(pf(v)) > 1)) return false;
    if (pf(cs.marginTop) !== 0 || pf(cs.marginRight) !== 0 || pf(cs.marginBottom) !== 0 || pf(cs.marginLeft) !== 0) return false;
    const cbX = pos === "fixed" ? 0 : pb.x + pf(pcs.borderLeftWidth);
    const cbY = pos === "fixed" ? 0 : pb.y + pf(pcs.borderTopWidth);
    const cbW = pos === "fixed" ? vp : pb.width - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    const cbH = pos === "fixed"
      ? (CAPTURE_VIEWPORT_HEIGHTS[vp] ?? Math.round(vp * 0.66))
      : pb.height - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
    if (!(cbW > 0) || !(cbH > 0)) return false;
    if (Math.abs(nb.x - cbX) > 2 || Math.abs(nb.y - cbY) > 2) return false;
    if (Math.abs(nb.width - cbW) > Math.max(2, 0.01 * cbW)) return false;
    if (Math.abs(nb.height - cbH) > Math.max(2, 0.01 * cbH)) return false;
    painted++;
  }
  return painted >= 1;
}

/** An inline <svg> sized by a fixed HEIGHT with `width:auto` follows its viewBox aspect ratio — the
 *  source's `h-[2rem] w-auto` logo. Across breakpoints the height steps up (`h-[2rem] sm:h-[2.25rem]
 *  md:h-[2.5rem]`) so the resolved width scales too, and the engine bakes the per-vp px — pinning the
 *  logo. Here the intrinsic aspect is KNOWN (the viewBox is in the captured rawHTML), so we can prove
 *  the law: when the captured width equals height × (viewBox w/h) at EVERY painted viewport, the width
 *  IS purely the aspect-scaled height (not a constrained/flex-shrunk box) → drop it to `auto` so it
 *  tracks the height fluidly. Unlike the reverted width-only image fill, this KEEPS the height as the
 *  driver and lets width follow it, so the aspect is preserved by construction (no distortion). Any vp
 *  whose width is constrained below the aspect (a flex-shrunk mobile logo) fails the check → stays baked. */
function svgAspectWidthAuto(node: IRNode, viewports: number[]): boolean {
  if (node.tag !== "svg" || !node.rawHTML) return false;
  const m = node.rawHTML.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (!m) return false;
  const p = m[1]!.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || !(p[2]! > 0) || !(p[3]! > 0)) return false;
  const aspect = p[2]! / p[3]!;
  let painted = 0;
  for (const vp of viewports) {
    const nb = node.bboxByVp[vp]; const cs = node.computedByVp[vp];
    if (!nb || !cs || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!(nb.height > 0) || !(nb.width > 0)) return false;
    if (Math.abs(nb.width - nb.height * aspect) > Math.max(1.5, 0.02 * nb.width)) return false;
    painted++;
  }
  return painted >= 2;
}

function maxWidthTracksViewport(node: IRNode, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  let samples = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    const bb = node.bboxByVp[vp];
    if (!cs || !bb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!cs.maxWidth || cs.maxWidth === "none") return false;
    if (Math.abs(pf(cs.maxWidth) - vp) > 1.5) return false;
    if (Math.abs(bb.x) > 1.5 || Math.abs(bb.width - vp) > 1.5) return false;
    samples++;
  }
  return samples >= 2;
}

// NOTE: a GENERAL width-only responsive-image fill (`w-[Npx]` → `w-full`, height KEPT) was tried and
// REVERTED — keeping the baked px height while fluidising width distorts a SQUARE image's aspect
// (square images can become wide rectangles). A correct aspect-preserving fill needs
// `height:auto`, unprovable without an intrinsic-aspect probe. `fullBleedImageFill` below is the
// NARROW, safe subset.

/** A FULL-BLEED banner image: a replaced element whose width ≈ the VIEWPORT at every painted width
 *  (it spans the window, starting at the left edge), object-fit cover/fill or max-width:100%, and
 *  whose width VARIES. The engine bakes the per-vp px (`w-320` 1280 + `w-480` 1920), so beyond the
 *  widest captured band it FREEZES — the ridge hero photo stops at 1920 and leaves a gutter on a 2400
 *  monitor. Emit `width:100%` so it keeps filling. Height stays baked (object-fit cover/fill absorbs
 *  the aspect — no distortion, just fills; a gutter is the worse failure). Narrow on purpose: the
 *  "width ≈ viewport" bar excludes small card images (a 372px avatar fills its CARD, not the window),
 *  which is exactly what the general law got wrong. */
function fullBleedImageFill(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const ws: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none" || nb.width <= 0) continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;          // a positioned banner's coords are load-bearing
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false;
    const objFit = cs.objectFit || "fill";
    if (!/cover|contain|fill/.test(objFit) && (cs.maxWidth || "") !== "100%") return false; // can absorb a wider box
    if (Math.abs(nb.x) > Math.max(2, 0.01 * vp)) return false;          // starts at the left edge
    if (Math.abs(nb.width - vp) > Math.max(3, 0.02 * vp)) return false; // spans the viewport (FULL-BLEED, not a card image)
    ws.push(nb.width);
  }
  return ws.length >= 2 && Math.max(...ws) - Math.min(...ws) > 8;       // grows with the viewport
}

/** A block-level child filling its BLOCK container — the single commonest fluid case, and the one
 *  `isFillsContainerWidth` (flex/grid parents only) misses. A block-level box with `width:auto`
 *  always resolves to its containing block's content width; so when the measured width equals the
 *  parent's content width at every sampled viewport (and varies, so there's a band to remove), the
 *  baked per-viewport px is just the default block fill frozen into a value + a band wall. Dropping
 *  width (→ `width:auto`, emit nothing) re-derives the identical box at every width — and is exactly
 *  what a human writes on a full-width div. Provably the captured width because no fixed px could
 *  equal the parent across a 375→1920 (5×) span; only auto/% can. Verified by the layout + perceptual
 *  gates. Block-level = the displays whose `width:auto` FILLS (block/flow-root/flex/grid/list-item) —
 *  NOT inline/inline-block/table, which shrink-to-fit. */
function fillsBlockContainer(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb || !node.visibleByVp[vp]) continue;
    if ((cs.display || "") === "none") continue;
    // Parent must establish a block formatting context where a child's width:auto fills it.
    if (!/^(block|flow-root|list-item)$/.test(pcs.display || "")) return false;
    // Node must be block-LEVEL — only then does width:auto fill (inline/table shrink-to-fit).
    if (!/^(block|flow-root|flex|grid|list-item)$/.test(cs.display || "")) return false;
    const pos = cs.position || "static";
    // `sticky` sizes exactly like an in-flow block — its offset is vertical-only and `width:auto`
    // still fills the block container — so a sticky full-bleed bar baked to a fixed `width:1280px`
    // is fluidisable. Out-of-flow `absolute`/`fixed` auto shrink-wraps to content, so it stays excluded.
    if (pos !== "static" && pos !== "relative" && pos !== "sticky") return false;
    if ((cs.float || "none") !== "none") return false;              // floated auto = shrink-to-fit
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false; // a margin makes the width load-bearing
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (Math.abs(nb.width - content) > 1.5) return false;           // must actually fill the container
    widths.push(nb.width);
  }
  return widths.length >= 2 && Math.max(...widths) - Math.min(...widths) > 8;
}

/** An absolutely/fixed-positioned element spanned by BOTH insets — `left` and `right` are set, so
 *  with `width:auto` the box stretches between them and its used width is `containing-block − left −
 *  right − margins`. The engine bakes the resolved px, freezing that stretch and spawning a band as
 *  the containing block changes width. Dropping width (→ `width:auto`, the absolute default when
 *  both insets are set) re-derives the identical box at every width — the idiomatic `absolute
 *  inset-x-0` full-bleed bar. Provable because the width VARIES (a fixed px couldn't), and we guard
 *  the over-constrained `width:N%` case (where the browser ignores `right`) by checking the box
 *  actually reaches the `right` inset: its right edge sits `right` px from the parent's right edge.
 *  Replaced elements keep their intrinsic width. Verified by the layout + perceptual gates. */
function insetSpannedAbsolute(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "absolute" && pos !== "fixed") return false;
    if (cs.left === "auto" || cs.left == null || cs.right === "auto" || cs.right == null) return false; // both insets must pin the box
    // Guard the over-constrained width:% case: only `width:auto` actually reaches the `right` inset.
    // If the parent is the containing block, the box's right edge sits `right` px inside it.
    const pb = parentNode?.bboxByVp[vp]; const pcs = parentNode?.computedByVp[vp];
    if (pb && pcs && /^(relative|absolute|fixed|sticky)$/.test(pcs.position || "")) {
      const cbRight = pb.x + pb.width - pf(pcs.borderRightWidth) - pf(pcs.paddingRight);
      const expectedRight = cbRight - pf(cs.right) - pf(cs.marginRight);
      if (Math.abs((nb.x + nb.width) - expectedRight) > 1.5) return false;  // width didn't reach `right` ⇒ over-constrained, keep it
    }
    widths.push(nb.width);
  }
  return widths.length >= 2 && Math.max(...widths) - Math.min(...widths) > 8;
}

/** An item capped by an explicit max-width: it FILLS its container below the cap and sits AT the
 *  cap above it (width = min(container content, cap)). We bake the resolved px per viewport, which
 *  both freezes it and spawns bands; emitting `width:100%` (the max-width is emitted separately)
 *  restores `min(100%, cap)` and reproduces every sample. Needs the DENSE/WIDE samples to see the
 *  cap plateau — at just 4 widths a capped element looks like an ordinary shrinking box. Gated:
 *  in-flow, border-box, a real px max-width that is actually reached, fills below it, width varies. */
function isMaxWidthFill(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const cap = pf(node.computedByVp[viewports[0]!]?.maxWidth);
  if (!(cap > 0)) return false; // no px max-width → not this pattern
  let reachedCap = false; let fellBelow = false; const widths: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none") continue;  // not painted here → judge only where it renders
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if ((cs.boxSizing || "border-box") === "content-box") return false;
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return false;
    if (Math.abs(pf(cs.maxWidth) - cap) > 1) return false;        // a STABLE cap (not itself banded)
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    const expected = Math.min(content, cap);                       // min(100%, max-width)
    if (Math.abs(nb.width - expected) > 1.5) return false;
    if (Math.abs(nb.width - cap) <= 1.5) reachedCap = true;
    if (nb.width < cap - 1.5) fellBelow = true;
    widths.push(nb.width);
  }
  return reachedCap && fellBelow && widths.length >= 2 && Math.max(...widths) - Math.min(...widths) > 8;
}

/** A flex/block item that FILLS its container up to a CAP: border-box width = min(parentContent,
 *  CAP) at every width — it tracks the parent below the cap and plateaus at CAP above it. The cap
 *  may come from `max-width` (the nav bar: width:100%; max-width:1200px) OR from `width` (an FAQ
 *  list: width:700px; max-width:100%); either source renders identically and the faithful, fluid
 *  emission is the same: `width:100%; max-width:CAP`. This is the generalisation of isMaxWidthFill
 *  (which needs a px `max-width`) and it MUST win over the content-sized detectors — a capped fill
 *  looks "content-sized" to them (flex:0 1 auto, never overflows), so they wrongly drop its width
 *  to `auto`, collapsing the box to its true content (nav links bunch up; the hero input shrinks).
 *  Distinguished from a PURE fill (no cap → isFillsContainerWidth) by plateauing BELOW the widest
 *  parent, and from a fixed width by actually filling the parent at the narrow widths. Centred
 *  caps (margin auto) are left to planWidth case (a). Returns the cap as a px string, or null. */
function fillsToCapWidth(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): string | null {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  const samples: { w: number; content: number }[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return null;
    if ((cs.float || "none") !== "none") return null;
    if ((cs.boxSizing || "border-box") === "content-box") return null;
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return null; // margin → load-bearing / centred
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (content <= 0) return null;
    samples.push({ w: nb.width, content });
  }
  if (samples.length < 2) return null;
  const cap = Math.max(...samples.map((s) => s.w));
  if (!(cap > 0)) return null;
  // The cap must be AUTHORED, not content-driven. A column that merely shrink-wraps to its widest
  // child also plateaus (at that child's CONTENT width — an odd sub-pixel value like 764.17), and
  // emitting `max-w-[764.17px]` would just relocate the odd-decimal baked px. The reliable signal
  // that the cap is a real design constraint is an explicit px `max-width` equal to it; without one
  // the box is content-sized and belongs on the `w-auto` path. (A `width:Npx; max-width:100%` box —
  // which has no px max-width but IS authored — is handled by keeping its width, not here.)
  const mw = node.computedByVp[viewports[0]!]?.maxWidth;
  const maxWpx = mw && mw.endsWith("px") ? pf(mw) : 0;
  // Authored cap signals: (a) a px max-width equal to the cap (width:100%; max-width:1200px), or
  // (b) max-width:100% with the cap landing on a whole pixel — an authored `width:700px` clamped to
  // the parent. A content column (no max-width) plateaus at its widest child's fractional content
  // width (764.17) and is excluded here so it falls through to `w-auto`.
  const authored = (maxWpx > 0 && Math.abs(maxWpx - cap) <= 1.5) || (mw === "100%" && Math.abs(cap - Math.round(cap)) < 0.1);
  if (!authored) return null;
  let reached = false, filledBelow = false;
  for (const s of samples) {
    if (Math.abs(s.w - Math.min(s.content, cap)) > 1.5) return null;   // width = min(parentContent, cap) everywhere
    if (Math.abs(s.w - cap) <= 1.5) reached = true;
    if (s.w < cap - 1.5 && Math.abs(s.w - s.content) <= 1.5) filledBelow = true; // actually fills the narrower parent
  }
  // At the WIDEST parent the box must sit below it (capped); if it still fills there, it's a pure
  // fill (no cap) and isFillsContainerWidth should own it instead.
  const widest = samples.reduce((a, b) => (b.content > a.content ? b : a));
  if (Math.abs(widest.w - widest.content) <= 1.5) return null;
  if (!reached || !filledBelow) return null;
  return `${Math.round(cap * 100) / 100}px`;
}

/** A width that is a STABLE FRACTION of its container WITHIN each breakpoint regime — and possibly a
 *  DIFFERENT fraction per regime. Ridge's promo panels are `width:100%` stacked on mobile and
 *  `width:50%` side-by-side on desktop; the engine bakes `w-[375px] md:w-160 2xl:w-240`, which
 *  freezes each regime so the panels neither grow on a wide window (stranding a gutter) nor shrink
 *  between breakpoints. Generalises `planWidth` case (c): (a) works for flex/grid ITEMS too — their
 *  `%` resolves against the flex/grid container, the case planWidth bails on — and (b) lets the ratio
 *  change across regimes (emitting one `width:N%` per regime, e.g. `w-1/2 max-md:w-full`). Returns a
 *  per-viewport pct map (the band machinery collapses equal neighbours) or null.
 *
 *  Proven the frTemplate way: every sample's `ratio×container` must reproduce its captured px, the
 *  ratio must be a clean fraction in (0.04, 1.02], the width must VARY (else it's fixed → keep baked),
 *  and — for a flex item — the row must have non-negative slack at every width (the items + gaps don't
 *  overflow, so flex-shrink never fires and `width:N%` is the stable used width). No horizontal
 *  margins (those make the width load-bearing). */
function fluidPercentByVp(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): Record<number, string> | null {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  type S = { vp: number; ratio: number; container: number; w: number; flexRow: boolean; wMin?: number; wMax?: number };
  const samples: S[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb) continue;
    if (!node.visibleByVp[vp] || (cs.display || "") === "none" || nb.width <= 0) continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return null;            // out-of-flow → % is a different beast
    if ((cs.float || "none") !== "none") return null;
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return null; // a margin makes the width load-bearing
    // The node must be a level where `width:%` actually sizes it: a block-level box, or a flex/grid item.
    const pdisp = pcs.display || "";
    const flexGridItem = /(?:^|-)(?:flex|grid)$/.test(pdisp);
    const blockLevel = /^(block|flow-root|list-item|flex|grid|inline-block)$/.test(cs.display || "");
    if (!flexGridItem && !blockLevel) return null;
    // A GRID item's `%` width resolves against its GRID AREA (its track span), NOT the grid
    // container's content box. When the grid has more than one column track, the parent-content-box
    // ratio computed below is against the wrong containing block — the browser would apply that % to
    // the ~1-column track, collapsing the item (24.5% of 1240px emitted where % hits a 302px track →
    // 74px column). We have no direct track-width evidence, so bail for a multi-column grid item and
    // let it fall to its authored width (auto / source-intent). Single-column grids are safe: the one
    // track spans the full content box, so the ratio base is correct.
    const isGridItem = /(?:^|-)grid$/.test(pdisp);
    if (isGridItem) {
      const cols = parseTracks(pcs.gridTemplateColumns);
      if (!cols || cols.length > 1) return null;
    }
    const container = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (container <= 0) return null;
    const ratio = nb.width / container;
    if (!(ratio > 0.04 && ratio < 1.02)) return null;                   // not a clean fraction of the container
    const flexRow = /(?:^|-)flex$/.test(pdisp) && /^(row|row-reverse)$/.test(pcs.flexDirection || "row");
    const sz = node.sizingByVp?.[vp];
    samples.push({ vp, ratio, container, w: nb.width, flexRow, wMin: sz?.wMin, wMax: sz?.wMax });
  }
  if (samples.length < 2) return null;
  const ws = samples.map((s) => s.w);
  if (Math.max(...ws) - Math.min(...ws) <= 8) return null;              // width must vary (else fixed → keep baked)
  // A flex-ROW item only holds `width:N%` if shrink never fires — i.e. the row's in-flow items + gaps
  // don't overflow the container at any sampled width (slack ≥ 0). Otherwise the used width is a
  // shrink result, not the authored %, and `width:N%` would diverge between the captured widths.
  for (const s of samples) {
    if (!s.flexRow) continue;
    const pcs = parentNode.computedByVp[s.vp]!; const pb = parentNode.bboxByVp[s.vp]!;
    const gap = pf(pcs.columnGap && pcs.columnGap !== "normal" ? pcs.columnGap : pcs.gap);
    let sum = 0, vis = 0;
    for (const c of parentNode.children) {
      if (isTextChild(c)) continue;
      const ccs = c.computedByVp[s.vp]; const cb = c.bboxByVp[s.vp];
      if (!ccs || !cb || !c.visibleByVp[s.vp] || (ccs.display || "") === "none") continue;
      const cp = ccs.position || "static";
      if (cp === "absolute" || cp === "fixed") continue;
      sum += cb.width + pf(ccs.marginLeft) + pf(ccs.marginRight); vis++;
    }
    if (vis > 0 && sum + gap * (vis - 1) > s.container + 1.5) return null;   // row overflows ⇒ shrink fired ⇒ keep baked
  }
  // Each sample is a clean fraction that reproduces its captured px. Snap to 0.5% and verify.
  const out: Record<number, string> = {};
  for (const s of samples) {
    // Default: nearest 0.5% (no geometry churn for ordinary boxes). But a CONTENT-FIT box — one sitting
    // at its own max-content width (a nowrap pill: captured w ≈ wMax, and genuinely wrappable so wMin <
    // wMax) — has NO slack: rounding the % DOWN emits a width below its intrinsic content, and the clone
    // wraps it onto a second line (task #26: a 71.70% pill → 71.5% → 245.24px < 245.94px content → wrap,
    // +23.5px section). For such a node snap UP (ceil to the 0.5% step) only when the nearest-rounded px
    // falls below wMax by more than 0.25px, so the emitted width never lands short of the content it must
    // hold. All other nodes keep round-to-nearest.
    const nearest = Math.round(s.ratio * 200) / 2;
    let pct = nearest;
    const wMax = s.wMax, wMin = s.wMin;
    const contentFit = wMax != null && wMin != null && wMin < wMax - 2 &&
      Math.abs(s.w - wMax) <= Math.max(1.5, 0.01 * wMax);
    if (contentFit && (nearest / 100) * s.container < wMax! - 0.25) {
      pct = Math.ceil(s.ratio * 200) / 2;                               // snap UP to clear intrinsic content width
    }
    if (Math.abs((pct / 100) * s.container - s.w) > Math.max(1.5, 0.01 * s.w)) return null;
    out[s.vp] = `${pct}%`;
  }
  // Must actually express a fluid law, not just `width:100%` everywhere (that's the fill path's job).
  if (Object.values(out).every((p) => p === "100%")) return null;
  return out;
}

/** A box that FILLS its container in some viewports but is a fixed-width OVERFLOW track in others — a
 *  responsive card row that spans its centred max-width wrapper on desktop yet becomes a horizontal
 *  SCROLLER on mobile (width > container, the parent `overflow:auto`). The plain fill detectors need
 *  every viewport to fill, so they bail on the mixed regime and bake every band (`w-310` + `2xl:w-325`),
 *  freezing the desktop width so it gutters / snaps on a wide window instead of growing. Emit a per-vp
 *  width: `100%` where it fills the container, the baked px where it overflows as a scroll track.
 *  Proven per vp (100% reproduces a filling box; the px reproduces the overflow track). Requires the
 *  regime to be genuinely MIXED (≥1 fill vp AND ≥1 overflow vp) so the pure fill / fixed paths own
 *  the uniform cases. Returns a percentVp-style map, or null. */
function mixedFillByVp(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): Record<number, string> | null {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  const out: Record<number, string> = {};
  let fills = 0; let overflow = 0; const ws: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none" || nb.width <= 0) continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return null;
    if ((cs.float || "none") !== "none") return null;
    if (pf(cs.marginLeft) !== 0 || pf(cs.marginRight) !== 0) return null;   // a margin makes the width load-bearing
    if (!/^(block|flow-root|list-item|flex|grid|inline-block)$/.test(cs.display || "")) return null;
    const container = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (container <= 0) return null;
    ws.push(nb.width);
    if (Math.abs(nb.width - container) <= Math.max(1.5, 0.01 * container)) { out[vp] = "100%"; fills++; }
    else if (nb.width > container * 1.02 && cs.width && /px$/.test(cs.width)) { out[vp] = cs.width; overflow++; } // scroll track
    else return null;                                                       // a partial fraction → not this law
  }
  if (fills < 1 || overflow < 1) return null;                               // must be genuinely mixed
  if (ws.length < 2 || Math.max(...ws) - Math.min(...ws) <= 8) return null;
  return out;
}

/** A CONTENT-SIZED flex row: a `flex: 0 1 auto` row whose items size to their own content (the
 *  default), so their width varies across viewports because the CONTENT reflows — not because of
 *  any authored per-viewport width. We bake the resolved px, freezing them and spawning a band
 *  wall. The fix is `width:auto` — let content drive each item again. It's provably the captured
 *  width when, at EVERY sampled width, the visible items + gaps + margins do NOT overflow the
 *  container (slack ≥ 0 ⇒ no flex-shrink fired ⇒ each item is already at its content size). And it
 *  must be all-or-nothing per line: dropping ONE item's width changes the line's free space and
 *  shifts its siblings (via justify-content); dropping the WHOLE line leaves free space unchanged,
 *  so nothing moves. Returns the set of item ids to set `width:auto`, or null. */
function contentSizedFlexRow(container: IRNode, viewports: number[]): Set<string> | null {
  if (viewports.length < 3) return null;
  const ccs = container.computedByVp[viewports[0]!];
  if (!ccs || !/^(flex|inline-flex)$/.test(ccs.display || "")) return null;
  const dir = ccs.flexDirection || "row";
  if (dir !== "row" && dir !== "row-reverse") return null;            // width is the main axis only for rows
  if ((ccs.flexWrap || "nowrap") !== "nowrap") return null;           // multi-line ≠ one row
  const items: IRNode[] = [];
  for (const c of container.children) {
    if (isTextChild(c)) continue;
    const cs = c.computedByVp[viewports[0]!]; if (!cs) continue;
    const pos = cs.position || "static";
    if (pos === "absolute" || pos === "fixed") continue;              // out-of-flow → not in the flex line
    if ((cs.float || "none") !== "none") continue;
    if (cs.marginLeft === "auto" || cs.marginRight === "auto") return null; // auto margins absorb free space — different case
    if (pf(cs.flexGrow) > 0) return null;                             // a grower fills the slack, so items aren't content-sized
    items.push(c);
  }
  if (items.length < 1) return null;
  // grow must stay 0 across viewports (else slack is consumed by growth, not left as content slack).
  for (const vp of viewports) for (const it of items) {
    const cs = it.computedByVp[vp]; if (cs && pf(cs.flexGrow) > 0) return null;
  }
  // The sizing probe is ground truth: if it proved `width:auto` does NOT reproduce an item's width at
  // any painted viewport (`wAuto:false`), that item is load-bearing and cannot be dropped. Because this
  // rule is all-or-nothing per line (dropping a subset shifts siblings via justify-content), one such
  // item vetoes the whole line. This catches a wrapping-text item — e.g. a paragraph in a
  // `justify-content:flex-end` row paints at its balanced-wrap width (below max-content), but
  // `width:auto` on the block child fills the line to max-content — which the geometric slack test
  // alone (no shrink fired) would wrongly convert to auto.
  for (const it of items) {
    for (const vp of viewports) {
      if (it.sizingByVp?.[vp]?.wAuto === false) return null;
    }
  }
  // At every width: the visible items + gaps + margins must not overflow the container (slack ≥ 0).
  for (const vp of viewports) {
    const pcs = container.computedByVp[vp]; const pb = container.bboxByVp[vp];
    if (!pcs || !pb) return null;
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    const gap = pf(pcs.columnGap && pcs.columnGap !== "normal" ? pcs.columnGap : pcs.gap);
    let sum = 0; let vis = 0;
    for (const it of items) {
      const cs = it.computedByVp[vp]; const b = it.bboxByVp[vp];
      if (!cs || !b || !it.visibleByVp[vp] || (cs.display || "") === "none") continue;
      sum += b.width + pf(cs.marginLeft) + pf(cs.marginRight); vis++;
    }
    if (!vis) continue;
    if (sum + gap * (vis - 1) > content + 1.5) return null;          // overflow ⇒ shrink fired ⇒ not pure content size
  }
  // Worthwhile only if some item's visible width actually varies (else there were no bands).
  if (!items.some((it) => { const ws = viewports.map((vp) => it.visibleByVp[vp] && it.computedByVp[vp]?.display !== "none" ? it.bboxByVp[vp]?.width : undefined).filter((x): x is number => x !== undefined); return ws.length >= 2 && Math.max(...ws) - Math.min(...ws) > 8; })) return null;
  return new Set(items.map((it) => it.id));
}

/** True when the node's in-flow ELEMENT children leave horizontal free space inside its content box
 *  at every sampled width — i.e. the children do NOT fill it. Such a width is LOAD-BEARING: it
 *  positions the children via auto margins or justify-content, so dropping it to `auto` (content
 *  shrink-wrap) would collapse the box onto its content and destroy that spacing. The marquee
 *  testimonial cards are centred by `mx-auto` inside a wrapper 16px wider than the card — dropping
 *  the wrapper's width removed the inter-card gap. (getComputedStyle resolves `margin:auto` to px,
 *  so the only reliable signal is geometric: child extent < content-box width.) Nodes that carry
 *  their own text are excluded — text fills the box, so it is genuinely content-sized. */
function hasInteriorFreeSpaceX(node: IRNode, viewports: number[]): boolean {
  if (node.children.some((c) => isTextChild(c) && c.text.trim() !== "")) return false;
  let sampled = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const contentW = nb.width - pf(cs.paddingLeft) - pf(cs.paddingRight) - pf(cs.borderLeftWidth) - pf(cs.borderRightWidth);
    if (contentW <= 0) return false;
    let minL = Infinity, maxR = -Infinity, kids = 0;
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      const ccs = c.computedByVp[vp]; const cb = c.bboxByVp[vp];
      if (!ccs || !cb || !c.visibleByVp[vp] || (ccs.display || "") === "none") continue;
      if (ccs.position === "absolute" || ccs.position === "fixed") continue;
      kids++; minL = Math.min(minL, cb.x); maxR = Math.max(maxR, cb.x + cb.width);
    }
    if (kids === 0) return false;                 // no element children → nothing to leave free space
    if (maxR - minL >= contentW - 2) return false; // children fill it → genuinely content-sized
    sampled++;
  }
  return sampled >= 2;
}

/** The sizing probe's verdict for an element's WIDTH, aggregated over the
 *  viewports where it's painted: "auto" if dropping the width re-derives the box at EVERY such width
 *  (content / block-fill), "fill" if width:100% does (a fill), else null (load-bearing, or no probe
 *  data — fall through to the detector cascade). Unanimity is required: a width that's content at one
 *  width but authored at another is a genuine responsive width and is kept. */
function sizingVerdict(node: IRNode, viewports: number[]): "auto" | "fill" | null {
  let any = false, allAuto = true, allFill = true;
  for (const vp of viewports) {
    // Decide from the viewports the PROBE actually read, not the source's visibleByVp. The flags come
    // from the clone render; when source and clone disagree on visibility at a breakpoint (a node the
    // clone hides via display:none has no reading), keying off source-visible-but-no-flag bailed to
    // null and kept a baked decimal width that was provably content (wAuto at every width we measured).
    // A flag's presence means the clone painted+probed it; absence means hidden/animated/replaced there,
    // where the width is moot anyway. Unanimity among present flags still guards genuine responsive widths.
    const s = node.sizingByVp?.[vp];
    if (!s) continue;
    any = true;
    if (!s.wAuto) allAuto = false;
    if (!s.wFill) allFill = false;
  }
  if (!any) return null;
  return allAuto ? "auto" : allFill ? "fill" : null;   // content wins over fill when both hold
}

/** Does this subtree contain wrappable text? Text that can wrap to a different number of lines is the
 *  one thing whose rendered height our clone can't reproduce to the pixel — sub-pixel font-metric
 *  differences flip a line at narrow widths, and a dropped height then lets the box grow and cascade
 *  every sibling below it (the 72px vp375 drift). A box whose height is propped only by NON-text
 *  content (images, fixed-size children, spacers) reproduces exactly, so its height is safe to drop.
 *  Short runs (≤ a dozen chars: a button label, a single word) can't wrap and don't count. */
function hasWrappableText(node: IRNode): boolean {
  for (const c of node.children) {
    if (isTextChild(c)) { if (c.text.trim().length > 12) return true; }
    else if (hasWrappableText(c)) return true;
  }
  return false;
}

/** The inset-anchor probe's verdict: the set of sides (top/right/bottom/left)
 *  that setting to `auto` left the box exactly in place at EVERY painted viewport — i.e. filled-in
 *  USED values (`bottom` = page height, `right` = viewport width) that should not be baked. A side
 *  that moves the box at any painted width is the authored anchor and is kept. Unanimity guards
 *  against a side that's redundant at one width but load-bearing at another. */
const INSET_SIDES = ["top", "right", "bottom", "left"] as const;
function insetDropSides(node: IRNode, viewports: number[]): Set<string> {
  const drop = new Set<string>(INSET_SIDES);
  let any = false;
  for (const vp of viewports) {
    if (!node.visibleByVp[vp]) continue;
    const id = node.sizingByVp?.[vp]?.insetDrop;
    if (!id) return new Set();            // a painted viewport with no inset reading ⇒ decide nothing
    any = true;
    for (const s of INSET_SIDES) if (!id[s]) drop.delete(s);
  }
  return any ? drop : new Set();
}

/** A horizontally-centred absolute/fixed OVERLAY: it carries a `translate` whose X component is -50%
 *  (the `left:50%; translate:-50%` centring idiom) and its `left` is a CONSTANT FRACTION of its
 *  containing block across viewports. The engine bakes the resolved px (`left-155` + `2xl:left-162.5`),
 *  which freezes the centre so the box drifts off-centre BETWEEN breakpoints even though the translate
 *  is correct at sampled widths but can drift between breakpoints. Emit `left:N%` so it tracks the
 *  centre at every width. `cbAncestor` is the nearest positioned ancestor (its padding box is the
 *  containing block); the viewport for `fixed`. Returns the `%` string, proven against every sample. */
function centerLeftPct(node: IRNode, cbAncestor: IRNode | undefined, viewports: number[]): string | null {
  if (node.tag.includes("-")) return null;
  const samples: { left: number; cbW: number }[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none" || nb.width <= 0) continue;
    const pos = cs.position || "static";
    if (pos !== "absolute" && pos !== "fixed") return null;
    if (!hasCenteringTransform(node, vp, "x")) return null;
    const left = cs.left;
    if (!left || left === "auto" || !/px$/.test(left)) return null;          // need a baked px left to replace
    let cbW: number;
    if (pos === "fixed" || !cbAncestor) cbW = vp;                            // fixed → viewport
    else {
      const pcs = cbAncestor.computedByVp[vp]; const pb = cbAncestor.bboxByVp[vp];
      if (!pcs || !pb) return null;
      cbW = pb.width - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);   // containing block = padding box
    }
    if (!(cbW > 0)) return null;
    samples.push({ left: pf(left), cbW });
  }
  if (samples.length < 2) return null;
  const lefts = samples.map((s) => s.left);
  if (Math.max(...lefts) - Math.min(...lefts) <= 4) return null;             // left must vary (else genuinely fixed)
  const ratios = samples.map((s) => s.left / s.cbW);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  if (!(mean > 0.02 && mean < 0.98)) return null;
  if (Math.max(...ratios) - Math.min(...ratios) > 0.01) return null;          // a CONSTANT fraction
  const pct = Math.round(mean * 1000) / 10;
  for (const s of samples) if (Math.abs((pct / 100) * s.cbW - s.left) > Math.max(1.5, 0.01 * s.left)) return null; // reproduces
  return `${pct}%`;
}

function fixedWidthButtonLike(node: IRNode, viewports: number[]): boolean {
  if (node.tag !== "a" && node.tag !== "button") return false;
  const widths: number[] = [];
  let sampled = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    const bb = node.bboxByVp[vp];
    if (!cs || !bb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    sampled++;
    if (!/^(flex|inline-flex|block|inline-block)$/.test(cs.display || "")) return false;
    if (!/pointer/.test(cs.cursor || "")) return false;
    if (pf(cs.borderTopLeftRadius) < 12 && pf(cs.borderTopRightRadius) < 12) return false;
    if (bb.width < 120 || bb.height < 28) return false;
    widths.push(bb.width);
  }
  return sampled >= 2 && widths.length >= 2 && Math.max(...widths) - Math.min(...widths) <= 2;
}

function fixedHeightButtonLike(node: IRNode, viewports: number[]): boolean {
  if (node.tag !== "a" && node.tag !== "button") return false;
  const heights: number[] = [];
  let sampled = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    const bb = node.bboxByVp[vp];
    if (!cs || !bb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    sampled++;
    if (!/^(flex|inline-flex|block|inline-block)$/.test(cs.display || "")) return false;
    if (!/pointer/.test(cs.cursor || "")) return false;
    if (!cs.height || !/px$/.test(cs.height)) return false;
    if (bb.height < 24) return false;
    heights.push(bb.height);
  }
  return sampled >= 2 && heights.length >= 2 && Math.max(...heights) - Math.min(...heights) <= 1;
}

function transformTranslatePx(value: string | undefined): { x: number; y: number } | null {
  if (!value || value === "none") return null;
  let m = /^matrix\(\s*1\s*,\s*0\s*,\s*0\s*,\s*1\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(value);
  if (m) return { x: +m[1]!, y: +m[2]! };
  m = /^translate(?:3d)?\(\s*(-?[\d.]+)px(?:\s*,\s*(-?[\d.]+)px)?/.exec(value);
  if (m) return { x: +m[1]!, y: +(m[2] ?? 0) };
  return null;
}

function hasCenteringTransform(node: IRNode, vp: number, axis: "x" | "y"): boolean {
  const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
  if (!cs || !nb) return false;
  const translate = (cs.translate || "none").trim();
  if (axis === "x" && /^-50%(\s|$)/.test(translate)) return true;
  if (axis === "y" && /^\S+\s+-50%(\s|$)/.test(translate)) return true;
  const tr = transformTranslatePx(cs.transform);
  if (!tr) return false;
  return axis === "x"
    ? Math.abs(tr.x + nb.width / 2) <= Math.max(1.5, nb.width * 0.01)
    : Math.abs(tr.y + nb.height / 2) <= Math.max(1.5, nb.height * 0.01);
}

/** A centered absolute/fixed element with edge guards: `left/top: clamp(MIN, 50%, 100% - MIN)`.
 * This is the source-like law for large floating mockup windows that stay centered in roomy frames
 * but pin to a minimum inset inside narrow frames. The transform provides the actual centering. */
function centeredInsetClamp(node: IRNode, cbAncestor: IRNode | undefined, viewports: number[], axis: "x" | "y"): Record<number, string> | null {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return null;
  type S = { vp: number; inset: number; span: number };
  const samples: S[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "absolute" && pos !== "fixed") return null;
    if (!hasCenteringTransform(node, vp, axis)) return null;
    const raw = axis === "x" ? cs.left : cs.top;
    if (!raw || raw === "auto" || !/px$/.test(raw)) return null;
    let span: number;
    if (pos === "fixed" || !cbAncestor) span = axis === "x" ? vp : viewportHeightFor(vp);
    else {
      const pcs = cbAncestor.computedByVp[vp]; const pb = cbAncestor.bboxByVp[vp];
      if (!pcs || !pb) return null;
      span = axis === "x"
        ? pb.width - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth)
        : pb.height - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
    }
    if (!(span > 0)) return null;
    samples.push({ vp, inset: pf(raw), span });
  }
  if (samples.length < 2) return null;
  const insets = samples.map((s) => s.inset);
  if (Math.max(...insets) - Math.min(...insets) <= 4) return null;
  const minInset = Math.min(...insets);
  const pctCandidates = new Set<number>();
  for (const s of samples) {
    const pct = cleanPct((s.inset / s.span) * 100);
    if (pct > 2 && pct < 98) pctCandidates.add(pct);
  }
  for (const pct of pctCandidates) {
    const ok = samples.every((s) => {
      const preferred = s.span * pct / 100;
      const maxInset = s.span - minInset;
      const predicted = Math.max(minInset, Math.min(preferred, maxInset));
      return Math.abs(predicted - s.inset) <= Math.max(1.5, 0.01 * Math.max(s.inset, 1));
    });
    if (!ok) continue;
    const css = `clamp(${fmtPx(minInset)}, ${pct}%, calc(100% - ${fmtPx(minInset)}))`;
    const out: Record<number, string> = {};
    for (const s of samples) out[s.vp] = css;
    return out;
  }
  return null;
}

/** The sizing probe's verdict for HEIGHT: true when height:auto re-derives the box at every painted
 *  viewport — an authored-taller control (a button) reads false and keeps its height. Restricted to
 *  boxes with no wrappable text (see hasWrappableText): the probe's per-element 0.5px reproduction is
 *  reliable for structural/media boxes, but a text box can reflow differently in our clone and a
 *  dropped height then cascades. Text boxes keep their height here; heightFlows still drops the
 *  varying ones it can structurally prove, and the text-leaf path drops clean line-multiple leaves. */
function heightProbeDrops(node: IRNode, viewports: number[], reflow = false): boolean {
  // Default (gate-safe): keep heights on wrappable-text boxes — our clone can wrap to a different line
  // count and a dropped height then cascades. In reflow mode we flow them too, accepting the position
  // drift the perceptual gate proves is invisible.
  if (!reflow && hasWrappableText(node)) return false;
  let any = false;
  for (const vp of viewports) {
    if (!node.visibleByVp[vp]) continue;
    const s = node.sizingByVp?.[vp];
    if (!s || !s.hAuto) return false;
    any = true;
  }
  return any;
}

/** A pure TEXT leaf that is a flex-COLUMN item aligned to its content (not stretched) — its width IS
 *  its text's content width, so `width:auto` re-derives it (and re-flows when the copy changes). The
 *  flex-ROW path is contentSizedFlexItemAuto; the column cross-axis isn't covered there, and
 *  contentSizedColumnItem only handles element children (it measures their extent), so a text-only
 *  column item — footer links like "Overview"/"Product" — kept its baked content px. Gated: parent
 *  is a flex column, the item is not stretched (else it'd fill → w-full) and does NOT fill the
 *  parent, and has no auto margins. */
function isContentSizedColumnTextLeaf(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  if (node.children.some((c) => !isTextChild(c))) return false;                       // pure text leaf only
  if (!node.children.some((c) => isTextChild(c) && c.text.trim() !== "")) return false;
  let sampled = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const pcs = parentNode.computedByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !nb || !pcs || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;
    if (!/^column/.test(pcs.flexDirection || "row")) return false;                    // column ⇒ width is the cross axis
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if (cs.marginLeft === "auto" || cs.marginRight === "auto") return false;
    const as = cs.alignSelf && cs.alignSelf !== "auto" ? cs.alignSelf : (pcs.alignItems || "stretch");
    if (/stretch/.test(as)) return false;                                             // stretched ⇒ fills (w-full), not content
    const pcontent = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (nb.width >= pcontent - 2) return false;                                        // fills parent ⇒ not content-sized
    sampled++;
  }
  return sampled >= 1;
}

/** An inline-level box (inline-flex / inline-block / inline-grid) shrink-wraps to its content by CSS
 *  definition. A baked `width` just freezes that — and worse, clamps the content so the box's own
 *  padding gets eaten (the "Start for Free" button rendered with its px-3 squashed because the frozen
 *  116px content-box was narrower than the clone's text + padding needs). Dropping the width lets it
 *  size to content again, padding intact. The cascade's `lockWidth` still protects an inline box that
 *  has genuine interior free space; replaced/custom elements keep their intrinsic size. */
function isInlineContentBox(node: IRNode, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  let sampled = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    if (!cs || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!/^inline-(flex|block|grid)$/.test(cs.display || "")) return false;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if (cs.marginLeft === "auto" || cs.marginRight === "auto") return false;
    sampled++;
  }
  return sampled >= 2;
}

/** A content-sized item on its CROSS axis: a flex-COLUMN child (cross axis = width) whose width is
 *  driven by its own content, so `width:auto` re-derives it (content reflow, not a fixed px). Unlike
 *  a flex ROW, column items don't share main-axis free space, so this is safe per item (no sibling
 *  shift). It may even *fill* the container at the narrow widths (a content box that happens to be
 *  as wide as its parent) and fall short at the wide ones — `width:auto` reproduces both. We require
 *  its SHARE of the container to vary: a constant share is a percentage width (auto wouldn't
 *  reproduce), and a constant 1.0 is a true stretch (isFillsContainerWidth's job → width:100%).
 *  Verified visually by the layout + perceptual gates. */
function contentSizedColumnItem(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = []; const ratios: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;
    const dir = pcs.flexDirection || "row";
    if (dir !== "column" && dir !== "column-reverse") return false;  // cross axis must be width
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if (cs.marginLeft === "auto" || cs.marginRight === "auto") return false;
    if ((cs.boxSizing || "border-box") === "content-box") return false;
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (content <= 0 || nb.width > content + 1.5) return false;      // overflows the container → not content-sized
    if (nb.width >= content - 1.5) continue;                          // fills the cross axis (stretch) — not content-sizing AT this vp
    widths.push(nb.width); ratios.push(nb.width / content);
  }
  // After excluding stretch/fill viewports, a content-sized item's width still TRACKS its content
  // (varies as text reflows). A width that is CONSTANT across the remaining viewports is a fixed
  // width that merely fills/stretches at narrow widths (a `width:268px` CTA that goes full-width on
  // mobile) — NOT content-sized; keep it so the desktop box doesn't collapse to the label.
  if (widths.length < 2 || Math.max(...widths) - Math.min(...widths) <= 8) return false;
  if (Math.max(...ratios) - Math.min(...ratios) < 0.03) return false; // constant share → percentage or true stretch, not content
  return true;
}

/** A single flex-ROW item that is provably CONTENT-sized on the main axis, so `width:auto`
 *  reproduces it and the baked per-viewport px is just frozen content reflow (these are the menu /
 *  toolbar items whose px width changes only because their label reflows or they appear only at some
 *  widths). Per-item and cascade-free because we convert ONLY `flex:none` items — flex-grow:0,
 *  flex-shrink:0, flex-basis:auto — whose main size is ALWAYS their content size at every width,
 *  independent of siblings, so dropping the px shifts nothing. Two more guards make it provable:
 *  the width must VARY (else there's no band to remove), and its SHARE of the container must vary
 *  too — a constant ratio would be a percentage width, which `width:auto` would NOT reproduce.
 *  Replaced elements keep their intrinsic width. Verified by the layout + perceptual gates. */
function contentSizedFlexItemAuto(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag.includes("-")) return false;
  const widths: number[] = []; const ratios: number[] = []; let canShrink = false;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const pcs = parentNode.computedByVp[vp];
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !pcs || !nb || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    // The sizing probe is ground truth: if it proved `width:auto` does NOT reproduce the captured
    // width at any painted viewport (`wAuto:false`), the geometric "never shrank ⇒ at content size"
    // read below is wrong — e.g. a wrapping paragraph in a `justify-content:flex-end` row paints at
    // its balanced-wrap width (below max-content), but `width:auto` on the block child fills the line
    // to max-content and left-aligns it. Honor the probe over the heuristic.
    if (node.sizingByVp?.[vp]?.wAuto === false) return false;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;
    const dir = pcs.flexDirection || "row";
    if (dir !== "row" && dir !== "row-reverse") return false;        // width = main axis only for rows
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if (cs.marginLeft === "auto" || cs.marginRight === "auto") return false;
    if (pf(cs.flexGrow) > 0) return false;                           // a grower expands past content
    if (pf(cs.flexShrink) !== 0) canShrink = true;                   // a shrinker MAY drop below content (guarded below)
    if ((cs.flexBasis || "auto") !== "auto") return false;           // an explicit basis is authored size
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (content <= 0) return false;
    widths.push(nb.width); ratios.push(nb.width / content);
  }
  if (widths.length < 2) return false;
  // A CONSTANT share across a VARYING container is a percentage width (width:N%), which width:auto
  // would not reproduce — exclude it. But a genuinely constant container can't distinguish percent
  // from content, so only apply this when the container actually varies. (A constant content width —
  // a button whose label never changes — is no longer rejected: the baked odd-decimal px it leaves
  // is exactly what we want to drop; the slack + lockWidth guards keep auto safe.)
  const conts = viewports.map((vp) => { const pb = parentNode.bboxByVp[vp]; const pcs = parentNode.computedByVp[vp]; return pb && pcs ? pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) : 0; }).filter((x) => x > 0);
  const containerVaries = conts.length >= 2 && Math.max(...conts) - Math.min(...conts) > 8;
  if (containerVaries && Math.max(...ratios) - Math.min(...ratios) < 0.03) return false; // constant share ⇒ percentage
  // A shrinkable item (flex:0 1 auto, the default) is only proven to be AT its content size if its
  // line never had to shrink anyone — i.e. there is positive free space at every width. With slack,
  // nothing shrank, so the measured width IS the content width and `width:auto` reproduces it.
  if (canShrink && !flexRowHasSlack(parentNode, viewports)) return false;
  return true;
}

/** True when a flex ROW leaves positive free space (no item had to flex-shrink) at every width:
 *  the visible in-flow items + their margins + the gaps sum to strictly LESS than the container's
 *  content width. Used to prove a shrinkable content item never actually shrank. */
function flexRowHasSlack(container: IRNode, viewports: number[]): boolean {
  let checked = 0;
  for (const vp of viewports) {
    const pcs = container.computedByVp[vp]; const pb = container.bboxByVp[vp];
    if (!pcs || !pb) continue;
    if (!/^(flex|inline-flex)$/.test(pcs.display || "")) return false;
    const content = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (content <= 0) continue;
    const gap = pf(pcs.columnGap && pcs.columnGap !== "normal" ? pcs.columnGap : pcs.gap);
    let sum = 0; let vis = 0;
    for (const it of container.children) {
      if (isTextChild(it)) continue;
      const cs = it.computedByVp[vp]; const b = it.bboxByVp[vp];
      if (!cs || !b || !it.visibleByVp[vp] || (cs.display || "") === "none") continue;
      const pos = cs.position || "static";
      if (pos === "absolute" || pos === "fixed") continue;
      sum += b.width + pf(cs.marginLeft) + pf(cs.marginRight); vis++;
    }
    if (!vis) continue;
    if (sum + gap * Math.max(0, vis - 1) > content - 1.5) return false;  // packed/overflowing ⇒ shrink may have fired
    checked++;
  }
  return checked >= 1;
}

/** Does an in-flow element CHILD derive its HEIGHT from its parent's box (fill it) at this viewport?
 *  Two ways:
 *   • the sizing probe measured `height:100%` reproduces and `height:auto` does NOT (hFill && !hAuto);
 *   • the child is an UN-PROBED replaced element that soaks up the parent box height — a `<picture>`
 *     (the probe skips it — walker's probe excludes replaced tags) or an object-fit:cover img/video —
 *     whose border-box height ≈ the parent's CONTENT-box height. Such a child's extent equals the
 *     parent's height only BECAUSE it fills it (object-fit:cover paints to any box, `<picture>` sizes
 *     its inner img to the box), so it is NOT content evidence and must not explain away the parent's
 *     authored height. Without this a `<picture h-full>` reads as real content, the authored parent
 *     height is dropped, and the inner img re-derives from its selected source's natural aspect.
 *  `parentContentH` is the parent's content-box height (border-box minus padding/border, top+bottom). */
function childDerivesHeightFromParent(child: IRNode, vp: number, parentContentH: number): boolean {
  const csz = child.sizingByVp?.[vp];
  if (csz && csz.hFill === true && csz.hAuto === false) return true;
  const ccs = child.computedByVp[vp]; const cb = child.bboxByVp[vp];
  if (!ccs || !cb) return false;
  const isPicture = child.tag === "picture";
  const isCoverReplaced = REPLACED.has(child.tag) && /cover/.test(ccs.objectFit || "");
  if (!isPicture && !isCoverReplaced) return false;
  if (!(parentContentH > 0)) return false;
  // Border-box height fills the parent content box (≤2px slop). An intrinsically-shorter media that
  // merely SITS in a taller box (natural-aspect logo) fails this and is treated as real content.
  return Math.abs(cb.height - parentContentH) <= Math.max(2, 0.01 * parentContentH);
}

/** Whether a node's height can FLOW (drop the baked px) — true when, at every sampled width, its
 *  border-box height is either content-driven (== the extent of its in-flow children + padding) or
 *  cross-axis STRETCH (a flex-row / grid item filling its container's content height). Both
 *  re-derive the identical box when the height is dropped, so the only thing the measured px adds
 *  is a frozen value + a band. Excludes replaced/clipped/positioned/explicitly-taller boxes, where
 *  the height is load-bearing. Geometry fidelity is verified by the layout + perceptual gates. */
function heightFlows(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  const hasText = node.children.some(isTextChild);
  let sampled = 0; let varies = false; const hs: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp]) continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.overflowY || cs.overflow || "visible") !== "visible") return false;
    if ((cs.display || "") === "none") continue;
    // The sizing probe proved this height AUTHORED-EXPLICIT: height:auto did NOT reproduce the box
    // (hAuto:false) and the box is not a fill child of its own parent (hFill:false). The measured
    // px is then load-bearing — dropping it collapses the box. This overrides the structural flow
    // reasoning below, which can read the height as content-driven via a CIRCULAR pair (two nested
    // authored-height boxes each "explaining" the other's extent) and drop both. Bail so the
    // authored height survives. (heightProbeDrops, OR'd with this at the call site, also refuses to
    // drop an hAuto:false box — so the two signals agree and the authored px is kept.)
    const sz = node.sizingByVp?.[vp];
    if (sz && sz.hAuto === false && sz.hFill === false) return false;
    // A flex COLUMN that DISTRIBUTES free space (justify-content space-between/around/evenly, or the
    // packed alignments that pin the last child away from the top): the box height is LOAD-BEARING —
    // it sets the free space the children spread through. The content-extent check below would read
    // the last child reaching the box bottom as "content-sized", but that extent only equals the box
    // bottom BECAUSE the distribution pushed it there. Dropping the height collapses the gaps.
    if (/flex/.test(cs.display || "") && /column/.test(cs.flexDirection || "row") &&
        /^(space-between|space-around|space-evenly|center|flex-end|end)$/.test(cs.justifyContent || "")) {
      return false;
    }
    // A flex COLUMN whose in-flow child fills it via flex-grow: the box's height is LOAD-BEARING,
    // not content-derived. The content-extent check below would read the box as content-sized — but
    // that extent IS the grown child, which only reaches the box bottom BECAUSE the box has this
    // height (flex-grow distributes the box's free space). Dropping the height collapses the child to
    // its own content (the changelog card <a grow> inside its <article> shrank to its text on a short
    // entry → uneven cards). Keep the height.
    if (/flex/.test(cs.display || "") && /column/.test(cs.flexDirection || "row") &&
        node.children.some((c) => !isTextChild(c) && c.visibleByVp[vp] && (c.computedByVp[vp]?.display || "") !== "none" && pf(c.computedByVp[vp]?.flexGrow) > 0)) {
      return false;
    }
    sampled++; hs.push(nb.height);
    // content extent of the in-flow children — both the border-box bottom and the bottom WITH the
    // child's trailing margin-bottom, because whether that margin extends the box (height includes
    // it) or collapses through depends on the box; we accept the box if its height matches EITHER.
    let bottom = nb.y + pf(cs.paddingTop) + pf(cs.borderTopWidth); let bottomMargin = bottom; let hasChild = false;
    // Are ALL in-flow element children FILL children (height:100% / probe hFill) whose height DERIVES
    // from THIS box? Then their extent reaching the box bottom is not content evidence — it is the
    // box's own authored height reflected back (a `h-full aspect-video` hero image inside a fixed-height
    // header). Dropping the height then lets the fill child re-derive from its aspect ratio and inflate
    // (a 240px hero → 720px @16/9). Do NOT flow such a box's height.
    let allInflowFill = true;
    const nodeContentH = nb.height - pf(cs.paddingTop) - pf(cs.paddingBottom) - pf(cs.borderTopWidth) - pf(cs.borderBottomWidth);
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      const ccs = c.computedByVp[vp]; const cb = c.bboxByVp[vp];
      if (!ccs || !cb || !c.visibleByVp[vp] || (ccs.display || "") === "none") continue;
      if (ccs.position === "absolute" || ccs.position === "fixed") continue;
      if ((ccs.float || "none") !== "none") continue;
      hasChild = true;
      if (!childDerivesHeightFromParent(c, vp, nodeContentH)) allInflowFill = false;
      bottom = Math.max(bottom, cb.y + cb.height);
      bottomMargin = Math.max(bottomMargin, cb.y + cb.height + Math.max(0, pf(ccs.marginBottom)));
    }
    // Authored height whose only in-flow children fill it (circular): keep the height (don't flow).
    // Guarded by the parent's own probe: hAuto===false means auto did NOT reproduce the box → real
    // authored height, not a content coincidence.
    if (hasChild && allInflowFill && node.sizingByVp?.[vp]?.hAuto === false) return false;
    const pad = pf(cs.paddingBottom) + pf(cs.borderBottomWidth);
    const contentH = bottom - nb.y + pad; const contentHMargin = bottomMargin - nb.y + pad;
    // Content-driven when the box is exactly its in-flow children's extent — with OR without their
    // trailing margin (≤2px — realistic line-box/rounding slop; the layout per-leaf-position +
    // responsive gates backstop any drift) — OR when it has only TEXT/inline content (no element
    // children but real text): then its height IS its line-box content and `height:auto` re-derives
    // it. An empty box (no children, no text) with a height is an authored spacer — left alone.
    const contentDriven = (hasChild && (Math.abs(nb.height - contentH) <= 2 || Math.abs(nb.height - contentHMargin) <= 2)) || (!hasChild && hasText);
    // stretch: a flex-row / grid item whose height fills the container's content height
    let stretched = false;
    const pcs = parentNode?.computedByVp[vp]; const pb = parentNode?.bboxByVp[vp];
    if (pcs && pb && /flex|grid/.test(pcs.display || "")) {
      const dir = pcs.flexDirection || "row";
      const crossIsHeight = /grid/.test(pcs.display || "") || dir === "row" || dir === "row-reverse";
      if (crossIsHeight) {
        const pContentH = pb.height - pf(pcs.paddingTop) - pf(pcs.paddingBottom) - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
        if (Math.abs(nb.height - pContentH) <= 2) stretched = true;
      }
    }
    if (!contentDriven && !stretched) return false;
  }
  if (sampled < 2) return false;
  varies = Math.max(...hs) - Math.min(...hs) > 8;
  return varies; // only flow when it actually removes a band (a constant height is left alone)
}

/** Does this node's PARENT layout auto-stretch the node's HEIGHT to fill the cross axis? A grid item
 *  (default/normal align ⇒ stretch) or a flex item in a ROW-direction flex fills the cross (height)
 *  at height:auto — no explicit 100% needed. A block / flex-COLUMN / inline parent does NOT, so a
 *  child that fills it needs an explicit height:100%. Per viewport. */
function parentAutoStretchesHeight(node: IRNode, parentNode: IRNode | undefined, vp: number): boolean {
  const pcs = parentNode?.computedByVp[vp]; const cs = node.computedByVp[vp];
  if (!pcs || !cs) return false;
  const pd = pcs.display || "";
  const self = cs.alignSelf && cs.alignSelf !== "auto" ? cs.alignSelf : (pcs.alignItems || "normal");
  const stretch = self === "stretch" || self === "normal";
  if (/grid/.test(pd)) return stretch;
  if (/flex/.test(pd)) { const dir = pcs.flexDirection || "row"; return stretch && (dir === "row" || dir === "row-reverse"); }
  return false;
}

/** A height:100% filler: this node fills its parent's content-box HEIGHT at every painted viewport (a
 *  card filling its stretched grid cell, a figure filling that card). The faithful emission is
 *  `height:100%` — NOT the baked px (freezes, bands) and NOT `auto` (a block/flex-column parent does
 *  not stretch it, so auto collapses it to content — the uneven-card bug: the long-quote figures had
 *  their px height dropped to auto and grew past their pinned neighbours). Gated so 100% actually
 *  resolves and reproduces the captured px:
 *   • parent height is DEFINITE (threaded: under a grid/flex-stretch cell or another 100% filler),
 *   • parent does NOT already auto-stretch this node (else auto fills — leave the existing path),
 *   • the box fills the parent content height (≤2px) at every painted vp, and the height VARIES
 *     (so 100% removes a baked band; a constant filler is left alone). */
function isHeightFill(node: IRNode, parentNode: IRNode | undefined, parentDefiniteHeight: boolean, viewports: number[]): boolean {
  if (!parentDefiniteHeight || !parentNode || REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  const hs: number[] = [];
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const pcs = parentNode.computedByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !nb || !pcs || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    if ((cs.float || "none") !== "none") return false;
    if (parentAutoStretchesHeight(node, parentNode, vp)) return false; // auto already fills the cross axis
    const pContentH = pb.height - pf(pcs.paddingTop) - pf(pcs.paddingBottom) - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
    if (pContentH <= 0) return false;
    if (Math.abs(nb.height - pContentH) > Math.max(2, 0.01 * pContentH)) return false; // must fill the parent
    hs.push(nb.height);
  }
  return hs.length >= 2 && Math.max(...hs) - Math.min(...hs) > 4;
}

/** An absolutely/fixed-positioned layer that fills its containing block vertically. The generic
 * height-fill path intentionally ignores positioned nodes, and the inset-drop probe can mark `top`
 * / `bottom` as redundant because the static-position fallback happens to match at capture time.
 * When the measured box starts at the containing block's top edge and its height equals the padding
 * box height at every painted viewport, the authored intent is a vertical fill (`top-0 h-full` or
 * inset-y-0), not a baked `h-[720px]`. */
function absoluteHeightFill(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode || REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const pcs = parentNode.computedByVp[vp]; const pb = parentNode.bboxByVp[vp];
    if (!cs || !nb || !pcs || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pos = cs.position || "static";
    if (pos !== "absolute" && pos !== "fixed") return false;
    if (pos === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pcs.position || "")) return false;
    const top = pf(cs.top);
    const cbY = pos === "fixed" ? 0 : pb.y + pf(pcs.borderTopWidth);
    const cbH = pos === "fixed"
      ? (CAPTURE_VIEWPORT_HEIGHTS[vp] ?? Math.round(vp * 0.66))
      : pb.height - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
    if (!(cbH > 0)) return false;
    if (Math.abs(nb.y - (cbY + top)) > 2) return false;
    if (Math.abs(nb.height - cbH) > Math.max(2, 0.01 * cbH)) return false;
    painted++;
  }
  return painted >= 1;
}

/** Sizing-probe verdict for `h-full`: at EVERY painted viewport `height:100%` reproduced the box
 *  (within 0.5px, `hFill`) while `height:auto` did NOT (`!hAuto`). That pair is direct ground truth
 *  that the element FILLS a definite-height containing block (the source's `h-full`) rather than being
 *  content-sized (which drops to auto via heightProbeDrops). Unlike isHeightFill this needs no
 *  structural parentDefiniteHeight inference and no "varies" guard — the browser measured that 100%
 *  reproduces, so a CONSTANT filler qualifies too. Inert on captures
 *  predating the hFill probe (older sites): `hFill === undefined` → returns false. Replaced elements
 *  aren't probed (the probe skips them), so this never fires on img/svg. */
function heightProbeFills(node: IRNode, viewports: number[]): boolean {
  if (process.env.NO_HFILL) return false; // diagnostic toggle
  let painted = 0; let paintedTotal = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    if (!cs || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    paintedTotal++;
    const pos = cs.position || "static";
    if (pos !== "static" && pos !== "relative") return false;
    const s = node.sizingByVp?.[vp];
    if (!s || s.hFill === undefined) return false; // no probe data → inert (older captures)
    if (!s.hFill || s.hAuto) return false;         // must fill at 100% AND not be content-sized
    painted++;
  }
  // Normally require ≥2 painted viewports so the fill verdict is corroborated across widths. But a
  // responsive-only variant (a `max-md:`-scoped node) is PAINTED at only one captured viewport — its
  // single unanimous probe reading is the COMPLETE evidence set, not a lone sample, so accept it.
  // The parent still confers a definite height (its own band-baked height), so 100% resolves safely.
  return painted >= 2 || (painted === 1 && paintedTotal === 1);
}

/** Does this node confer a DEFINITE height to its children (so their height:100% resolves)? True when:
 *   • we just gave it height:100% (isHeightFill) — chaining the fill down a wrapper > card > figure nest,
 *   • it is a grid / row-flex-stretch item (auto-stretched to a definite cell/line height) every painted vp,
 *   • it is a flex-GROW item in a flex COLUMN whose own parent is already definite-height: the column
 *     hands it a definite share of the (definite) free space, so it has a definite USED height even when
 *     we drop its explicit height to `grow basis-0` (the source-matching emission). Without this the
 *     fill chain snaps at every `flex-1` link,
 *   • OR it KEEPS its own height in the clone (we did not drop it via the flow/probe path → we emit its
 *     captured px). A box whose height we bake is a definite containing block, so a child's height:100%
 *     resolves against it. `droppedHeight` is the node's own flow-drop (flowH); a dropped height becomes
 *     `auto` (content-derived) — NOT definite.
 *  This is broader than stretch-only, but SAFE: a content-derived parent is itself dropped (droppedHeight)
 *  so it never reaches the kept-height branch — the dangerous "parent merely wraps this child" case can't
 *  cascade — and the per-child `isHeightFill` gate (fills the parent content-box ≤2px at EVERY sampled vp
 *  AND varies) is the real filter on which children actually become 100%. Together these flow the
 *  `h-full` chain through grid-row anchors, baked-px panels and `flex-1` links alike. */
function confersDefiniteHeight(node: IRNode, parentNode: IRNode | undefined, gotHeightFill: boolean, droppedHeight: boolean, parentDefiniteHeight: boolean, viewports: number[]): boolean {
  if (gotHeightFill) return true;
  let total = 0; let stretched = 0; let flexGrowCol = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp];
    if (!cs || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    total++;
    if (parentAutoStretchesHeight(node, parentNode, vp)) stretched++;
    const pcs = parentNode?.computedByVp[vp];
    if (pcs && /flex/.test(pcs.display || "") && /column/.test(pcs.flexDirection || "") && pf(cs.flexGrow) > 0) flexGrowCol++;
  }
  if (total < 2) return false;
  if (stretched === total) return true;
  if (flexGrowCol === total && parentDefiniteHeight) return true; // flex-grow item in a definite column
  return !droppedHeight; // keeps a baked-px height → definite containing block
}

/** Properties an INFINITE CSS animation perpetually drives, so their per-viewport captured values
 *  are frozen animation phases (the shutter caught a different point of the cycle at each width),
 *  not responsive design — e.g. a loading spinner's leaf opacity/rotation. Banding them bakes
 *  random-phase noise into breakpoints. We return the set to suppress so the base value holds at
 *  every width (one frozen frame instead of N); the runtime animation overrides it on load, and the
 *  gates cancel animations to the same settled base, so this is band-noise removal, not a paint
 *  change. transform-origin follows transform (skipped when no transform varies). */
const ANIM_OWNED = new Set(["opacity", "transform"]);
const EMPTY_SET = new Set<string>();
/** True when an INFINITE CSS animation is active on the node at this viewport (so it perpetually
 *  drives opacity/transform — the captured value is a frozen animation phase, not design). */
function hasInfiniteAnim(cs: StyleMap | undefined): boolean {
  if (!cs || (cs.animationName || "none") === "none") return false;
  return /infinite/.test(cs.animationIterationCount || "1");
}
/** Properties an infinite animation owns (so their per-viewport captured values are frozen phase
 *  noise to suppress). Sampled across ALL emitted viewports, not just the base: a CSS marquee that
 *  runs only below a breakpoint (Webflow's `max-lg` logo/text tracks) is `animation:none` at the
 *  base (desktop) width but still freezes a random `translateX` at the mobile/tablet bands — banding
 *  those bakes a mid-scroll offset that shifts content offscreen at rest. When the animation owns the
 *  transform at ANY width, the frozen per-band deltas are dropped everywhere and the base value holds
 *  (the runtime `@keyframes` starts at translateX(0), so the strip renders aligned until it animates). */
function animOwnedProps(node: IRNode, viewports: number[]): Set<string> {
  for (const vp of viewports) if (hasInfiniteAnim(node.computedByVp[vp])) return ANIM_OWNED;
  return EMPTY_SET;
}


function declsForViewport(
  node: IRNode,
  parentComputed: StyleMap | undefined,
  vp: number,
  assetMap: Map<string, string>,
  isCentered = false,
  colorVar?: (value: string) => string | null,
  rootScrollHeight?: number,
  widthPlan: WidthPlan = PLAN_FIXED,
  gridCols?: string,
  gridRows?: string,
  flowHeight = false,
  dropInsets: Set<string> = EMPTY_SET,
  leftPct: string | null = null,
  heightFill = false,
  geometry: GeometryPlan = GEOMETRY_NONE,
  dropGridRows = false,
  dropViewportMaxWidth = false,
  nowrapText = false,
  keepIdentityTransform = false,
  forceHeight = false,
): Map<string, string> {
  const cs = node.computedByVp[vp];
  const out = new Map<string, string>();
  if (!cs) return out;
  const tag = node.tag;

  // box-sizing — only emit when content-box (reset is border-box).
  if (cs.boxSizing === "content-box") out.set("box-sizing", "content-box");

  // width — a relative plan replaces the captured px so the box scales / stays centred / fills at
  // any window width while still resolving to the IDENTICAL px at every captured viewport (so the
  // layout/style gates, measured only at those widths, are unmoved):
  //   • fill     → width:100% — a full-bleed flex/grid ITEM in a non-stretching column/grid that
  //                width:auto would shrink to its content (framer's centred-column sections);
  //   • auto     → omit width — a full-bleed / fills-container block tracks its fluid container;
  //   • percent  → width:N% — a stable fractional width;
  //   • flexfill → flex:1 1 0 — an equal-fill flex-row item;
  //   • fixed    → replay the captured computed width, as before.
  // Shared layout flags (used by both width and height below).
  const disp = cs.display || "";
  const pos = cs.position || "static";
  const ov = cs.overflowY || cs.overflow || "visible";
  const parentDisp = parentComputed?.display || "";
  const isFlexGridItem = /flex|grid/.test(parentDisp);
  // A chip in a horizontally-scrollable flex strip (an overflow-x:auto/scroll flex parent) relies on
  // the CSS default `min-width:auto` to stay at its content width so the strip scrolls. The base
  // viewport can report `min-width:0px` on such an item (e.g. a mobile-only strip collapsed to 0 at
  // desktop), which would emit `min-w-0` and let the item shrink below its content — collapsing the
  // strip and colliding its nowrap text. Suppress `min-w-0` for a nowrap flex item whose flex parent
  // scrolls horizontally. This is scoped away from legitimate `min-w-0` truncation (overflow:hidden +
  // ellipsis on the item itself, whose parent does NOT scroll-x), so it is safe.
  const parentOverflowX = parentComputed ? (parentComputed.overflowX || parentComputed.overflow || "visible") : "visible";
  const inScrollXFlexStrip =
    /flex/.test(parentDisp) &&
    /^(auto|scroll)$/.test(parentOverflowX) &&
    (cs.whiteSpace || "normal") === "nowrap";
  const isLeaf = !hasElementChild(node);
  const hasText = node.children.some((c) => isTextChild(c) && c.text.trim() !== "");
  const isTextLeaf = isLeaf && hasText && !REPLACED.has(tag) && tag !== "canvas" && !tag.includes("-");
  const inFlow = pos === "static" || pos === "relative";

  // NOTE: dropping a flex/grid-ITEM text leaf's width (to let it re-derive from content/track)
  // was tried but is NOT provably gate-neutral — it shifts sibling/justify spacing on a handful
  // of nodes (small margin deltas, still within tolerance but not exact). Kept OUT under the
  // "provably-derivable only" bar; planWidth still handles block-level (non-flex-item) widths.
  if (widthPlan.kind === "fill") out.set("width", "100%");
  // Fill-to-cap: width:100% capped by the recovered max-width — reproduces min(parentContent, cap)
  // fluidly, replacing the baked per-viewport px AND any banded/percentage max-width the source had.
  else if (widthPlan.kind === "fillcap") { out.set("width", "100%"); out.set("max-width", widthPlan.cap); }
  else if (widthPlan.kind === "percent") out.set("width", widthPlan.pct);
  // Per-band fractional width (this viewport's regime ratio) — `w-1/2` desktop, `w-full` mobile.
  // The band-delta machinery collapses equal neighbours, so equal regimes emit a single rule.
  else if (widthPlan.kind === "percentVp") { const p = widthPlan.pctByVp[vp]; if (p) out.set("width", p); }
  else if (widthPlan.kind === "flexfill") { out.set("flex-grow", "1"); out.set("flex-basis", "0%"); }
  // A full-width shrink-0 carousel slide: definite main size = container content width, so the flex
  // row stays exactly one container wide (no max-content over-widening). Keeps flex-shrink:0 (source).
  else if (widthPlan.kind === "basisFull") { out.set("flex-basis", "100%"); out.set("flex-shrink", "0"); }
  // A flex-line item's RECOVERED natural width (its flex base size), emitted as a constant at
  // every viewport so the captured per-viewport px collapse to one value — flex-grow/shrink then
  // re-derives the resolved widths. Verified to reproduce every sample before being chosen.
  else if (widthPlan.kind === "basis") out.set("width", widthPlan.px);
  else if (widthPlan.kind === "auto" && REPLACED.has(tag)) out.set("width", "auto");
  else if (widthPlan.kind === "fixed" && cs.width && cs.width !== "auto") out.set("width", cs.width);

  // height: replay the observed border-box height as a fixed value ONLY where
  // margin-collapsing does not apply, otherwise forcing a height would suppress
  // a child's collapsed margin that the source layout relies on. Normal-flow
  // block boxes keep auto height (content-driven) so collapsing is preserved;
  // replaced elements, flex/grid items, BFC establishers (flex/grid/inline-block/
  // table/overflow!=visible), and out-of-flow boxes get the fixed height.
  // (disp/pos/ov/parentDisp/isFlexGridItem/isLeaf hoisted above the width block.)
  const isInlineOnly = disp === "inline";
  // Leaf elements have no element children, so pinning their height cannot
  // suppress a parent↔child collapsed margin — it's always safe and keeps text
  // boxes matching the source exactly.
  const noCollapse =
    REPLACED.has(tag) ||
    tag === "canvas" || tag.includes("-") || // canvas + custom elements (web components, e.g. <model-viewer>) are opaque/replaced-like; preserve their captured box
    /flex|grid|inline-block|inline-flex|inline-grid|table|flow-root/.test(disp) ||
    pos === "absolute" || pos === "fixed" || pos === "sticky" ||
    ov === "auto" || ov === "hidden" || ov === "scroll" ||
    isFlexGridItem;
  // Explicit-height detection: a normal-flow block whose box is taller than its
  // in-flow content has an authored height (e.g. a section sized via height with
  // absolutely-positioned children). Without emitting it the block collapses to
  // its content in the clone. Content-filled blocks stay auto so margin
  // collapsing is preserved.
  // `forceHeight`: the caller proved this node authors a geometry-corroborated fixed height
  // (sourceFixedHeightIntent) but the box's own content extent can't re-derive it (a shrink-0 box whose
  // child fills it — the avatar case), so none of the structural explicit-height tests below fire. Trust
  // the authored value and emit the baked per-band px.
  let explicitHeight = forceHeight;
  const nb = node.bboxByVp[vp];
  // Probe ground truth, emission twin of the heightFlows keep (see the hAuto/hFill guard there):
  // the sizing probe proved height:auto did NOT reproduce this box (hAuto:false) AND it is not a
  // fill child of its own parent (hFill:false), so the captured px is AUTHORED and load-bearing.
  // heightFlows refuses to FLOW such a box, but the emission gate below still needs a matching keep
  // or the height is dropped when the fill-child evidence (the "taller than content" / all-inflow-fill
  // tests) can't fire — an inline `<a>` child probes hAuto:true and content extent equals the box, so
  // neither structural test detects the authored height. Trust the node's own probe.
  {
    const osz = node.sizingByVp?.[vp];
    // Never trust this probe on a document-height wrapper. A root landmark (body/html/main) — or
    // any node whose captured box IS the page's scroll height — probes hAuto:false/hFill:false as
    // measurement noise (min-h-screen + the %-height re-measure chain at document level), not an
    // authored height. Baking that px pins the whole page to a fixed height: combined with an
    // `overflow:hidden` main it hard-clips any content-height drift, and it makes the layout gate's
    // heightDelta tautologically zero (gate blindness). Such wrappers must keep flowing.
    const isRootWrapper = tag === "body" || tag === "html" || tag === "main";
    const isPageHeightBox = !!rootScrollHeight && !!nb && nb.height > 0 &&
      Math.abs(nb.height - rootScrollHeight) <= rootScrollHeight * 0.02;
    if (!noCollapse && !isLeaf && !isRootWrapper && !isPageHeightBox && cs.height && cs.height !== "auto" && osz && osz.hAuto === false && osz.hFill === false) explicitHeight = true;
  }
  if (!noCollapse && !isLeaf && cs.height && cs.height !== "auto" && nb) {
    const top = nb.y + (parseFloat(cs.paddingTop || "0") || 0) + (parseFloat(cs.borderTopWidth || "0") || 0);
    let contentBottom = top;       // includes trailing margins (for taller detection)
    let borderBottom = top;        // border-box extent only (for overflow detection)
    let inflowCount = 0;
    // Are ALL the in-flow element children fill children whose height DERIVES from this
    // node (height:100% / probe hFill)? If so their measured extent equals this box's
    // height only BECAUSE they fill it — it is not content-derived evidence, so it must
    // not be allowed to "explain away" an authored height below.
    let allInflowFill = true;
    const nodeContentH = nb.height - (parseFloat(cs.paddingTop || "0") || 0) - (parseFloat(cs.paddingBottom || "0") || 0) - (parseFloat(cs.borderTopWidth || "0") || 0) - (parseFloat(cs.borderBottomWidth || "0") || 0);
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      const ccs = c.computedByVp[vp]; const cb = c.bboxByVp[vp];
      if (!ccs || !cb || !c.visibleByVp[vp]) continue;
      // Out-of-flow children (absolute/fixed) and floats do not contribute to a
      // block's content height — a parent that contains only floats (clearfix)
      // relies on an authored height, which we must therefore emit.
      if (ccs.position === "absolute" || ccs.position === "fixed") continue;
      if ((ccs.float || "none") !== "none") continue;
      inflowCount++;
      // A fill child derives its height from this box: probe hFill && !hAuto, OR an un-probed
      // <picture>/object-fit:cover replaced child whose border-box == this box's content height.
      // No probe data on a plain block child ⇒ treat as real content (leave allInflowFill off).
      if (!childDerivesHeightFromParent(c, vp, nodeContentH)) allInflowFill = false;
      contentBottom = Math.max(contentBottom, cb.y + cb.height + (parseFloat(ccs.marginBottom || "0") || 0));
      borderBottom = Math.max(borderBottom, cb.y + cb.height);
    }
    const padBottom = (parseFloat(cs.paddingBottom || "0") || 0) + (parseFloat(cs.borderBottomWidth || "0") || 0);
    const contentHeight = contentBottom - nb.y + padBottom;
    if (nb.height > contentHeight + 2) explicitHeight = true;
    if (inflowCount === 0 && nb.height > 2) explicitHeight = true;
    // Authored height whose only in-flow children FILL it (height:100%). The child extent measured
    // the parent's own height back at it (circular), so the "taller than content" test above can never
    // fire — yet dropping the height lets each fill child re-derive its height from content/aspect
    // (a `h-full aspect-video` child then resolves 16/9 of its width, inflating a 240px hero to 720px).
    // Keep the authored height so the fill chain has a definite basis. Probe hFill (not `!hAuto` on the
    // parent) is the guard: hAuto:false on the parent means auto did NOT reproduce, i.e. real authored.
    if (inflowCount > 0 && allInflowFill && node.sizingByVp?.[vp]?.hAuto === false && nb.height > 2) explicitHeight = true;
    // Overflow case: the box is meaningfully SHORTER than its in-flow content's
    // border boxes. Content cannot shrink a box below its own size, so the height
    // is authored (e.g. html,body{height:100%} with overflowing content). Compare
    // against border-box bottom — never trailing margin — so a margin that
    // collapses out of the box is not mistaken for overflow.
    if (inflowCount > 0 && nb.height + 2 < borderBottom - nb.y + padBottom) explicitHeight = true;
  }
  // A CSS table's computed height already includes its caption, but the caption
  // (display:table-caption) is laid out outside the table grid box — so emitting
  // that height makes the caption add a second time (Wikipedia figures rendered
  // one caption-height too tall). Let such tables size to content instead.
  const isTableWithCaption = (disp === "table" || disp === "inline-table") &&
    node.children.some((c) => !isTextChild(c) && (c as IRNode).computedByVp[vp]?.display === "table-caption");
  // Inline non-replaced boxes (spans/links) have auto height, so skip it — but
  // inline *replaced* elements (img/svg/video…) carry a real, often non-intrinsic
  // height that must be emitted, else they collapse to their attribute/intrinsic
  // size (e.g. a Wikipedia inline logo rendering 27px instead of 124px).
  // Root scroll-lock un-clamp (fidelity tail): a site that locks scrolling during an
  // intro — body/html { height:100vh; overflow-y:scroll|hidden } — can be captured in
  // that transient state, pinning the root to one viewport so it CLIPS its overflowing
  // content; the clone's document.scrollHeight then collapses to one viewport and the
  // page renders truncated (paco.me). Two independent signals prove the lock is transient:
  //   • captured scrollHeight exceeds the pinned height (the real document scrolled taller); OR
  //   • the IR's own IN-FLOW content extent (max descendant border-box bottom) exceeds the clamp.
  // The SECOND signal is essential for an email-capture popup that scroll-LOCKS the page: the
  // lock collapses `document.scrollHeight` down to the viewport (== clamp), so the scrollHeight
  // test can never fire in exactly the worst case — but the in-flow sections still carry their
  // real coordinates, so the content extent (5000px+ on a real homepage) still betrays the clamp.
  // A genuine internal-scroll shell has matching content extent AND scrollHeight, so neither fires.
  const clampH = parseFloat(cs.height || "");
  const contentExtent = (tag === "body" || tag === "html") ? irContentExtent(node, vp) : 0;
  const rootUnclamp =
    (tag === "body" || tag === "html") &&
    clampH > 0 &&
    ((!!rootScrollHeight && rootScrollHeight > clampH + 4) || contentExtent > clampH + 4) &&
    /^(scroll|hidden|auto|clip)$/.test(cs.overflowY || cs.overflow || "visible");
  // A pure-text leaf's height is fully content-derived (padding/border + lines × line-height).
  // We reproduce the font, line-height, padding and width, so its height auto-resolves to the
  // SAME px at every captured width — emitting it just freezes the box (and breaks the moment
  // the copy is edited, the #1 readability complaint). Drop it for an in-flow, non-clipping,
  // non-replaced text leaf; keep it where the box clips (overflow) or is positioned, where the
  // height is load-bearing. Gate-neutral: the computed height is unchanged at 375/768/1280/1920.
  // Drop the baked height for a text leaf OR a flow-eligible flex/grid box (heightFlows). Geometry
  // fidelity is enforced by the layout (sections + leaf size + position) and perceptual gates.
  // A text leaf's height is content-derived ONLY when it equals padding/border + an integer number
  // of line-boxes. A control authored TALLER than its text — a button with height:32px vertically
  // centering a 20px label — is NOT content-derived, and dropping it squashes the button to the
  // text height (the "Start for Free" / CTA buttons rendered ~8px short). Keep the height there.
  const lineH = pf(cs.lineHeight);
  const padBorderV = pf(cs.paddingTop) + pf(cs.paddingBottom) + pf(cs.borderTopWidth) + pf(cs.borderBottomWidth);
  const rows = lineH > 0 && nb ? (nb.height - padBorderV) / lineH : 1;
  // Flowing text lives in a block/inline box. A flex/grid box sizes and (usually) centers its content,
  // so its height is LOAD-BEARING: a single-line label in a button whose height is an exact multiple
  // of the line-height reads as rows≈2 here but is NOT two lines of text — dropping it squashes the
  // button to the label height. Only block/inline flow has a genuinely content-derived height.
  const flowsText = /^(block|inline|inline-block|list-item)$/.test(cs.display || "");
  const textHeightIsContentDerived = flowsText && (!(lineH > 0) || Math.abs(rows - Math.round(rows)) < 0.15);
  const plannedHeight = geometry.heightByVp?.[vp];
  const plannedAspect = geometry.aspectByVp?.[vp];
  const dropHeight = plannedAspect !== undefined || (isTextLeaf && inFlow && ov === "visible" && textHeightIsContentDerived) || flowHeight;
  if (plannedHeight) {
    out.set("height", plannedHeight);
  } else if (heightFill) {
    out.set("height", "100%"); // fills its (definite) parent — overrides the baked px / the flow drop
  } else if (cs.height && cs.height !== "auto" && !isTableWithCaption && !rootUnclamp && !dropHeight && (!isInlineOnly || REPLACED.has(tag)) && (noCollapse || isLeaf || explicitHeight)) {
    out.set("height", cs.height);
  }
  if (cs.minHeight && cs.minHeight !== "0px" && cs.minHeight !== "auto") {
    out.set("min-height", isViewportHeight(cs.minHeight, vp) ? "100vh" : cs.minHeight);
  }

  // borders (complete triple per side, only when width > 0). When all four sides are
  // identical (width + style + color), emit the un-sided SHORTHAND (border-width/style/color)
  // — a 1:1 equivalent of four equal longhands (so getComputedStyle is unchanged, gate-neutral)
  // that the Tailwind emitter renders as `border border-solid border-<token>` instead of the
  // 12-utility per-side wall.
  const SIDES = ["Top", "Right", "Bottom", "Left"];
  const bw = (s: string) => cs[`border${s}Width`];
  const bs = (s: string) => cs[`border${s}Style`] || "solid";
  const bcRaw = (s: string) => cs[`border${s}Color`];
  const allFour = SIDES.every((s) => { const w = bw(s); return w && parseFloat(w) > 0; });
  const uniform = allFour &&
    SIDES.every((s) => bw(s) === bw("Top")) &&
    SIDES.every((s) => bs(s) === bs("Top")) &&
    SIDES.every((s) => bcRaw(s) === bcRaw("Top"));
  if (uniform) {
    out.set("border-width", bw("Top")!);
    out.set("border-style", bs("Top"));
    const c = bcRaw("Top");
    if (c) out.set("border-color", (colorVar && colorVar(c)) || c);
  } else {
    for (const side of SIDES) {
      const w = bw(side);
      if (w && parseFloat(w) > 0) {
        out.set(`border-${side.toLowerCase()}-width`, w);
        out.set(`border-${side.toLowerCase()}-style`, bs(side));
        const c = bcRaw(side);
        if (c) out.set(`border-${side.toLowerCase()}-color`, (colorVar && colorVar(c)) || c);
      }
    }
  }

  const hasTransform = cs.transform && cs.transform !== "none";
  // A scroll/view-timeline-driven animation reports its resolved `animation-duration` as
  // `auto` (the duration is derived from the timeline range, not a time). The clone has no
  // scroll timeline, so emitting such an animation makes it jump straight to its END keyframe
  // (`fill-mode:both` + a 0s time-based duration), freezing the element at the fully-progressed
  // state (e.g. a scroll-linked text-fill stuck 100% filled). We do NOT replay scroll-linked
  // animations; the goal is the correct AT-REST render. So suppress the animation-* props for
  // an animation whose duration is `auto`, and let the captured static properties (now recorded
  // at-rest, scroll reset + timeline animations canceled before the snapshot) stand.
  const isScrollTimelineAnim = (cs.animationDuration || "").split(",").some((d) => d.trim() === "auto");
  const hasAnimation = cs.animationName && cs.animationName !== "none" && !isScrollTimelineAnim;

  for (const { prop, def } of GENERIC) {
    const value = cs[prop];
    if (value === undefined || value === "") continue;
    if (SPECIAL.has(prop)) continue;
    // The `gap` shorthand is fully reconstructed by row-gap + column-gap (both always reported by
    // getComputedStyle and emitted below). Emitting it too produces a redundant `gap-[normal_10px]`
    // beside `gap-x-…`; drop it so only the axis utilities (which collapse to `gap-N` when equal) remain.
    if (prop === "gap") continue;
    // grid-template-columns is replaced by the fluid (fr) template when one was inferred —
    // emitted once below so it never bands per-viewport-px.
    if (prop === "gridTemplateColumns" && gridCols !== undefined) continue;
    // grid-template-rows likewise replaced by the fluid (1fr) template when one was inferred.
    // NEVER drop a `subgrid` template: it is a STRUCTURAL keyword (the row tracks are inherited from
    // the parent grid so both stacked layers share row sizing), not a frozen per-viewport px regime.
    // `dropGridRows` exists to strip baked px row heights in reflow mode, but computed
    // getComputedStyle reports the keyword literally ("subgrid [] …") — dropping it collapses the
    // empty layer's row-1 to 0 and its media overlaps the text layer. Emit it (tailwind maps it to
    // `grid-rows-subgrid`); the fluidGridRows path already refuses to touch subgrid nodes, so gridRows
    // is undefined here and this keyword flows straight through.
    if (prop === "gridTemplateRows" && /\bsubgrid\b/.test(value || "")) { out.set("grid-template-rows", "subgrid"); continue; }
    if (prop === "gridTemplateRows" && (gridRows !== undefined || dropGridRows)) continue;
    // fill-to-cap sets max-width to the recovered cap (above); don't let the source value re-emit it.
    if (prop === "maxWidth" && widthPlan.kind === "fillcap") continue;
    // A max-width equal to the viewport at every sampled width is a resolved guard like
    // max-width:100vw, not a fixed cap. Emitting the used px per band freezes full-bleed roots.
    if (prop === "maxWidth" && dropViewportMaxWidth) continue;
    // Recovered aspect-ratio replaces baked height/grid rows.
    if (prop === "aspectRatio" && plannedAspect) continue;

    // Special-case defaults expressed as sentinels.
    if (prop === "transformOrigin" && !hasTransform) continue;
    if (prop === "webkitTextFillColor") {
      if (cs.webkitBackgroundClip !== "text" && value === cs.color) continue;
    }
    if (prop === "webkitTextStroke") {
      if (/^0px(\s|$)/.test(value) || value === "0") continue;
    }
    if (ANIMATION_PROPS.has(prop) && !hasAnimation) continue;
    if (prop === "listStyleType") {
      if (!/^(ul|ol|li|menu)$/.test(tag)) continue;
      // list reset is none; emit whatever the source uses (incl. none).
    } else if (prop === "minWidth") {
      if (value === "auto" || (value === "0px" && !isFlexGridItem) || (value === "0px" && inScrollXFlexStrip)) continue;
    } else if (prop === "transform") {
      // Emit the identity `transform:none` explicitly at a viewport whose value is `none` WHEN the node
      // carries a non-identity transform at some OTHER band — otherwise the non-identity value cascades
      // across bands and freezes at a width the source left untransformed. (Identity matrices are already
      // canonicalized to the literal "none" upstream, so the string compare is reliable.) When the node
      // is identity everywhere, this stays a normal default elision.
      if (value === "none" && !keepIdentityTransform) continue;
    } else if (def === "__never__") {
      // always emit (display/color/fontFamily/fontSize handled below for inherit)
    } else if (isDefault(def, value)) {
      continue;
    }

    // Inherited: skip when equal to parent's value (inheritance handles it).
    // Exception: the reset (`ul, ol, menu { list-style: none; }`) breaks the list-marker
    // inheritance chain on those tags, so parent-equality is not a safe elision there —
    // a source <ul> with `disc` equals its parent's initial `disc` yet must still emit
    // or the reset erases the markers. <li> inherits from the ul, which now emits.
    if (INHERITED.has(prop) && parentComputed && parentComputed[prop] === value) {
      const listMarkerReset = (prop === "listStyleType" || prop === "listStylePosition") && /^(ul|ol|menu)$/.test(tag);
      if (!listMarkerReset) continue;
    }

    let outValue = value;
    if (prop === "backgroundImage" || prop === "maskImage" || prop === "filter" || prop === "clipPath") {
      if (value.includes("url(")) outValue = rewriteUrls(value, assetMap);
    } else if ((prop === "color" || prop === "backgroundColor") && colorVar) {
      // Stage 3.5: reference the semantic color token (var(--…)) when this value is
      // tokenized; the token resolves to the same value (±2 cluster, within the
      // grader's color tolerance), so this is fidelity-neutral.
      outValue = colorVar(value) || outValue;
    }
    out.set(kebab(prop), outValue);
  }

  // Wrap-vulnerable single-line text: the text renders on one line at every captured width and its
  // unwrapped width nearly equals the container's available width, so a sub-pixel width shortfall in
  // the clone (a column resolving ~0.6px narrower) tips it onto a second line, shifting everything
  // below. `white-space:nowrap` holds it to one line — identical to the capture (already single-line
  // at every width) but immune to the rounding shortfall. Only the source `whiteSpace` value that
  // already collapses runs (`normal`/`nowrap`) is overridden; `pre`/`pre-wrap`/`break-spaces` preserve
  // authored whitespace and are left untouched (the caller's detector also excludes them).
  if (nowrapText) out.set("white-space", "nowrap");

  // Centered max-width container: emit auto side margins so the browser centers
  // it at every width. getComputedStyle sometimes reports 0 for resolved auto
  // margins at wide viewports, so replaying px would left-align the clone.
  // The fill-inset guard lives in the centering DECISION (centeredAtVp): a full-width block merely
  // inset by a fixed gutter is no longer flagged centred, so its literal px margins are kept and it
  // never bleeds full-bleed from a `margin:auto` that resolves to 0.
  if (isCentered) {
    out.set("margin-left", "auto");
    out.set("margin-right", "auto");
  }

  // Root un-clamp: relax the clipping vertical overflow so the document scrolls at the
  // window level (no spurious scrollbar gutter) and grows to its content height. Popup
  // vendors also inject `position:absolute|fixed` + `overflow:hidden` on <body> to freeze
  // the page under their modal; that lock state gets captured as the body's computed style
  // and, unstripped, hard-clips the clone to one screen (it can't scroll). Strip both — the
  // real body is `position:static; overflow:visible` — so the un-clamped root scrolls normally.
  if (rootUnclamp) {
    out.set("overflow-y", "visible");
    out.set("overflow-x", "visible");
    out.delete("overflow");
    out.delete("height");
    const posV = out.get("position");
    if (posV === "absolute" || posV === "fixed") out.delete("position");
    for (const side of ["top", "right", "bottom", "left"]) out.delete(side);
  }

  // Fluid grid columns (fr) replace the baked per-viewport px tracks so the grid scales.
  if (gridCols !== undefined) out.set("grid-template-columns", gridCols);
  // Fluid grid rows (1fr) likewise replace baked equal per-viewport px row tracks.
  if (gridRows !== undefined) out.set("grid-template-rows", gridRows);

  // Drop an over-constrained inset. For an absolutely/fixed-positioned box that pins one edge
  // AND its size, getComputedStyle still reports the opposite edge as a resolved px (e.g.
  // top:0 + height:44px on a full-height container → bottom:5525px, the distance to the far
  // edge). That value is fully derived — emitting it just freezes a measurement (the absurd
  // `bottom-[5525px]` on a sticky bar). Dropping it is gate-neutral: with the edge + size kept,
  // the browser re-derives the identical resolved opposite edge at every captured width.
  if (pos === "absolute" || pos === "fixed") {
    // Ground truth first: drop every side the inset-anchor probe proved is a
    // filled-in used value (setting it to auto didn't move the box at any painted width). This
    // catches anchors the static rule below misses — `right` derived from an explicit width with NO
    // baked `width` util, `bottom` under a min-height, the 0×0 overlay whose right = viewport width.
    for (const side of dropInsets) out.delete(side);
    // Static fallback for nodes the probe didn't read (no overlay): an over-constrained box that
    // pins one edge AND its size reports the opposite edge as a resolved px (top:0 + height → the
    // absurd bottom-[5525px] on a sticky bar). Gate-neutral: edge + size re-derive it.
    if (out.has("top") && out.has("bottom") && out.has("height")) out.delete("bottom");
    if (out.has("left") && out.has("right") && out.has("width")) out.delete("right");
    // Snap a near-zero remaining inset to 0 — a kept anchor reported as 0.015625px is rounding noise
    // for `right: 0` and should read `right-0`, not `right-[0.015625px]`. Sub-half-pixel ⇒ gate-neutral.
    for (const side of ["top", "right", "bottom", "left"]) {
      const v = out.get(side);
      if (v && v !== "auto" && Math.abs(parseFloat(v)) < 0.5) out.set(side, "0px");
    }
    // Centred overlay: replace the baked `left:Npx` with the constant `left:N%` so it tracks the
    // centre between breakpoints (the translate is already replayed). Same px at every captured width.
    if (leftPct) out.set("left", leftPct);
    const plannedLeft = geometry.leftByVp?.[vp];
    const plannedTop = geometry.topByVp?.[vp];
    if (plannedLeft && out.has("left")) out.set("left", plannedLeft);
    if (plannedTop && out.has("top")) out.set("top", plannedTop);
  }

  if (plannedAspect) out.set("aspect-ratio", plannedAspect);

  // Replaced elements (img/svg/video/canvas/controls) have integer intrinsic pixels; a sub-pixel
  // display width/height is layout rounding, so a logo bakes the absurd w-[131.188px]. Snap to the
  // nearest integer — within the style gate's tolerance ⇒ gate-neutral — so it reads w-[131px].
  if (REPLACED.has(tag)) {
    for (const k of ["width", "height"]) {
      const v = out.get(k);
      if (v && /^-?[\d.]+px$/.test(v)) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && Math.abs(n - Math.round(n)) > 0.01) out.set(k, `${Math.round(n)}px`);
      }
    }
  }

  // Line clamp (`display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:N`): truncates
  // text to N lines, the mechanism that holds a card to a fixed height regardless of how long its
  // text is. Without it the engine sees only the RESULTING px height and bakes or drops it per card,
  // so a long quote overflows while its neighbours stay short — the uneven-card bug. Emit the single
  // `-webkit-line-clamp:N` decl (→ Tailwind `line-clamp-N`, which itself sets the display /
  // box-orient / overflow), suppressing those companions so they don't double-emit.
  const lc = pf(cs.webkitLineClamp);
  if (lc >= 1 && Number.isInteger(lc) && ((cs.webkitBoxOrient && /vertical/.test(cs.webkitBoxOrient)) || (cs.overflow || cs.overflowY) === "hidden")) {
    out.set("-webkit-line-clamp", String(lc));
    out.delete("display");                                   // line-clamp-N provides display:-webkit-box
    if ((out.get("overflow") || "") === "hidden") out.delete("overflow");
  }

  return out;
}

/** Detect `margin: … auto`-style horizontal centering of a normal-flow block at a
 * specific viewport (decided per-band by the caller). Two signals:
 *   1) explicit equal positive side margins, or
 *   2) the box sits with equal positive gaps inside its parent's content box while
 *      reporting ~0 margins — getComputedStyle sometimes resolves auto margins to
 *      0px, which would otherwise left-align the clone.
 * Excludes out-of-flow/float boxes and flex/grid items (the parent's own layout,
 * which we replay, positions those) and inline-level boxes (centered via text-align). */
/** Do this node's left margins differ by >1px across the viewports where it's painted? Auto-margin
 *  centering slack varies with the container width; fixed structural spacing stays constant. Used to
 *  keep a constant equal margin literal (not `auto`) so it survives a shrink-wrapping parent. */
function marginsVaryAcrossVps(node: IRNode): boolean {
  const ms: number[] = [];
  for (const key of Object.keys(node.computedByVp)) {
    const vp = Number(key);
    if (!node.visibleByVp[vp]) continue;
    const ml = parseFloat(node.computedByVp[vp]?.marginLeft || "0");
    if (Number.isFinite(ml)) ms.push(ml);
  }
  return ms.length >= 2 && Math.max(...ms) - Math.min(...ms) > 1;
}

/** Does the box's WIDTH grow in near-lockstep with its container across viewports? Then it is a
 *  full-width block INSET by a fixed gutter (an `mx-4 md:mx-8` section — box == container − 2·gutter),
 *  NOT a centred content box (whose width stays roughly constant while the container grows and the
 *  side margins absorb the widening slack). The two are indistinguishable at a SINGLE width (both show
 *  equal side gaps), and the sizing probe reads BOTH as `wAuto:true` (auto reproduces the inset width).
 *  The discriminator is the trajectory: a centred 600px box in a 375→1280 container barely widens
 *  (Δbox ≪ Δcontainer), while a gutter-inset section tracks the container (Δbox ≈ Δcontainer). Used to
 *  keep auto-margin centring OFF a width-dropped fill-inset block — where `margin:auto` resolves to 0
 *  and blows it full-bleed — while still centring genuinely content-constrained blocks. */
function widthTracksContainerFill(node: IRNode, parentNode: IRNode, viewports: number[]): boolean {
  const bw: number[] = []; const cw: number[] = [];
  for (const vp of viewports) {
    const nb = node.bboxByVp[vp]; const pb = parentNode.bboxByVp[vp]; const pcs = parentNode.computedByVp[vp];
    if (!nb || !pb || !node.visibleByVp[vp]) continue;
    const content = pb.width - pf(pcs?.paddingLeft) - pf(pcs?.paddingRight) - pf(pcs?.borderLeftWidth) - pf(pcs?.borderRightWidth);
    if (!(content > 0)) continue;
    bw.push(nb.width); cw.push(content);
  }
  if (bw.length < 2) return false;
  const dBox = Math.max(...bw) - Math.min(...bw);
  const dCon = Math.max(...cw) - Math.min(...cw);
  if (dCon <= 8) return false;                 // container barely varies → trajectory says nothing
  return dBox / dCon > 0.5;                     // box widens ≥ half as fast as the container → tracks it
}

function centeredAtVp(node: IRNode, parentNode: IRNode, vp: number): boolean {
  const cs = node.computedByVp[vp];
  const nb = node.bboxByVp[vp];
  const pb = parentNode.bboxByVp[vp];
  if (!cs || !nb || !pb) return false;
  if (cs.position === "absolute" || cs.position === "fixed") return false;
  if ((cs.float || "none") !== "none") return false;
  const pcs = parentNode.computedByVp[vp];
  const disp = cs.display || "";
  const pdisp = pcs?.display || "";
  const parentFlexGrid = /flex|grid/.test(pdisp);
  // margin:auto only centers BLOCK-LEVEL normal-flow boxes. For inline-level boxes
  // (inline/inline-block/inline-flex) auto margins resolve to 0 — converting an
  // explicit equal margin to auto would *delete* the spacing (duolingo inline-block
  // <li>s: 12px → 0). Flex/grid items are positioned by the parent layout we
  // replay, so only explicit auto-margin evidence is allowed for them below.
  // Block-LEVEL boxes are margin-auto-centerable: block/list-item/flow-root/table and
  // also `grid`/`flex` *containers* (a grid/flex box is block-level in normal flow, so
  // `margin: 0 auto` centers it — getComputedStyle resolves those autos to 0, so it
  // must be re-centered like a block, e.g. a centered `<main class=grid>`). Parent
  // flex/grid is already excluded above, so grid/flex *items* never reach here.
  // inline-level boxes (inline/inline-block/inline-flex/inline-grid) are NOT centered
  // by margin auto (they center via the parent's text-align), so they stay excluded.
  if (!/^(block|list-item|flow-root|table|grid|flex)$/.test(disp)) return false;
  const ml = parseFloat(cs.marginLeft || "0");
  const mr = parseFloat(cs.marginRight || "0");
  // Signal 1: explicit equal positive margins on a block with room to center
  // (auto reproduces the same gap, and stays centered at intermediate widths). Gate on the margin
  // actually VARYING across viewports: margin-auto centering slack grows/shrinks with the container,
  // whereas a CONSTANT equal margin is fixed structural spacing (e.g. an 8px inter-card gutter in a
  // marquee). Converting fixed spacing to `auto` deletes it when the parent shrink-wraps the child
  // (auto resolves to 0) — exactly how the testimonial inter-card gap vanished. Literal margins
  // reproduce that spacing at every width regardless of the parent's resolved width.
  // The width must ALSO be genuinely constrained: a box the sizing probe reads as a container-FILL
  // (`width:100%` reproduces it) has no free space for auto margins to absorb — the emitted width
  // is set to 100% (fill/fillcap), so `margin:auto` resolves to 0 and silently deletes real literal
  // px side margins, blowing a padded pill/section out to full-bleed. Equal literal margins are the
  // geometric TWIN of centering slack (both split the free space symmetrically), so this probe read
  // is the only reliable discriminator between them; when the box fills, keep the literal margins.
  // A box the probe reads as a container-FILL (`width:100%` reproduces it) has no free space for auto
  // margins to absorb. So does a full-width block merely INSET by a fixed gutter (`mx-4 md:mx-8`): the
  // probe reads it `wAuto:true, wFill:false` (auto reproduces the inset width) and its symmetric
  // margins vary per breakpoint — so it slips past `!fillsAtVp` and looks centred at any single width,
  // yet its width TRACKS the container. Emitting `margin:auto` on it (after its width is dropped to
  // auto) resolves the margins to 0 and blows it full-bleed. `widthTracksContainerFill` catches that
  // trajectory; a genuinely centred content box (constant width, ballooning margins) does not track.
  const fillsAtVp = node.sizingByVp?.[vp]?.wFill === true;
  const gutterInset = widthTracksContainerFill(node, parentNode, Object.keys(node.computedByVp).map(Number));
  if (ml > 0.5 && Math.abs(ml - mr) < 1 && nb.width < pb.width - 4 && marginsVaryAcrossVps(node) && !fillsAtVp && !gutterInset) return true;
  if (parentFlexGrid) return false;
  // Signal 2: bbox-centered within the parent content box with ~0 reported margins.
  if (Math.abs(ml) > 0.5 || Math.abs(mr) > 0.5) return false; // margins already explain position
  const padL = (parseFloat(pcs?.paddingLeft || "0") || 0) + (parseFloat(pcs?.borderLeftWidth || "0") || 0);
  const padR = (parseFloat(pcs?.paddingRight || "0") || 0) + (parseFloat(pcs?.borderRightWidth || "0") || 0);
  const contentLeft = pb.x + padL;
  const contentRight = pb.x + pb.width - padR;
  const leftGap = nb.x - contentLeft;
  const rightGap = contentRight - (nb.x + nb.width);
  return leftGap > 1 && rightGap > 1 && Math.abs(leftGap - rightGap) < 1.5 && nb.width < contentRight - contentLeft - 2;
}

/** A single-line text leaf whose unwrapped width nearly fills its container's available width at
 *  EVERY captured viewport where it's painted — so any sub-pixel width shortfall in the clone (a
 *  column resolving fractionally narrower) tips it onto a second line. Such a node earns an explicit
 *  `white-space:nowrap` (see declsForViewport) to stay one line as it did in the capture.
 *  Conservative by construction — every guard must hold at every painted viewport:
 *   • text leaf (direct text, no element children), whitespace not already preserved (`pre*`);
 *   • single line: box height ≈ one line box (line-height + vertical padding/border), so a genuinely
 *     wrapping paragraph (≥2 line boxes tall) is excluded;
 *   • wrap-vulnerable: max-content (unwrapped) width ≥ available container width − 2 and ≤ it + 1 —
 *     the text needs essentially all the available width, with no slack for a rounding shortfall;
 *   • genuinely wrappable: min-content < max-content − 2, so a single unbreakable token (which can
 *     never wrap, making nowrap a redundant no-op) is skipped to keep the emission minimal.
 *  Relies on the sizing probe's wMin/wMax (present only for in-flow probed leaves); absent ⇒ no emit. */
function nowrapWrapVulnerable(node: IRNode, parentNode: IRNode | undefined, viewports: number[]): boolean {
  if (!parentNode) return false;
  if (hasElementChild(node)) return false;
  if (!node.children.some((c) => isTextChild(c) && c.text.trim() !== "")) return false;
  if (REPLACED.has(node.tag) || node.tag === "canvas" || node.tag.includes("-")) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    if (!cs || !nb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if (!(nb.width > 0) || !(nb.height > 0)) continue;
    const ws = cs.whiteSpace || "normal";
    if (ws !== "normal" && ws !== "nowrap") return false; // pre/pre-wrap/break-spaces preserve authored whitespace
    const sz = node.sizingByVp?.[vp];
    const wMax = sz?.wMax; const wMin = sz?.wMin;
    if (wMax == null || wMin == null) return false;
    const lineBox = pf(cs.lineHeight) + pf(cs.paddingTop) + pf(cs.paddingBottom) + pf(cs.borderTopWidth) + pf(cs.borderBottomWidth);
    if (!(lineBox > 0) || Math.abs(nb.height - lineBox) > 2.5) return false; // not single-line
    const avail = containingWidthAt(node, parentNode, vp);
    if (avail == null) return false;
    if (!(wMax >= avail - 2 && wMax <= avail + 1)) return false; // not right at the container edge
    if (!(wMin < wMax - 2)) return false;                        // single unbreakable token — can't wrap
    painted++;
  }
  return painted >= 1;
}

function hasPxMaxWidthCap(node: IRNode, viewports: number[]): boolean {
  const caps: number[] = [];
  for (const vp of viewports) {
    if (!node.visibleByVp[vp]) continue;
    const cs = node.computedByVp[vp];
    if (!cs || (cs.display || "") === "none") continue;
    const maxW = cs.maxWidth || "";
    if (maxW.endsWith("px")) caps.push(pf(maxW));
    else if (maxW && maxW !== "none") return false;
  }
  if (!caps.length) return false;
  const max = Math.max(...caps);
  const min = Math.min(...caps);
  return max > 0 && max - min <= Math.max(2, max * 0.02);
}

function hasElementChild(node: IRNode): boolean {
  for (const c of node.children) if (!isTextChild(c)) return true;
  return false;
}

function hasVisibleText(node: IRNode): boolean {
  for (const c of node.children) {
    if (isTextChild(c)) {
      if (c.text.trim()) return true;
    } else if (hasVisibleText(c)) return true;
  }
  return false;
}

function isTransparentColor(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent" || v === "rgba(0, 0, 0, 0)" || v === "rgba(0,0,0,0)") return true;
  const rgba = v.match(/^rgba?\((.*)\)$/);
  if (rgba) {
    const parts = rgba[1]!.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
    const alpha = parts[3];
    if (alpha != null && Number.parseFloat(alpha) === 0) return true;
  }
  return false;
}

function isEmptyPseudoContent(value: string | undefined): boolean {
  return !value || value === "none" || value === "normal" || value === '""' || value === "''";
}

function isPinnedInset(value: string | undefined): boolean {
  return value != null && value !== "" && value !== "auto";
}

function isRestingInteractiveFillPseudo(node: IRNode, styleByVp: Record<number, StyleMap>, viewports: number[]): boolean {
  const interactive = node.tag === "a" || node.tag === "button" || node.attrs.role === "button";
  if (!interactive || !hasVisibleText(node)) return false;
  let checked = 0;
  for (const vp of viewports) {
    const host = node.computedByVp[vp];
    const pseudo = styleByVp[vp];
    if (!host || !pseudo || pseudo.display === "none") continue;
    checked++;
    if (!isEmptyPseudoContent(pseudo.content)) return false;
    if (!/^(absolute|fixed)$/.test(pseudo.position || "")) return false;
    if (pf(pseudo.zIndex) >= 0) return false;
    if (![pseudo.top, pseudo.right, pseudo.bottom, pseudo.left].every(isPinnedInset)) return false;
    if (isTransparentColor(pseudo.backgroundColor) || (pseudo.backgroundImage && pseudo.backgroundImage !== "none")) return false;
    if (isTransparentColor(host.backgroundColor) || (host.backgroundImage && host.backgroundImage !== "none")) return false;
  }
  return checked > 0;
}

// Type props (color/size/leading/tracking/align) only render when the pseudo has TEXT. An empty
// `content:""` box (the common decorative overlay / hit-area / focus-ring) inherits a font-size &
// line-height from its host that getComputedStyle reports but that paint nothing — baking them is
// pure noise (and a pile of sub-pixel decimals). Drop them when content is empty; keep when there's
// an actual glyph/counter/attr to render.
const PSEUDO_TEXT_ONLY = new Set(["color", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "whiteSpace"]);
function pseudoDecls(style: StyleMap, assetMap: Map<string, string>): Map<string, string> {
  const decls = new Map<string, string>();
  const content = style.content;
  const contentVal = content && content !== "none" ? content : '""';
  decls.set("content", contentVal);
  const emptyContent = contentVal === '""' || contentVal === "''";
  const map: Array<[string, string | string[]]> = [
    ["display", "inline"], ["position", "static"], ["top", "auto"], ["right", "auto"],
    ["bottom", "auto"], ["left", "auto"], ["zIndex", "auto"],
    ["float", "none"], ["clear", "none"], // clearfix ::after { clear: both } must survive
    ["width", "auto"], ["height", "auto"],
    ["marginTop", "0px"], ["marginRight", "0px"], ["marginBottom", "0px"], ["marginLeft", "0px"],
    ["paddingTop", "0px"], ["paddingRight", "0px"], ["paddingBottom", "0px"], ["paddingLeft", "0px"],
    ["color", "__never__"], ["fontSize", "__never__"], ["fontWeight", "400"],
    ["lineHeight", "normal"], ["letterSpacing", "normal"], ["textAlign", "start"],
    ["backgroundColor", ["rgba(0, 0, 0, 0)", "transparent"]], ["backgroundImage", "none"],
    ["backgroundSize", "auto"], ["backgroundPosition", ["0% 0%", "0px 0px"]], ["backgroundRepeat", "repeat"],
    ["boxShadow", "none"], ["opacity", "1"], ["transform", "none"], ["transformOrigin", "__skip__"],
    ["filter", "none"], ["overflow", "visible"], ["objectFit", "fill"], ["borderTopLeftRadius", "0px"],
    ["flexShrink", "1"], ["flexGrow", "0"], ["flexBasis", "auto"], ["alignSelf", "auto"], ["order", "0"],
  ];
  const hasTransform = style.transform && style.transform !== "none";
  for (const [prop, def] of map) {
    const v = style[prop];
    if (v === undefined || v === "") continue;
    if (emptyContent && PSEUDO_TEXT_ONLY.has(prop)) continue; // inert on an empty pseudo
    if (prop === "transformOrigin" && !hasTransform) continue;
    if (def !== "__never__" && isDefault(def, v)) continue;
    let outV = v;
    if ((prop === "backgroundImage") && v.includes("url(")) outV = rewriteUrls(v, assetMap);
    decls.set(kebab(prop), outV);
  }
  return decls;
}

// Structured per-node rule (base decls + per-band deltas + pseudo rules). Computed
// once (collectNodeRules) and consumed by BOTH the legacy per-node emitter
// (generateCss → `.c<id>{…}`) and the semantic class-map emitter (classMap.ts →
// shared, named classes). Keeping one source of truth means the two emitters can
// never disagree about a node's styles — so deduping nodes by their rule guarantees
// the grouped class produces identical computed styles (fidelity-neutral).
export type BandRule = { media: string; decls: Map<string, string> };
export type PseudoRule = { base: Map<string, string>; bands: BandRule[] };
export type NodeRule = { base: Map<string, string>; bands: BandRule[]; before?: PseudoRule; after?: PseudoRule; placeholder?: PseudoRule };

/** ::placeholder declarations for a form control. Color always emits (the UA default is
 *  its own gray, NOT inherited from the input, so equality with the host proves nothing);
 *  font/spacing props DO inherit from the input inside the pseudo, so they emit only when
 *  they differ from the host's own computed value. */
function placeholderDecls(style: StyleMap, host: StyleMap | undefined): Map<string, string> {
  const decls = new Map<string, string>();
  if (style.color) decls.set("color", style.color);
  if (style.opacity && style.opacity !== "1") decls.set("opacity", style.opacity);
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "textTransform"]) {
    const v = style[prop];
    if (!v || (host && host[prop] === v)) continue;
    decls.set(kebab(prop), v);
  }
  return decls;
}

/** Banded ::placeholder rule (mirrors collectPseudoRule's base+delta shape). */
function collectPlaceholderRule(styleByVp: Record<number, StyleMap>, hostByVp: Record<number, StyleMap>, baseVp: number, bands: Band[], tokenResolver?: TokenResolver): PseudoRule | undefined {
  const baseStyle = styleByVp[baseVp] ?? Object.values(styleByVp)[0];
  if (!baseStyle) return undefined;
  const out: PseudoRule = { base: finalizeDecls(placeholderDecls(baseStyle, hostByVp[baseVp]), tokenResolver), bands: [] };
  for (const b of bands) {
    if (!b.media) continue;
    const st = styleByVp[b.vp];
    if (!st) continue; // control not rendered at this width — the host rule already hides it
    const vpDecls = finalizeDecls(placeholderDecls(st, hostByVp[b.vp]), tokenResolver);
    const delta = new Map<string, string>();
    for (const [k, v] of vpDecls) if (out.base.get(k) !== v) delta.set(k, v);
    for (const [k] of out.base) if (!vpDecls.has(k)) delta.set(k, resetValue(k));
    if (delta.size > 0) out.bands.push({ media: b.media, decls: delta });
  }
  return out.base.size > 0 ? out : undefined;
}

/** Collect a pseudo-element's banded rule (its size/position can be responsive —
 * e.g. flex spacer pseudo-elements in horizontal scrollers). `hostContentWidthByVp`
 * is the host node's content-box width per viewport, used to re-fluidise a pseudo whose
 * baked px width is really `width:100%` (a `display:table` clearfix ::before/::after). */
function collectPseudoRule(styleByVp: Record<number, StyleMap>, baseVp: number, bands: Band[], assetMap: Map<string, string>, tokenResolver?: TokenResolver, hostContentWidthByVp?: Record<number, number>, hostPadBoxWByVp?: Record<number, number>, hostPadBoxHByVp?: Record<number, number>): PseudoRule {
  const out: PseudoRule = { base: new Map(), bands: [] };
  const baseStyle = styleByVp[baseVp] ?? Object.values(styleByVp)[0];
  if (!baseStyle) return out;
  const baseDecls = finalizeDecls(pseudoDecls(baseStyle, assetMap), tokenResolver);
  out.base = baseDecls;
  for (const b of bands) {
    if (!b.media) continue;
    const st = styleByVp[b.vp];
    // Pseudo not rendered at this width (responsive ::before/::after, e.g. a
    // desktop-only decorative shape): hide it so the clone does not paint the
    // canonical-viewport pseudo at a viewport where the source omits it.
    if (!st) { out.bands.push({ media: b.media, decls: new Map([["display", "none"]]) }); continue; }
    const vpDecls = finalizeDecls(pseudoDecls(st, assetMap), tokenResolver);
    const delta = new Map<string, string>();
    for (const [k, v] of vpDecls) if (baseDecls.get(k) !== v) delta.set(k, v);
    for (const [k] of baseDecls) if (!vpDecls.has(k)) delta.set(k, resetValue(k));
    if (delta.size > 0) out.bands.push({ media: b.media, decls: delta });
  }
  // A pseudo whose baked px width tracks the host's content box at EVERY rendered width (and varies)
  // was authored `width:100%` — most often a `display:table` clearfix ::before/::after. The engine
  // bakes the resolved px per band (`before:w-320` + `md:max-lg:before:w-192` …), which freezes a
  // FULL-VIEWPORT-WIDTH box inside the host and so pins the host's min-content to the capture px:
  // ridge's hero clearfix forces its whole section to 1280, clipping it on a 1024 window. Emit
  // `width:100%` instead — identical px at every captured width (gate-neutral), but it no longer
  // pins the host. Restricted to in-flow pseudos (an absolute pseudo's 100% has a different
  // containing block) and proven against every sampled width, the frTemplate discipline.
  //
  // CRUCIAL guard: the pseudo must have NO vertical box of its own — height AND padding-top/bottom
  // all ≈ 0. A clearfix is `display:table; height:0` (its width is purely cosmetic, safe to fill).
  // An ASPECT-RATIO SPACER is the opposite: `width:X; padding-top:X` makes a SQUARE whose width is
  // tied to its height.
  // There the width is load-bearing — forcing it to 100% un-squares the box and the card's height
  // goes inconsistent. The zero-box test cleanly separates the two.
  if (hostContentWidthByVp) {
    const vps = Object.keys(styleByVp).map(Number)
      .filter((vp) => hostContentWidthByVp[vp]! > 0 && /^(static|relative)$/.test(styleByVp[vp]!.position || "static"));
    const wAt = (vp: number): number => parseFloat(styleByVp[vp]!.width || "");
    const zeroBox = (vp: number): boolean => {
      const s = styleByVp[vp]!;
      return Math.abs(pf(s.height)) <= 2 && Math.abs(pf(s.paddingTop)) <= 2 && Math.abs(pf(s.paddingBottom)) <= 2;
    };
    const measured = vps.filter((vp) => Number.isFinite(wAt(vp)));
    const fills = measured.length >= 2
      && measured.every((vp) => zeroBox(vp))   // a true clearfix, not an aspect-ratio spacer
      && measured.every((vp) => Math.abs(wAt(vp) - hostContentWidthByVp[vp]!) <= Math.max(1.5, 0.01 * hostContentWidthByVp[vp]!))
      && Math.max(...measured.map(wAt)) - Math.min(...measured.map(wAt)) > 8;
    if (fills) {
      out.base.set("width", "100%");
      for (const band of out.bands) band.decls.delete("width");   // 100% holds at every band
    }
  }
  // An absolutely-positioned overlay pseudo pinned on BOTH opposing edges (inset-0 and the like — a
  // `.card::before` border/gradient/mask that fills the card) needs no width/height: for an absolute
  // box the offsets define the size from the host's PADDING box (its containing block). The engine
  // bakes the resolved px per band anyway (`before:w-[25.4rem]` + max-md/md:max-lg/2xl variants),
  // freezing a fixed-size overlay inside a fluid card and spawning a breakpoint pile. When the baked
  // size actually SPANS the host (reaches the opposite inset) at every rendered width AND varies,
  // drop it — left/right (top/bottom) stretch the box fluidly and reproduce every captured sample.
  // Proven per axis against the host padding box (the frTemplate discipline); an over-constrained
  // width that DOESN'T reach `right` (width < span) keeps its baked px. Only when the host is the
  // pseudo's containing block (positioned/transformed) is the padding box passed in.
  if (hostPadBoxWByVp || hostPadBoxHByVp) {
    const vps = Object.keys(styleByVp).map(Number).filter((vp) => styleByVp[vp]);
    const isAbs = (vp: number): boolean => /^(absolute|fixed)$/.test(styleByVp[vp]!.position || "static");
    const pin = (v: string | undefined): boolean => v != null && v !== "auto";
    // Per axis, the vps that baked a px size (auto vps carry no baked px — the source `.card::before`
    // has `inset:0` and no width, so getComputedStyle only resolves a px width where it's RENDERED;
    // a display:none-on-mobile card reports width:auto there, which is the true authored value and is
    // skipped). Drop the baked size iff every baked-px vp is absolute, pinned on both opposing edges,
    // and the px equals the inset-implied span of the host padding box — and ≥2 such vps vary.
    const axisDrop = (box: Record<number, number> | undefined, dim: "width" | "height", a: string, b: string, mA: string, mB: string): boolean => {
      if (!box) return false;
      const pxVps = vps.filter((vp) => pf(styleByVp[vp]![dim]) > 0 && styleByVp[vp]![dim] !== "auto");
      if (pxVps.length < 2) return false;
      const vals = pxVps.map((vp) => pf(styleByVp[vp]![dim]));
      if (Math.max(...vals) - Math.min(...vals) <= 8) return false;
      return pxVps.every((vp) => {
        const s = styleByVp[vp]!;
        if (!isAbs(vp) || !pin((s as Record<string, string>)[a]) || !pin((s as Record<string, string>)[b])) return false;
        const pad = box[vp]; if (!(pad! > 0)) return false;
        const implied = pad! - pf((s as Record<string, string>)[a]) - pf((s as Record<string, string>)[b]) - pf((s as Record<string, string>)[mA]) - pf((s as Record<string, string>)[mB]);
        return Math.abs(pf(s[dim]) - implied) <= Math.max(1.5, 0.01 * pad!);
      });
    };
    const dropW = axisDrop(hostPadBoxWByVp, "width", "left", "right", "marginLeft", "marginRight");
    const dropH = axisDrop(hostPadBoxHByVp, "height", "top", "bottom", "marginTop", "marginBottom");
    if (dropW) { out.base.delete("width"); for (const band of out.bands) band.decls.delete("width"); }
    if (dropH) { out.base.delete("height"); for (const band of out.bands) band.decls.delete("height"); }
  }
  return out;
}

/** Stage 5 (motion): the @keyframes a node's `animation-name` references. Names are
 *  collected from every node's computed animation-name across viewports (a comma list
 *  may name several); only matching captured @keyframes blocks are emitted (with url()
 *  rewritten), so an animation whose keyframes weren't captured (cross-origin sheet)
 *  stays inert — frozen — rather than emitting a dangling reference. `includeNode`
 *  scopes the referenced-name set for multi-route shared layout, as elsewhere. */
function keyframeNameOf(block: string): string | null {
  const m = /@(?:-webkit-)?keyframes\s+("[^"]+"|'[^']+'|[^\s{]+)/i.exec(block);
  return m ? m[1]!.replace(/^['"]|['"]$/g, "") : null;
}
function collectReferencedAnimations(ir: IR, includeNode?: (id: string) => boolean): Set<string> {
  const names = new Set<string>();
  const walk = (node: IRNode): void => {
    if (!includeNode || includeNode(node.id)) {
      for (const vp of ir.doc.viewports) {
        const an = node.computedByVp[vp]?.animationName;
        if (an && an !== "none") for (const n of an.split(",")) { const t = n.trim(); if (t && t !== "none") names.add(t); }
      }
    }
    for (const c of node.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return names;
}
export function keyframesCss(ir: IR, assetMap: Map<string, string>, includeNode?: (id: string) => boolean): string {
  const kfs = ir.doc.keyframes ?? [];
  if (!kfs.length) return "";
  const referenced = collectReferencedAnimations(ir, includeNode);
  if (!referenced.size) return "";
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const block of kfs) {
    const name = keyframeNameOf(block);
    if (!name || !referenced.has(name) || emitted.has(block)) continue;
    emitted.add(block);
    out.push(block.includes("url(") ? rewriteUrls(block, assetMap) : block);
  }
  return out.join("\n");
}

/** Compute the structured rule for every emitted node (base decls + per-band deltas +
 *  pseudo rules), in document pre-order. The single source of truth behind both the
 *  per-node CSS emitter (generateCss) and the semantic class-map emitter (classMap.ts).
 *  `includeNode` scopes which nodes are emitted (multi-route shared layout) while still
 *  recursing so inheritance diffing against parents stays correct. */
export function collectNodeRules(ir: IR, assetMap: Map<string, string>, includeNode?: (id: string) => boolean, colorVar?: (value: string) => string | null, tokenResolver?: TokenResolver, reflow = false, lottieMounts?: ReadonlySet<string>): Map<string, NodeRule> {
  const bands = computeBands(ir.doc.viewports, ir.doc.canonicalViewport);
  const baseVp = ir.doc.canonicalViewport;
  const rules = new Map<string, NodeRule>();
  // ids of items in a content-sized flex row whose width should flow (width:auto). Populated when
  // their container is visited (pre-order), consumed at each child's width plan. All-or-nothing
  // per line so the line's free space — and thus sibling positions — is unchanged.
  const autoWidthFlex = new Set<string>();

  const walk = (node: IRNode, parentNode: IRNode | undefined, parentFluid: boolean, layoutParent: IRNode | undefined, cbAncestor: IRNode | undefined, parentDefiniteHeight: boolean): void => {
    // Full-bleed fluidity propagates as a CONTIGUOUS chain from the root: a node is fluid
    // only if its containing block is also fluid — otherwise width:auto fills a fixed-width
    // ancestor instead of the viewport (a full-bleed row inside a fixed 1280 wrapper would
    // render 1280 at every width). Decided once (vp-independent) and applied to base + bands.
    // `layoutParent` is the nearest ancestor that actually generates a box: a display:contents
    // wrapper is transparent to layout, so it passes the fluid state + containing block straight
    // through to its children (otherwise the chain — and the page width — dead-ends at a contents
    // <div>, e.g. framer's <nav>/<main> wrappers). The full-bleed chain marks a viewport-spanning
    // box fluid via `auto` (a block/auto box that fills) or `fill` (a full-bleed flex/grid item a
    // centred column/grid would otherwise shrink → width:100%).
    const isContents = node.computedByVp[baseVp]?.display === "contents";
    // Size inference runs over the DENSE sample widths (not just the 4 band widths) — more
    // samples make "fills its container" / "fractional" / "clamped" provable instead of
    // under-determined, and let a shrunk item's natural size surface. Bands are still emitted
    // only at the standard breakpoints (ir.doc.viewports).
    const sampleVps = ir.doc.sampleViewports;
    // If this node is a content-sized flex row, let its items' widths flow (width:auto) — their
    // per-viewport px were just content reflow. Whole-line so sibling positions don't shift.
    if (!isContents) { const auto = contentSizedFlexRow(node, sampleVps); if (auto) for (const id of auto) autoWidthFlex.add(id); }
    let fluidMode: "auto" | "fill" | null = null;
    if (!isContents && parentFluid) {
      if (isFluidFullBleed(node, layoutParent, sampleVps)) fluidMode = "auto";
      else if (isFluidFillItem(node, layoutParent, sampleVps)) fluidMode = "fill";
    }
    const childFluid = isContents ? parentFluid : fluidMode !== null;
    const childLayoutParent = isContents ? layoutParent : node;
    // The containing block for absolutely-positioned descendants: the nearest ancestor that is
    // positioned (relative/absolute/fixed/sticky) or establishes a containing block via a transform
    // (transform/translate/rotate/scale/perspective/filter). display:contents is transparent.
    const bcs = node.computedByVp[baseVp];
    const establishesCb = !!bcs && (
      /^(relative|absolute|fixed|sticky)$/.test(bcs.position || "static") ||
      (!!bcs.transform && bcs.transform !== "none") || (!!bcs.translate && bcs.translate !== "none") ||
      (!!bcs.rotate && bcs.rotate !== "none") || (!!bcs.scale && bcs.scale !== "none") ||
      (!!bcs.perspective && bcs.perspective !== "none") || (!!bcs.filter && bcs.filter !== "none"));
    const childCb = isContents ? cbAncestor : (establishesCb ? node : cbAncestor);
    // height:100% fill (a card filling its stretched grid cell, a figure filling that card). Decided
    // top-down: a node fills its parent's content height where the parent has a definite height and
    // doesn't itself auto-stretch the node. The fill chains — a node we give 100% confers a definite
    // height to ITS children — so a wrapper>card>figure nest all fill, equalising every card (instead
    // of the long-quote figures' px height being dropped to auto and overflowing their neighbours).
    // h-full when EITHER the structural inference proves it (isHeightFill: fills a definite-height
    // parent, varies) OR the sizing probe measured that height:100% reproduces and auto does not
    // (heightProbeFills — direct ground truth, also catches constant fillers; inert pre-probe captures).
    const sourceFixedSize = !isContents && sourceFixedSizeIntent(node);
    // Authored, geometry-corroborated fixed height/width on this node's own source class (banded or
    // not). These break the fill↔content probe cycle that otherwise drops a banded authored height to
    // `h-full` (logo tiles) or a shrink-0 box's authored width/height to auto (testimonial avatars):
    // trust the baked per-band px the capture measured, exactly as the capture-side authored guard does.
    const sourceFixedHeight = !isContents && sourceFixedHeightIntent(node, sampleVps);
    const sourceFixedWidth = !isContents && sourceFixedWidthIntent(node, sampleVps);
    const mediaCover = !isContents && absoluteMediaCoversParent(node, parentNode, sampleVps);
    const absHeightFill = !isContents && absoluteHeightFill(node, parentNode, sampleVps);
    const buttonFixedHeight = !isContents && (fixedHeightButtonLike(node, sampleVps) || sourceFixedSize || sourceFixedHeight);
    const heightFill = !isContents && !buttonFixedHeight && (isHeightFill(node, parentNode, parentDefiniteHeight, sampleVps) || absHeightFill || mediaCover || heightProbeFills(node, sampleVps));
    // This node's own height-drop decision, computed here so it can also feed childDefiniteHeight (a
    // height we drop becomes `auto` → does not confer a definite containing block). Same OR'd signals
    // documented at the original site below.
    const flowH = !isContents && !buttonFixedHeight && (heightFlows(node, parentNode, sampleVps) || heightProbeDrops(node, sampleVps, reflow));
    const childDefiniteHeight = isContents ? parentDefiniteHeight : confersDefiniteHeight(node, parentNode, heightFill, flowH, parentDefiniteHeight, sampleVps);
    // Generalised fluidity (centred max-width container / fills-container / fractional width),
    // inferred from the per-viewport samples — independent of the full-bleed chain (auto/% always
    // reproduce the captured px at every sampled width, whatever the ancestor sizing). Measured
    // against the real DOM parent exactly as on main: a display:contents parent makes these bail,
    // leaving the full-bleed chain above to carry the fluidity through the wrapper.
    const inferred = planWidth(node, parentNode, sampleVps);
    // A grid item whose width is set by its (fluid) track span: drop the baked px so it follows the
    // track. A `flex gap w-1/3` equal-fill row item: re-express as flex:1 1 0 so it scales.
    const gridFill = isGridItemFill(node, parentNode, sampleVps);
    const flexFill = !gridFill && isFlexFillItem(node, parentNode, sampleVps);
    // A carousel slide (`shrink-0` flex/grid item) whose width was set only by the library's injected
    // inline px and whose children all FILL it → the probe reads it as fill/content and drops the
    // width, collapsing the slide + its fill children + the track to 0×0. Pin the captured px so the
    // fill chain has a definite basis. Wins over the probe/fill detectors below (it IS the width source).
    const circularSlide = !isContents && !gridFill && !flexFill && isCircularShrinkSlide(node, parentNode, sampleVps);
    // A full-VIEWPORT-width shrink-0 carousel slide → flex-basis:100% (definite main size) instead of
    // width:100%, so the flex row can't over-widen from the slide's max-content (the splide02 hero).
    const fullWidthSlide = !isContents && !gridFill && !flexFill && !circularSlide && isFullWidthShrinkSlide(node, parentNode, sampleVps);
    const fillsContainer = !gridFill && !flexFill && !circularSlide && !fullWidthSlide && isFillsContainerWidth(node, parentNode, sampleVps);
    const replacedFill = replacedFillsContainer(node, parentNode, sampleVps); // an img/video filling its cell → w-full
    const sourceFill = sourceWidthFillIntent(node);
    // A full-bleed banner image (width ≈ viewport, grows) baked to per-vp px → w-full so it keeps
    // filling beyond the widest captured band instead of leaving a gutter on a wide monitor.
    const bleedImg = !isContents && !replacedFill && fullBleedImageFill(node, parentNode, sampleVps);
    // An inline <svg> logo sized by height with width:auto (provably aspect-scaled, viewBox-verified)
    // → drop the baked per-vp width to `auto` so it tracks the height instead of pinning per breakpoint.
    const svgAuto = !isContents && !replacedFill && !bleedImg && svgAspectWidthAuto(node, sampleVps);
    const maxWidthFill = !gridFill && !flexFill && !fillsContainer && isMaxWidthFill(node, parentNode, sampleVps);
    // A block-level child filling its block parent (the commonest fluid case) → drop width (auto).
    const blockFill = !gridFill && !flexFill && !fillsContainer && !maxWidthFill && fillsBlockContainer(node, parentNode, sampleVps);
    // An absolute box pinned by both left+right insets → drop width (auto stretches between them).
    const insetSpanned = !isContents && insetSpannedAbsolute(node, parentNode, sampleVps);
    // If that inset-spanned box ALSO carries an authored aspect-ratio (a full-bleed hero slide:
    // `absolute inset-x-0 aspect-video min-h-[…]`), `width:auto` does NOT stay pinned to the insets:
    // with a definite height (min-height) and a definite aspect-ratio, the width BACK-COMPUTES from
    // height × aspect and over-widens at any width the capture didn't sample (the splide02 hero
    // measuring 768/641px wide inside a 572px window — the responsive full-bleed violations). Emit an
    // explicit `width:100%` instead: it fills the containing block (identical to the inset-0 span at
    // every sampled width, gate-neutral) and, being definite, WINS the width axis so the aspect-ratio
    // drives only the height. Scoped to inset-spanned boxes that actually have an aspect-ratio.
    const insetSpannedAspect = insetSpanned && sampleVps.some((vp) => {
      const ar = node.computedByVp[vp]?.aspectRatio;
      return !!ar && ar !== "auto" && node.visibleByVp[vp];
    });
    // Combine: the full-bleed chain wins (it proved the box spans the viewport), then grid/flex
    // fill, then "fills its container" / "fills under a max-width cap" (→ width:100%), then the
    // inferred generalisations.
    // A fill-to-cap container (width = min(parentContent, CAP)) MUST be decided before the
    // content-sized detectors below — they misread a capped fill as content and drop its width.
    const fillCap = !isContents ? fillsToCapWidth(node, parentNode, sampleVps) : null;
    // A width that leaves interior free space positions its children (auto margins / justify) — it's
    // load-bearing, so the content-sized branches below must NOT drop it (would kill the spacing).
    const buttonFixedWidth = !isContents && (fixedWidthButtonLike(node, sampleVps) || sourceFixedSize || sourceFixedWidth);
    const lockWidth = !isContents && !fillCap && (hasInteriorFreeSpaceX(node, sampleVps) || buttonFixedWidth);
    // Ground-truth sizing probe is the primary signal after authored capped fills:
    // `width:100%; max-width:X` can look "auto" in a clone probe because the retained cap still
    // constrains it, but dropping the fill collapses flex-column wrappers to their content width.
    // Therefore fillCap outranks the probe; the probe owns the remaining content/fill cases.
    const probe = !isContents && !buttonFixedWidth ? sizingVerdict(node, sampleVps) : null;
    // A width that's a stable fraction of its container per breakpoint regime (possibly a different
    // fraction per regime: 100% stacked on mobile, 50% side-by-side on desktop) → per-band `width:N%`
    // so it grows/shrinks fluidly instead of freezing each regime at baked px. Last fluid resort
    // before the inferred block-only generalisations, and only for genuinely load-bearing widths.
    const percentVp = (!lockWidth && !isContents) ? fluidPercentByVp(node, parentNode, sampleVps) : null;
    // A box that fills its container at some widths but is a fixed scroll-track at others (a desktop
    // card grid that becomes a mobile horizontal scroller) → per-vp width: 100% where it fills, baked
    // px where it overflows. Only when the clean per-band fraction law (percentVp) didn't already fit.
    const mixedFill = (!lockWidth && !isContents && !percentVp) ? mixedFillByVp(node, parentNode, sampleVps) : null;
    const widthPlan: WidthPlan =
      fillCap ? { kind: "fillcap", cap: fillCap }
      : sourceFixedWidth ? { kind: "fixed" }
      : sourceFixedSize ? inferred.plan
      : circularSlide ? { kind: "fixed" }
      : fullWidthSlide ? { kind: "basisFull" }
      : insetSpannedAspect ? { kind: "fill" }
      : probe === "auto" ? { kind: "auto" }
      : probe === "fill" ? { kind: "fill" }
      : (!lockWidth && autoWidthFlex.has(node.id)) ? { kind: "auto" }
      : fluidMode === "fill" || fillsContainer || maxWidthFill || replacedFill || sourceFill || bleedImg || mediaCover ? { kind: "fill" }
      : svgAuto ? { kind: "auto" }
      : (!lockWidth && !isContents && contentSizedColumnItem(node, parentNode, sampleVps)) ? { kind: "auto" }
      : (!lockWidth && !isContents && contentSizedFlexItemAuto(node, parentNode, sampleVps)) ? { kind: "auto" }
      : (!lockWidth && !isContents && isInlineContentBox(node, sampleVps)) ? { kind: "auto" }
      : (!lockWidth && !isContents && isContentSizedColumnTextLeaf(node, parentNode, sampleVps)) ? { kind: "auto" }
      : blockFill || insetSpanned ? { kind: "auto" }
      : fluidMode === "auto" || gridFill ? { kind: "auto" }
      : (!lockWidth && flexFill) ? { kind: "flexfill" }
      : percentVp ? { kind: "percentVp", pctByVp: percentVp }
      : mixedFill ? { kind: "percentVp", pctByVp: mixedFill }
      : inferred.plan;
    const centerAlways = inferred.centerAlways;
    const centeredAtAnySample = !!layoutParent && sampleVps.some((vp) => centeredAtVp(node, layoutParent, vp));
    // A single-line text leaf sitting flush against its container's available width at every painted
    // width → `white-space:nowrap` so a sub-pixel column shortfall in the clone can't wrap it. Decided
    // once per node (uniform across bands); measured against layoutParent to see through contents wrappers.
    const nowrapText = !isContents && nowrapWrapVulnerable(node, layoutParent, sampleVps);
    // If this node has a NON-identity transform at any painted band, the identity `none` must be
    // emitted at the bands that have it so the transform can't cascade across bands (freezing a
    // width the source left untransformed). Identity matrices are canonicalized to "none" upstream.
    let hasNonIdentityTransform = false, hasIdentityTransform = false;
    for (const vp of sampleVps) {
      const t = node.computedByVp[vp]?.transform;
      if (t === undefined) continue;
      if (t === "none") hasIdentityTransform = true;
      else hasNonIdentityTransform = true;
    }
    const keepIdentityTransform = hasNonIdentityTransform && hasIdentityTransform;
    const stableCenter =
      centerAlways ||
      sourceMarginAutoIntent(node) ||
      ((!!fillCap || hasPxMaxWidthCap(node, sampleVps)) && centeredAtAnySample);
    // Fluid grid-template-columns (fr), per-viewport (the column count may change across breakpoints).
    const gridColsByVp = fluidGridColumns(node, sampleVps);
    // Large one-row media grids need a definite height/aspect law before the single `1fr` row is
    // safe. Multi-row grids are handled by the older equal-track detector.
    const singleRowsByVp = !isContents ? singleFluidGridRow(node, sampleVps) : null;
    // A lottie mount pins its captured height (replaced-like); it wins over the flow/media laws so the
    // runtime player's aspect-sized svg fills a definite box instead of inflating past its neighbours.
    const lottieHeight = !isContents && lottieMounts?.has(node.id) ? lottieMountHeight(node, sampleVps) : null;
    const mediaGeometry = lottieHeight ? { heightByVp: lottieHeight } : singleRowsByVp ? mediaHeightGeometry(node, sampleVps) : {};
    const leftClampByVp = !isContents ? centeredInsetClamp(node, cbAncestor, sampleVps, "x") : null;
    const topClampByVp = !isContents ? centeredInsetClamp(node, cbAncestor, sampleVps, "y") : null;
    const geometry: GeometryPlan = (mediaGeometry.heightByVp || mediaGeometry.aspectByVp || leftClampByVp || topClampByVp)
      ? { ...mediaGeometry, ...(leftClampByVp ? { leftByVp: leftClampByVp } : {}), ...(topClampByVp ? { topByVp: topClampByVp } : {}) }
      : GEOMETRY_NONE;
    // Fluid grid-template-rows (1fr) for equal, responsive, content-height-filling row regimes.
    const gridRowsByVp = fluidGridRows(node, sampleVps) ?? ((geometry.heightByVp || geometry.aspectByVp) ? singleRowsByVp : null);
    const dropGridRows = reflow && gridRowsByVp == null &&
      sampleVps.some((vp) => /^(grid|inline-grid)$/.test(node.computedByVp[vp]?.display || ""));
    const dropViewportMaxWidth = !isContents && maxWidthTracksViewport(node, sampleVps);
    const emit = !includeNode || includeNode(node.id);
    if (!emit) {
      for (const c of node.children) if (!isTextChild(c)) walk(c, node, childFluid, childLayoutParent, childCb, childDefiniteHeight);
      return;
    }
    // Centering is decided PER VIEWPORT (an element can be an auto-centred block at one width but a
    // left-aligned flex item at another — emitting margin:auto globally wrongly centred duolingo's
    // flex-item links) — except a centred max-width container, centred at EVERY width (centerAlways)
    // so it never freezes at one band's baked margins. Measured against layoutParent so it sees
    // through display:contents wrappers.
    const centeredBase = stableCenter || (layoutParent ? centeredAtVp(node, layoutParent, baseVp) : false);
    // Height dropping. Two complementary signals, OR'd:
    //  • heightFlows — a static structural check (content-extent / flex-stretch) that only drops a
    //    VARYING height (removes a band), with strict 2px guards.
    //  • heightProbeDrops — the browser-as-oracle reading: height:auto reproduced this box within
    //    0.5px at EVERY painted viewport. Catches content-derived heights heightFlows' guards miss
    //    (rounding >2px, constant heights), incl. the ones that became per-viewport `h-[…]` bands.
    // Naive per-element dropping once broke the layout gate because vertical slop accumulates down the
    // stacked page; the 0.5px unanimous-across-viewports probe + refineSizing convergence (re-measures
    // after the drop) is what makes it safe. The layout/responsive/perceptual gates backstop drift.
    // (flowH is computed earlier in the walk so it can also feed childDefiniteHeight.)
    // A centred overlay's baked `left:Npx` → `left:50%` so it tracks the centre (the translate is
    // already replayed). Constant-fraction-of-containing-block, proven against every sample.
    const leftPct = isContents ? null : centerLeftPct(node, cbAncestor, sampleVps);
    let dropInsets = isContents ? EMPTY_SET : insetDropSides(node, sampleVps);
    // The inset-anchor probe judges each side's redundancy ASSUMING the baked width stays. But
    // `insetSpanned` drops the width (→ auto, stretching between left&right). If both fire, the box
    // loses its width AND the insets that would re-derive it → it collapses to content width (0 for an
    // empty full-bleed layer → its gradient paints nothing; shrink-wrapped for a bar like the navbar →
    // bunched to one edge). When the width comes FROM the inset span, those insets are load-bearing:
    // keep left+right so `width:auto inset-x-0` reproduces the full-bleed box.
    if (insetSpanned && (dropInsets.has("left") || dropInsets.has("right"))) {
      dropInsets = new Set(dropInsets);
      dropInsets.delete("left");
      dropInsets.delete("right");
    }
    if (absHeightFill && (dropInsets.has("top") || dropInsets.has("bottom"))) {
      dropInsets = new Set(dropInsets);
      dropInsets.delete("top");
      dropInsets.delete("bottom");
    }
    if (mediaCover && (dropInsets.has("top") || dropInsets.has("right") || dropInsets.has("bottom") || dropInsets.has("left"))) {
      dropInsets = new Set(dropInsets);
      dropInsets.delete("top");
      dropInsets.delete("right");
      dropInsets.delete("bottom");
      dropInsets.delete("left");
    }
    // opacity/transform driven by an infinite animation at the base OR any emitted band (a marquee
    // gated to a breakpoint owns the transform only where it runs, but freezes a mid-scroll offset
    // at the OTHER bands — suppress those frozen deltas at every width).
    const animOwned = animOwnedProps(node, [baseVp, ...bands.map((b) => b.vp)]);
    const baseDecls = finalizeDecls(declsForViewport(node, parentNode?.computedByVp[baseVp], baseVp, assetMap, centeredBase, colorVar, ir.doc.perViewport[baseVp]?.scrollHeight, widthPlan, gridColsByVp?.get(baseVp), gridRowsByVp?.get(baseVp), flowH, dropInsets, leftPct, heightFill, geometry, dropGridRows, dropViewportMaxWidth, nowrapText, keepIdentityTransform, sourceFixedHeight), tokenResolver);
    const nr: NodeRule = { base: baseDecls, bands: [] };

    // Per-band overrides (delta vs base), using the parent's value AT THAT viewport.
    for (const b of bands) {
      if (!b.media) continue;
      // Node was not in the observed DOM at this width (responsive conditional
      // rendering): hide it so the clone matches the source at this viewport.
      if (!node.computedByVp[b.vp]) { nr.bands.push({ media: b.media, decls: new Map([["display", "none"]]) }); continue; }
      // The node isn't PAINTED at this width. HOW it is hidden decides what to emit, because only
      // `display:none` takes the box out of layout — a `visibility:hidden` box still occupies space
      // and can extend the scrollable area. The base rule bakes CANONICAL geometry unconditionally,
      // so skipping every override here can park e.g. a desktop `left:548px` slider arrow inside a
      // 375px viewport: invisible, but +210px of sideways scroll.
      const vpCs = node.computedByVp[b.vp]!;
      const ownNone = (vpCs.display || "") === "none";
      // The node ITSELF is visibility:hidden here (its parent isn't → not inherited from an
      // ancestor whose own rule already carries the hide).
      const ownHidden = !ownNone && /^(hidden|collapse)$/.test(vpCs.visibility || "") &&
        !/^(hidden|collapse)$/.test(parentNode?.computedByVp[b.vp]?.visibility || "");
      if (ownHidden) {
        const bb = node.bboxByVp[b.vp];
        if (!bb || bb.width <= 0 || bb.height <= 0) {
          // The hidden box occupied NOTHING in the capture (0×0 — e.g. an uninitialised swiper
          // arrow collapsed by its container). `display:none` reproduces "invisible, takes no
          // space" exactly and guarantees it cannot extend scroll bounds at this width.
          nr.bands.push({ media: b.media, decls: new Map([["display", "none"]]) });
          continue;
        }
        // Non-zero bbox: the invisible box occupies real layout space. Fall through to the normal
        // per-viewport delta so it sits where the capture measured it at THIS width — not at the
        // canonical geometry the base rule baked. The hide itself rides along in the delta
        // (declsForViewport emits `visibility:hidden`; parent-equality keeps it own-only).
      } else if (ownNone || !node.visibleByVp[b.vp]) {
        const shownAtBase = node.visibleByVp[baseVp] && (node.computedByVp[baseVp]?.display || "") !== "none";
        // Hidden by an ANCESTOR's visibility here AND at base (the ancestor's own rule carries
        // the hide at every width) — but a visibility:hidden box still PARTICIPATES in layout,
        // and the base rule bakes CANONICAL geometry. Same policy as the own-hidden path above:
        // a 0x0 box gets display:none; an occupying box falls through to the per-viewport delta
        // so it sits where the capture measured it at THIS width — not parked at e.g. a desktop
        // left:548px inside a 375px viewport (the cropin.com/cotton slider arrow, +210px of
        // sideways scroll at 375 with the hide inherited from an elementor-widget ancestor).
        const ancestorHiddenHere = !ownNone && /^(hidden|collapse)$/.test(vpCs.visibility || "");
        if (ancestorHiddenHere && !shownAtBase) {
          const bb = node.bboxByVp[b.vp];
          if (!bb || bb.width <= 0 || bb.height <= 0) {
            nr.bands.push({ media: b.media, decls: new Map([["display", "none"]]) });
            continue;
          }
          // Occupying: fall through to the normal per-viewport delta below.
        } else {
          if (ownNone) {
            // Own display:none removes the box from layout entirely. Emit the hide even when the node
            // is ALSO hidden at base — a visibility:hidden base still bakes an OCCUPYING box (see
            // above), so without this band the canonical geometry would render at this width. Skip
            // only when the base itself is display:none (the band would be redundant).
            if ((node.computedByVp[baseVp]?.display || "") !== "none") {
              nr.bands.push({ media: b.media, decls: new Map([["display", "none"]]) });
            }
            continue;
          } else if (shownAtBase) {
            // The node is not painted here yet was not hidden by its own display:none / an
            // ancestor's visibility (handled above). It can be (a) off-viewport / clipped — the
            // walker marks a box invisible when `bbox.x >= vpW` — while still IN FLOW and
            // OCCUPYING real layout space, or (b) genuinely suppressed (opacity:0 / visibility:hidden,
            // typically a scroll-reveal or ancestor state that is breakpoint noise).
            //
            // Case (a) is load-bearing: an off-screen-right carousel slide is a display:block flex
            // item that still sets its flex track's cross-size. The base rule bakes CANONICAL
            // (desktop) geometry — a frozen desktop slide width/aspect inflates the mobile track
            // (an off-screen `w-[285px]` slide dragging a 375px carousel to 532px). Same policy as
            // the ownHidden / ancestor-hidden occupying-box paths above: fall through to the normal
            // per-viewport delta so it sits at THIS width's measured geometry, not the baked canonical.
            const bb = node.bboxByVp[b.vp];
            const suppressed = pf(vpCs.opacity) === 0 || /^(hidden|collapse)$/.test(vpCs.visibility || "");
            const inFlowHere = (vpCs.position || "static") === "static" || (vpCs.position || "static") === "relative";
            if (!suppressed && inFlowHere && bb && (bb.width > 0 || bb.height > 0)) {
              // Occupying, in-flow, merely off-viewport/clipped — fall through to the per-viewport delta.
            } else {
              // Suppressed (opacity:0 / visibility:hidden) but visible at base: geometry overrides are
              // breakpoint noise — the ancestor's own hide (or the reveal replay, for scroll-reveal
              // opacity) covers it. Emit only the hide the node itself carries.
              const hide = new Map<string, string>();
              if (pf(vpCs.opacity) === 0 && !animOwned.has("opacity")) hide.set("opacity", "0");
              if (/^(hidden|collapse)$/.test(vpCs.visibility || "")) hide.set("visibility", "hidden");
              if (hide.size) nr.bands.push({ media: b.media, decls: hide });
              continue;
            }
          } else {
            // Not painted here, not display:none, not ancestor-hidden, and NOT visible at base —
            // an item that is off-viewport/clipped at EVERY captured width, base included (the
            // walker marks a box invisible when `bbox.x >= vpW`). A carousel slide 6–12 that lives
            // off-screen right at 1280 (the canonical base) as well as at 375/768 lands here. It is
            // the identical load-bearing case as the shownAtBase occupying arm above: a display:block
            // flex item that still sets its flex track's cross-size, so freezing the base rule's
            // canonical (desktop) geometry inflates the mobile track. Run the same occupying-box test —
            // in-flow, unsuppressed, non-zero bbox at THIS width → fall through to the per-viewport
            // delta so it carries this width's measured geometry. A genuinely suppressed
            // (opacity:0 / visibility:hidden) or zero-box node keeps the current skip.
            const bb = node.bboxByVp[b.vp];
            const suppressed = pf(vpCs.opacity) === 0 || /^(hidden|collapse)$/.test(vpCs.visibility || "");
            const inFlowHere = (vpCs.position || "static") === "static" || (vpCs.position || "static") === "relative";
            if (!suppressed && inFlowHere && bb && (bb.width > 0 || bb.height > 0)) {
              // Occupying, in-flow, off-viewport at every width — fall through to the per-viewport delta.
            } else {
              continue;
            }
          }
        }
      }
      const centeredVp = stableCenter || (layoutParent ? centeredAtVp(node, layoutParent, b.vp) : false);
      const vpDecls = finalizeDecls(declsForViewport(node, parentNode?.computedByVp[b.vp], b.vp, assetMap, centeredVp, colorVar, ir.doc.perViewport[b.vp]?.scrollHeight, widthPlan, gridColsByVp?.get(b.vp), gridRowsByVp?.get(b.vp), flowH, dropInsets, leftPct, heightFill, geometry, dropGridRows, dropViewportMaxWidth, nowrapText, keepIdentityTransform, sourceFixedHeight), tokenResolver);
      const delta = new Map<string, string>();
      for (const [k, v] of vpDecls) if (baseDecls.get(k) !== v) delta.set(k, v);
      for (const [k] of baseDecls) if (!vpDecls.has(k)) delta.set(k, resetValue(k));
      // Drop bands for properties an infinite animation owns: the per-viewport delta is frozen
      // phase noise, so let the base value hold at every width (the animation drives it live).
      for (const p of animOwned) delta.delete(p);
      if (delta.size > 0) nr.bands.push({ media: b.media, decls: delta });
    }

    if (node.beforeByVp || node.afterByVp) {
      // Host content-box width per viewport — lets a clearfix/spacer pseudo whose baked px width is
      // really `width:100%` re-fluidise (and stop pinning the host's min-content to the capture px).
      const hostCW: Record<number, number> = {};
      // Padding box = border box − borders: the containing block of an ABSOLUTE pseudo (inset-0
      // border/overlay). Only meaningful when this host establishes that containing block (it is
      // positioned/transformed); otherwise the pseudo's CB is an ancestor and we pass nothing.
      const hostPadW: Record<number, number> = {};
      const hostPadH: Record<number, number> = {};
      for (const vp of ir.doc.viewports) {
        const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
        if (!cs || !nb) continue;
        const w = nb.width - pf(cs.paddingLeft) - pf(cs.paddingRight) - pf(cs.borderLeftWidth) - pf(cs.borderRightWidth);
        if (w > 0) hostCW[vp] = w;
        const pw = nb.width - pf(cs.borderLeftWidth) - pf(cs.borderRightWidth);
        const ph = nb.height - pf(cs.borderTopWidth) - pf(cs.borderBottomWidth);
        if (pw > 0) hostPadW[vp] = pw;
        if (ph > 0) hostPadH[vp] = ph;
      }
      const padW = establishesCb ? hostPadW : undefined;
      const padH = establishesCb ? hostPadH : undefined;
      if (node.beforeByVp && !isRestingInteractiveFillPseudo(node, node.beforeByVp, ir.doc.viewports)) {
        nr.before = collectPseudoRule(node.beforeByVp, baseVp, bands, assetMap, tokenResolver, hostCW, padW, padH);
      }
      if (node.afterByVp && !isRestingInteractiveFillPseudo(node, node.afterByVp, ir.doc.viewports)) {
        nr.after = collectPseudoRule(node.afterByVp, baseVp, bands, assetMap, tokenResolver, hostCW, padW, padH);
      }
    }
    if (node.placeholderByVp) {
      nr.placeholder = collectPlaceholderRule(node.placeholderByVp, node.computedByVp, baseVp, bands, tokenResolver);
    }
    rules.set(node.id, nr);

    for (const c of node.children) if (!isTextChild(c)) walk(c, node, childFluid, childLayoutParent, childCb, childDefiniteHeight);
  };
  // The root's containing block is the viewport-filling <html>, so it starts the fluid chain.
  walk(ir.root, undefined, true, undefined, undefined, false);
  return rules;
}

/** Assemble a CSS document from per-selector rules: base block then media-banded
 *  blocks, with @keyframes first. Shared by the per-node and class-map emitters so
 *  both produce byte-identical structure. `selBase`/`selBand` map a key (cid or class)
 *  to its rule; `order` is the emission order. */
export function assembleCss(
  order: string[],
  ruleFor: (key: string) => NodeRule,
  selOf: (key: string) => string,
  bands: Band[],
  keyframes: string,
): string {
  const baseRules: string[] = [];
  const bandRules = new Map<string, string[]>();
  for (const b of bands) if (b.media) bandRules.set(b.media, []);
  for (const key of order) {
    const nr = ruleFor(key);
    const sel = selOf(key);
    if (nr.base.size > 0) baseRules.push(formatRule(sel, nr.base));
    if (nr.before) baseRules.push(formatRule(`${sel}::before`, nr.before.base));
    if (nr.after) baseRules.push(formatRule(`${sel}::after`, nr.after.base));
    if (nr.placeholder) baseRules.push(formatRule(`${sel}::placeholder`, nr.placeholder.base));
    for (const b of nr.bands) bandRules.get(b.media)?.push(formatRule(sel, b.decls));
    if (nr.before) for (const b of nr.before.bands) bandRules.get(b.media)?.push(formatRule(`${sel}::before`, b.decls));
    if (nr.after) for (const b of nr.after.bands) bandRules.get(b.media)?.push(formatRule(`${sel}::after`, b.decls));
    if (nr.placeholder) for (const b of nr.placeholder.bands) bandRules.get(b.media)?.push(formatRule(`${sel}::placeholder`, b.decls));
  }
  const parts: string[] = [];
  if (keyframes) parts.push(keyframes);
  parts.push(baseRules.join("\n"));
  for (const b of bands) {
    if (!b.media) continue;
    const rules = bandRules.get(b.media)!;
    if (rules.length === 0) continue;
    parts.push(`${b.media} {\n${rules.join("\n")}\n}`);
  }
  return parts.join("\n\n") + "\n";
}

export function generateCss(ir: IR, assetMap: Map<string, string>, includeNode?: (id: string) => boolean, colorVar?: (value: string) => string | null, tokenResolver?: TokenResolver): string {
  const rules = collectNodeRules(ir, assetMap, includeNode, colorVar, tokenResolver);
  const bands = computeBands(ir.doc.viewports, ir.doc.canonicalViewport);
  // Stage 5: emit referenced @keyframes first so the per-node `animation-*` decls resolve.
  const kf = keyframesCss(ir, assetMap, includeNode);
  return assembleCss([...rules.keys()], (cid) => rules.get(cid)!, (cid) => `.c${cid}`, bands, kf);
}

// Reset value for a property removed at a viewport band (to override the base).
const RESET_VALUES: Record<string, string> = {
  display: "block", width: "auto", height: "auto", "min-height": "0",
  position: "static", top: "auto", right: "auto", bottom: "auto", left: "auto",
};
// Inherited properties (kebab-case) — when removed at a band, restore inheritance
// from the parent rather than resetting to the CSS initial value.
const INHERITED_KEBAB = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "word-spacing", "text-align", "text-transform", "white-space",
  "word-break", "overflow-wrap", "text-indent", "font-variant-caps", "font-feature-settings",
  "list-style-type", "list-style-position", "writing-mode", "direction", "cursor",
  "text-shadow", "visibility", "text-decoration-color", "-webkit-text-stroke", "-webkit-text-fill-color",
]);
function resetValue(prop: string): string {
  if (INHERITED_KEBAB.has(prop)) return "inherit";
  if (RESET_VALUES[prop]) return RESET_VALUES[prop]!;
  if (prop.startsWith("margin") || prop.startsWith("padding")) return "0";
  if (prop.startsWith("border") && prop.endsWith("width")) return "0";
  if (prop === "transform") return "none";
  if (prop === "background-image") return "none";
  if (prop.startsWith("max-")) return "none";
  if (prop.startsWith("min-")) return "0";
  return "initial";
}

function formatRule(sel: string, decls: Map<string, string>): string {
  const body = [...decls.entries()].map(([k, v]) => `${k}:${v}`).join(";");
  return `${sel}{${body}}`;
}
function formatRuleStr(sel: string, decls: string[]): string {
  return `${sel}{${decls.join(";")}}`;
}
