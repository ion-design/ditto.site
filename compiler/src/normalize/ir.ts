import { join } from "node:path";
import { readJSON, writeJSONCompact, writeJSON, fileExists } from "../util/fsx.js";
import type { PageSnapshot, RawNode, RawChild, RawStyle, RawBBox, RawSizing } from "../capture/walker.js";
import type { InteractionCapture } from "../capture/interactions.js";

/**
 * Normalized Render IR. Merges the per-viewport capture snapshots into a single
 * tree whose structure comes from the canonical (1280) capture; each node carries
 * per-viewport computed styles, bounding boxes, and visibility. This is the single
 * source of truth for section/token inference, generation, and validation.
 */

export type BBox = RawBBox;
export type StyleMap = RawStyle;

export type IRNode = {
  id: string; // stable pre-order index, e.g. "n0", "n1"
  tag: string;
  attrs: Record<string, string>;
  // Source authored `class` attribute (canonical capture), kept for diagnostics only — it is
  // NEVER emitted into the clone (not in the attr whitelist). For Tailwind-built sources this is
  // the author's fluid intent (`grid-cols-3`, `h-full`, `flex-1`, `line-clamp-5`), the exact
  // utility our generator SHOULD infer; `scripts/tw-diff.ts` diffs it against our emitted className
  // per node to rank where we baked per-vp px against a source fluid rule. Absent when the source
  // element had no class.
  srcClass?: string;
  rawHTML?: string; // inline svg
  visibleByVp: Record<number, boolean>;
  bboxByVp: Record<number, BBox>;
  computedByVp: Record<number, StyleMap>;
  // Sizing-intent probe per viewport: does width:auto / width:100% /
  // height:auto re-derive this box, and which insets are filled-in used values? Ground truth for
  // whether the generator may omit the baked dimension / inset.
  sizingByVp?: Record<number, RawSizing>;
  beforeByVp?: Record<number, StyleMap>;
  afterByVp?: Record<number, StyleMap>;
  // ::placeholder computed style (input/textarea with placeholder text) — emitted as a
  // `::placeholder` rule so form controls keep their authored placeholder color.
  placeholderByVp?: Record<number, StyleMap>;
  children: IRChild[];
};

export type IRTextNode = { text: string };
export type IRChild = IRNode | IRTextNode;

export type SeoHead = {
  description?: string; canonical?: string; ogTitle?: string; ogDescription?: string;
  ogImage?: string; ogType?: string; ogSiteName?: string; twitterCard?: string; themeColor?: string;
  keywords?: string; robots?: string; referrer?: string; colorScheme?: string;
  meta?: Array<{ name?: string; property?: string; httpEquiv?: string; content: string }>;
  links?: Array<{
    rel: string; href: string; as?: string; type?: string; sizes?: string; media?: string;
    color?: string; hrefLang?: string; title?: string; crossOrigin?: string; referrerPolicy?: string;
  }>;
  jsonLd?: Array<{ id?: string; text: string }>;
};

export type IRDoc = {
  sourceUrl: string;
  title: string;
  head?: SeoHead;
  lang: string;
  charset: string;
  metaViewport: string;
  viewports: number[];            // band/gate widths (the standard responsive breakpoints)
  sampleViewports: number[];      // ALL captured widths — the dense set for size inference
  canonicalViewport: number;
  perViewport: Record<number, { scrollHeight: number; scrollWidth: number; htmlBg: string; bodyBg: string; bodyColor: string; bodyFont: string }>;
  nodeCount: number;
  // Stage 5 (motion): raw @keyframes blocks from the canonical capture's accessible
  // stylesheets (deduped + sorted for determinism). Carried so the generator can
  // re-emit the keyframes that the per-node `animation-name` declarations reference —
  // without these the animation properties are inert (the half-plumbed pre-Stage-5 gap).
  keyframes: string[];
};

export type IR = {
  doc: IRDoc;
  root: IRNode;
};

export function isTextChild(c: IRChild): c is IRTextNode {
  return (c as IRTextNode).text !== undefined;
}

/**
 * In-flow content extent at a viewport: the largest border-box bottom (`bbox.y + bbox.height`)
 * over every VISIBLE, IN-FLOW descendant. This is the true height the real page laid out to,
 * independent of a scroll-lock that clips the root to one viewport (a popup vendor that sets
 * `body{overflow:hidden;height:100vh}` collapses `document.scrollHeight` to the viewport, but
 * the in-flow sections still carry their real coordinates). Out-of-flow (absolute/fixed) and
 * floated boxes are excluded — a fixed overlay/footer badge or a floated aside is not part of
 * the document flow that determines page height. Pure + deterministic (reads only the IR).
 */
export function irContentExtent(root: IRNode, vp: number): number {
  let maxBottom = 0;
  const visit = (n: IRNode): void => {
    for (const c of n.children) {
      if (isTextChild(c)) continue;
      const cs = c.computedByVp[vp];
      const bb = c.bboxByVp[vp];
      if (!cs || !bb || !c.visibleByVp[vp]) { visit(c); continue; }
      const pos = cs.position || "static";
      const inFlow = pos !== "absolute" && pos !== "fixed" && (cs.float || "none") === "none";
      if (inFlow) maxBottom = Math.max(maxBottom, bb.y + bb.height);
      visit(c);
    }
  };
  visit(root);
  return maxBottom;
}

/**
 * Recover lazy-loaded CSS backgrounds dropped by uneven per-viewport capture.
 * If an element has exactly one URL background at some sampled widths and
 * `none`/missing at the rest, treat the gaps as lazy-load misses rather than a
 * responsive swap. Multi-URL cases are left untouched.
 */
export function backfillLazyBackgrounds(ir: IR): void {
  const hasUrl = (bg: string | undefined): boolean =>
    !!bg && /\burl\(/.test(bg) && !/^\s*(?:linear|radial|conic)-gradient/.test(bg);
  const visit = (n: IRNode): void => {
    const urls = new Set<string>();
    let hasGap = false;
    for (const k of Object.keys(n.computedByVp)) {
      const bg = n.computedByVp[Number(k)]?.backgroundImage;
      if (hasUrl(bg)) urls.add(bg!);
      else if (bg === undefined || bg === "none" || bg === "") hasGap = true;
    }
    if (hasGap && urls.size === 1) {
      const bg = [...urls][0]!;
      for (const k of Object.keys(n.computedByVp)) {
        const cs = n.computedByVp[Number(k)];
        if (cs && (cs.backgroundImage === undefined || cs.backgroundImage === "none" || cs.backgroundImage === "")) {
          cs.backgroundImage = bg;
        }
      }
    }
    for (const c of n.children) if (!isTextChild(c)) visit(c);
  };
  visit(ir.root);
}

const ATTR_WHITELIST = new Set([
  "id", "href", "src", "srcset", "sizes", "alt", "title", "role", "type", "name",
  "value", "placeholder", "target", "rel", "for", "datetime", "colspan", "rowspan",
  "span", "start", "reversed", "controls", "autoplay", "loop", "muted", "playsinline",
  "poster", "preload", "width", "height", "open", "lang", "dir", "download",
  "hreflang", "media", "content", "property", "itemprop", "cite", "label", "selected",
  "checked", "disabled", "readonly", "multiple", "step", "min", "max", "pattern",
  "viewBox", "xmlns", "fill", "stroke", "d", "points", "cx", "cy", "r", "x", "y",
]);

// An empty value is meaningful for these (decorative `alt=""`, a cleared input `value=""`, and the
// boolean attrs whose mere presence is the state); for everything else `id=""`/`target=""`/`title=""`
// is just captured noise a human would never type — drop it.
const KEEP_IF_EMPTY = new Set([
  "alt", "value", "disabled", "checked", "selected", "readonly", "multiple", "open",
  "controls", "autoplay", "loop", "muted", "playsinline", "reversed", "download",
]);
function filterAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    // data-cid-cap is the Stage-4 capture-id (present only when interactions are
    // enabled); carried through so generation can map interaction deltas → cid,
    // then stripped from the emitted markup.
    if (!(ATTR_WHITELIST.has(k) || k.startsWith("aria-") || k === "data-cid-cap")) continue;
    if (v === "" && !KEEP_IF_EMPTY.has(k) && !k.startsWith("aria-")) continue;
    out[k] = v;
  }
  return out;
}

const LAZY_SRC_ATTRS = ["data-lazy-src", "data-src", "data-original", "data-ll-src"];
const LAZY_SRCSET_ATTRS = ["data-lazy-srcset", "data-srcset"];
function resolveLazyAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  if (!attrs) return {};
  const realSrc = LAZY_SRC_ATTRS.map((k) => attrs[k]).find((v) => v && !v.startsWith("data:"));
  const realSrcset = LAZY_SRCSET_ATTRS.map((k) => attrs[k]).find((v) => v && !v.startsWith("data:"));
  if (!realSrc && !realSrcset) return attrs;
  const placeholder = !attrs.src || attrs.src.startsWith("data:");
  if (!placeholder && !realSrcset) return attrs;
  const out = { ...attrs };
  if (realSrc && placeholder) out.src = realSrc;
  if (realSrcset && (placeholder || !attrs.srcset || attrs.srcset.startsWith("data:"))) out.srcset = realSrcset;
  return out;
}

// `<iframe>` is intentionally NOT noise: capture grafts an embedded document's subtree
// as the iframe's children (capture/graft.ts) so form embeds (Klaviyo et al) render as
// real content — generation then emits the iframe as a positioned <div>. When the graft
// wasn't possible the iframe is kept as a sized placeholder box (document-loading attrs
// dropped at generation — see propsList — so the clone stays self-contained). Truly
// invisible iframes (tracking/chat, 0-size or display:none) are removed by the prune.
const NOISE_TAGS = new Set(["next-route-announcer"]);

// Third-party overlay widgets (chat launchers, cookie/consent bars, captcha badges) are
// JS-injected chrome, not site content. They live in the INT_MAX z-index band and/or carry a
// vendor class/id prefix, and the capture freezes their hidden state PER VIEWPORT — which then
// bands into a stray visible artifact in the clone (e.g. Intercom's messenger frame is
// `opacity:0; transform:matrix(0,…)` at most widths but `opacity:initial; transform:none` at the
// width where capture happened to read it open → an empty 400×700 white rectangle at 2xl). Drop
// the whole subtree so it never reaches generation.
const THIRD_PARTY_OVERLAY = /(?:^|[\s_-])(?:intercom|drift-|hubspot-messages|zendesk|zd-|onetrust|ot-sdk-|usercentrics|grecaptcha|crisp-client|tawk-|livechat|helpscout|beacon-container|cookiebot|cky-)/;

/**
 * Email-capture / promo POPUP overlay containers (Attentive, Wunderkind/Bounce Exchange,
 * Justuno, Privy, Omnisend, Sailthru, Wisepops, etc.). These vendors inject a full-viewport
 * fixed overlay + backdrop that scroll-locks the page — third-party chrome, not site content.
 *
 * CAUTION: these vendors ALSO ship inline, embedded signup forms that ARE real page content
 * and are deliberately grafted (see iframeGraft tests). So this matches ONLY the OVERLAY
 * CONTAINER markers each vendor uses for its popup (`attentive_overlay`, `bx-wrapper` /
 * `wk-`, `justuno`-`container`, `privy-`popup, …) — never a bare vendor name that an inline
 * form embed would also carry. Overlay-container tokens only.
 */
export const POPUP_OVERLAY_CONTAINER =
  /(?:^|[\s_-])(?:attentive_overlay|attentive_creative|attn-|bx-wrapper|bx-window|bounce-?exchange|wknd-|wunderkind|justuno_container|jw-overlay|privy-popup|privy-container|klaviyo-form-.*overlay|sailthru-overlay|wisepops-root|recart-popup|recart-modal)/;
function isThirdPartyOverlay(raw: RawNode): boolean {
  const idClass = `${raw.attrs?.id ?? ""} ${raw.attrs?.class ?? ""}`.toLowerCase();
  if (THIRD_PARTY_OVERLAY.test(idClass)) return true;
  if (POPUP_OVERLAY_CONTAINER.test(idClass)) return true;
  // INT_MAX band: overlay libraries stack above everything. Real content should not reach here,
  // so this cannot swallow site chrome under normal captures.
  const zi = parseInt(raw.computed?.zIndex ?? "", 10);
  return Number.isFinite(zi) && zi >= 2147483000;
}

function elementChildren(n: RawNode): RawNode[] {
  return n.children.filter((c) => (c as { text?: string }).text === undefined) as RawNode[];
}

/** True for a transform value that is visually the identity (no offset/rotation/scale):
 *  the `none` keyword or an identity matrix/matrix3d the browser reports as noise. */
export function isIdentityTransform(value: string | undefined): boolean {
  if (!value || value === "none") return true;
  const m = /^matrix\(([^)]*)\)$/.exec(value.trim());
  if (m) {
    const n = m[1]!.split(",").map((s) => parseFloat(s.trim()));
    return n.length === 6 && n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1 && n[4] === 0 && n[5] === 0;
  }
  const m3 = /^matrix3d\(([^)]*)\)$/.exec(value.trim());
  if (m3) {
    const n = m3[1]!.split(",").map((s) => parseFloat(s.trim()));
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return n.length === 16 && n.every((v, i) => v === id[i]);
  }
  return false;
}

/**
 * Normalize per-viewport transform values so identity is represented uniformly as the literal
 * `none`. Two problems this closes, both in the per-viewport delta emission downstream:
 *   1. The browser reports "no transform" inconsistently — `none` at some widths, an identity
 *      `matrix(1,0,0,1,0,0)` at others (composited-layer noise). The generator's default-skip
 *      only recognizes `none`, so an identity matrix at the base viewport is emitted as a real
 *      transform and then cascades across bands.
 *   2. When ANY viewport carries a genuine (non-identity) transform, the identity value at the
 *      other viewports must stay observable — canonicalizing it to `none` (not dropping it) lets
 *      the generator emit the explicit reset so the non-identity transform can't leak into a band
 *      where the source had none.
 * Deterministic, in place; only touches the `transform` slot.
 */
export function canonicalizeTransforms(computedByVp: Record<number, StyleMap>): void {
  for (const k of Object.keys(computedByVp)) {
    const cs = computedByVp[Number(k)];
    if (cs && isIdentityTransform(cs.transform)) cs.transform = "none";
  }
}

/** True when an INFINITE CSS animation is active at this viewport. Such an animation perpetually
 *  drives its animated properties (opacity/transform), so the captured value is a frozen phase of
 *  the loop, not authored design. */
function hasInfiniteAnimation(cs: StyleMap | undefined): boolean {
  if (!cs || (cs.animationName || "none") === "none") return false;
  return /infinite/.test(cs.animationIterationCount || "1");
}

/**
 * Neutralize the transform of a node that carries an INFINITE animation at ANY captured viewport.
 * The capture shutter froze the marquee/spinner mid-loop, and — critically — a CSS animation gated
 * to a breakpoint (Webflow's `max-lg` logo/big-text tracks) reads `animation:none` at the widths
 * where it does NOT run, yet the browser still reports the last frozen `translateX` there. Banding
 * those frozen values bakes a mid-scroll offset that shifts content offscreen-left AT REST (rows
 * starting mid-glyph). The runtime `@keyframes` owns the transform and starts at translateX(0), so
 * the faithful at-rest value is `none` at every width; generation's `animOwnedProps` then keeps the
 * base holding while the animation drives it live. Only fires when a genuine infinite animation is
 * present at some viewport — a statically-offset design element (no animation) is untouched.
 * Deterministic, in place; only touches the `transform` slot.
 */
export function neutralizeAnimatedTransforms(computedByVp: Record<number, StyleMap>): void {
  const vps = Object.keys(computedByVp).map(Number);
  if (!vps.some((vp) => hasInfiniteAnimation(computedByVp[vp]))) return;
  for (const vp of vps) {
    const cs = computedByVp[vp];
    if (cs && cs.transform && cs.transform !== "none") cs.transform = "none";
  }
}

/** Full identity signature (tag + id + class). */
function sigFull(n: RawNode): string {
  return `${n.tag}#${n.attrs?.id ?? ""}.${(n.attrs?.class ?? "").trim()}`;
}
/** Loose signature (tag + id, no class) for nodes whose class changes responsively. */
function sigTag(n: RawNode): string {
  return `${n.tag}#${n.attrs?.id ?? ""}`;
}

/** Order-preserving LCS over two key sequences; returns matched (i, j) index
 *  pairs in increasing order. Deterministic; falls back to positional matching
 *  for pathologically large sibling groups. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  const pairs: Array<[number, number]> = [];
  if (n === 0 || m === 0) return pairs;
  if (n * m > 1_000_000) {
    for (let i = 0; i < Math.min(n, m); i++) if (a[i] === b[i]) pairs.push([i, i]);
    return pairs;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Order-preserving alignment of a parent's element children across two captures.
 * Returns, for each canonical child, the matching child in the other viewport (or
 * undefined). Two passes:
 *   1. LCS on the full signature (tag+id+class) — anchors stable identities and
 *      keeps responsive insertions/removals from shifting the rest (e.g. a
 *      mobile-only wrapper between <header> and <main>).
 *   2. Within each gap between pass-1 anchors, LCS on tag+id only — so elements
 *      whose class is swapped per breakpoint (JS responsive typography, e.g.
 *      `type-md-lg` ↔ `type-xl`) still align, while a genuinely conditionally
 *      rendered element with no counterpart in its gap stays unmatched (→ the
 *      generator hides it at that viewport). Deterministic.
 */
function alignChildren(canon: RawNode[], other: RawNode[]): (RawNode | undefined)[] {
  const n = canon.length;
  const out: (RawNode | undefined)[] = new Array(n).fill(undefined);
  if (n === 0 || other.length === 0) return out;

  const matchJ = new Array<number>(n).fill(-1);
  for (const [i, j] of lcsPairs(canon.map(sigFull), other.map(sigFull))) {
    matchJ[i] = j; out[i] = other[j];
  }

  // Pass 2: align leftover nodes inside each gap bounded by pass-1 anchors.
  const aI = [-1], aJ = [-1];
  for (let i = 0; i < n; i++) { const mj = matchJ[i]!; if (mj >= 0) { aI.push(i); aJ.push(mj); } }
  aI.push(n); aJ.push(other.length);
  for (let a = 0; a + 1 < aI.length; a++) {
    const cg: number[] = []; for (let i = aI[a]! + 1; i < aI[a + 1]!; i++) cg.push(i);
    const og: number[] = []; for (let j = aJ[a]! + 1; j < aJ[a + 1]!; j++) og.push(j);
    if (cg.length === 0 || og.length === 0) continue;
    for (const [gi, gj] of lcsPairs(cg.map((i) => sigTag(canon[i]!)), og.map((j) => sigTag(other[j]!)))) {
      out[cg[gi]!] = other[og[gj]!];
    }
  }
  return out;
}

/** Capture-ids of recognized-pattern panels/regions to force-keep through pruning
 *  (they are display:none in the inactive/collapsed base state). Empty when no
 *  interactions were captured, so non-interactive runs prune exactly as before. */
function readPreserveCaps(sourceDir: string): Set<string> {
  const set = new Set<string>();
  const p = join(sourceDir, "interaction.json");
  if (!fileExists(p)) return set;
  try {
    const it = readJSON<InteractionCapture>(p);
    for (const pat of it.patterns ?? []) {
      if (pat.kind === "tabs") for (const t of pat.tabs) set.add(t.panelCap);
      else if (pat.kind === "accordion") for (const i of pat.items) set.add(i.regionCap);
      else if (pat.kind === "carousel") set.add(pat.trackCap); // keep the whole slide track
      else for (const i of pat.items) set.add(i.panelCap); // disclosure: keep hidden overlay panels
    }
  } catch { /* malformed — preserve nothing */ }
  return set;
}

export function buildIR(sourceDir: string, viewports: number[], opts?: { motion?: boolean; bandViewports?: number[] }): IR {
  const captureDir = join(sourceDir, "capture");
  // `viewports` are ALL captured widths — the dense sample set used for size inference. The
  // BAND/gate widths (the responsive breakpoints we emit + grade) are the standard subset.
  const bandVps = (opts?.bandViewports ?? viewports).filter((v) => viewports.includes(v));
  const snapshots: Record<number, PageSnapshot> = {};
  for (const vw of viewports) {
    snapshots[vw] = readJSON<PageSnapshot>(join(captureDir, `dom-${vw}.json`));
  }
  const canonical = viewports.includes(1280) ? 1280 : viewports[Math.floor(viewports.length / 2)]!;
  const canonSnap = snapshots[canonical]!;

  // Stage 4: recognized interactive panels (tabs/accordion) are often display:none
  // at base (the inactive/collapsed state). Their subtrees must survive pruning so
  // the controller can reveal them — collect their capture-ids to force-keep. Read
  // from the same source dir, so generation and validation stay consistent.
  const preserveCaps = readPreserveCaps(sourceDir);

  let counter = 0;
  const nextId = (): string => `n${counter++}`;

  // `matched` carries, for each viewport, the raw node corresponding to `raw`
  // (the canonical node) — found by aligning siblings, not by raw index.
  const convert = (raw: RawNode, matched: Record<number, RawNode | undefined>): IRNode | null => {
    if (NOISE_TAGS.has(raw.tag)) return null;
    if (isThirdPartyOverlay(raw)) return null;
    // Font-metric / measurement scratch nodes the source's own JS injects (tagged by the walker):
    // absolutely positioned, parked far off-screen, non-painting. Never user-visible — drop so they
    // don't ship as page markup (e.g. the `<div … -top-[6249rem] invisible>Mgy</div>` probe).
    if (raw.probe) return null;

    const visibleByVp: Record<number, boolean> = {};
    const bboxByVp: Record<number, BBox> = {};
    const computedByVp: Record<number, StyleMap> = {};
    const sizingByVp: Record<number, RawSizing> = {};
    const beforeByVp: Record<number, StyleMap> = {};
    const afterByVp: Record<number, StyleMap> = {};
    const placeholderByVp: Record<number, StyleMap> = {};

    for (const vw of viewports) {
      const match = matched[vw];
      if (!match || match.tag !== raw.tag) continue;
      visibleByVp[vw] = match.visible;
      bboxByVp[vw] = match.bbox;
      computedByVp[vw] = match.computed;
      if (match.sizing) sizingByVp[vw] = match.sizing;
      if (match.before) beforeByVp[vw] = match.before;
      if (match.after) afterByVp[vw] = match.after;
      if (match.placeholder) placeholderByVp[vw] = match.placeholder;
    }
    // Canonicalize identity transforms (none / identity matrix) to `none` at every viewport so
    // the generator's per-band delta treats them uniformly and a scroll/composite-noise transform
    // at one width can't leak across bands.
    canonicalizeTransforms(computedByVp);
    // Drop transforms frozen mid-loop by an infinite animation (marquees/spinners) at every viewport —
    // including the breakpoints where the animation is gated off but the browser still reports the last
    // frozen offset. Prevents a baked mid-scroll translateX from clipping content offscreen at rest.
    neutralizeAnimatedTransforms(computedByVp);

    const node: IRNode = {
      id: nextId(),
      tag: raw.tag,
      attrs: filterAttrs(resolveLazyAttrs(raw.attrs)),
      visibleByVp,
      bboxByVp,
      computedByVp,
      children: [],
    };
    if (raw.rawHTML) node.rawHTML = raw.rawHTML;
    const srcClass = (raw.attrs?.class ?? "").trim();
    if (srcClass) node.srcClass = srcClass;
    if (Object.keys(sizingByVp).length) node.sizingByVp = sizingByVp;
    if (Object.keys(beforeByVp).length) node.beforeByVp = beforeByVp;
    if (Object.keys(afterByVp).length) node.afterByVp = afterByVp;
    if (Object.keys(placeholderByVp).length) node.placeholderByVp = placeholderByVp;

    if (!raw.rawHTML) {
      const canonKids = elementChildren(raw);
      // Align this node's canonical element children to each viewport's children.
      const aligned: Record<number, (RawNode | undefined)[]> = {};
      for (const vw of viewports) {
        if (vw === canonical) continue;
        const m = matched[vw];
        const vwKids = m && m.tag === raw.tag ? elementChildren(m) : [];
        aligned[vw] = alignChildren(canonKids, vwKids);
      }
      let ei = 0;
      for (const c of raw.children) {
        if ((c as IRTextNode).text !== undefined) {
          node.children.push({ text: (c as IRTextNode).text });
          continue;
        }
        const child = c as RawNode;
        const childMatched: Record<number, RawNode | undefined> = {};
        for (const vw of viewports) childMatched[vw] = vw === canonical ? child : aligned[vw]![ei];
        ei++;
        const converted = convert(child, childMatched);
        if (converted) node.children.push(converted);
      }
    }
    return node;
  };

  const rootMatched: Record<number, RawNode | undefined> = {};
  for (const vw of viewports) rootMatched[vw] = snapshots[vw]!.root;
  const root = convert(canonSnap.root, rootMatched)!;

  // Prune nodes invisible in every viewport with no visible descendants and no
  // text — these are unobserved (display:none everywhere) and should not be
  // invented in the clone.
  const prune = (node: IRNode, forced: boolean): boolean => {
    // returns true if node should be kept. `forced` propagates down from a preserved
    // interactive panel so its whole (possibly display:none) subtree is retained.
    const keepAll = forced || preserveCaps.has(node.attrs["data-cid-cap"] ?? "");
    const keptChildren: IRChild[] = [];
    let hasVisibleDescendant = false;
    let hasText = false;
    for (const c of node.children) {
      if (isTextChild(c)) {
        if (c.text.trim().length > 0) hasText = true;
        keptChildren.push(c);
        continue;
      }
      // `<source>` carries a <picture>/<video>'s media/art-direction candidates but never
      // paints (0×0 at every viewport), so the visibility prune would always drop it —
      // losing responsive variants (the lazy-loaded mobile img.src then serves every
      // width). Keep it structurally; generation emits it only when its file materialized.
      const keepSource = c.tag === "source" && (node.tag === "picture" || node.tag === "video");
      if (keepAll) {
        prune(c, true);
        keptChildren.push(c);
        if (Object.values(c.visibleByVp).some(Boolean) || childHasVisible(c)) hasVisibleDescendant = true;
      } else if (prune(c, false) || keepSource) {
        keptChildren.push(c);
        if (Object.values(c.visibleByVp).some(Boolean) || childHasVisible(c)) hasVisibleDescendant = true;
      }
    }
    node.children = keptChildren;
    if (keepAll) return true;
    const selfVisible = Object.values(node.visibleByVp).some(Boolean);
    return selfVisible || hasVisibleDescendant || hasText || !!node.rawHTML;
  };
  const childHasVisible = (n: IRNode): boolean => {
    for (const c of n.children) {
      if (isTextChild(c)) continue;
      if (Object.values(c.visibleByVp).some(Boolean)) return true;
      if (childHasVisible(c)) return true;
    }
    return false;
  };
  prune(root, false);

  // Re-number ids after pruning so they are a dense pre-order sequence (stable
  // and deterministic for matching during validation).
  counter = 0;
  const renumber = (node: IRNode): void => {
    node.id = nextId();
    for (const c of node.children) if (!isTextChild(c)) renumber(c);
  };
  renumber(root);

  const perViewport: IRDoc["perViewport"] = {};
  for (const vw of viewports) {
    const d = snapshots[vw]!.doc;
    perViewport[vw] = {
      scrollHeight: d.scrollHeight,
      scrollWidth: d.scrollWidth,
      htmlBg: d.htmlBg,
      bodyBg: d.bodyBg,
      bodyColor: d.bodyColor,
      bodyFont: d.bodyFont,
    };
  }

  const doc: IRDoc = {
    sourceUrl: canonSnap.doc.url,
    title: canonSnap.doc.title,
    head: (canonSnap.doc as { head?: IRDoc["head"] }).head,
    lang: canonSnap.doc.lang,
    charset: canonSnap.doc.charset,
    metaViewport: canonSnap.doc.metaViewport,
    viewports: bandVps,
    sampleViewports: viewports,
    canonicalViewport: canonical,
    perViewport,
    nodeCount: counter,
    // Stage 5: only carry @keyframes when motion is enabled. Off (the plain static
    // benchmark + all multi-page, which don't capture motion) ⇒ none emitted, so the
    // clone stays byte-identical to the pre-Stage-5 frozen output.
    keyframes: opts?.motion ? [...new Set(canonSnap.keyframes ?? [])].sort() : [],
  };

  // Repair transient root scroll-locks. A site that locks scrolling during an intro
  // (body/html { height:100vh; overflow-y:scroll|hidden }) can be captured in that
  // state: the root's bbox is pinned to one viewport even though the real document
  // scrolled taller (perViewport.scrollHeight). Left as-is, the root box — and any
  // whole-page section derived from it — under-reports its height, so a clone that
  // correctly renders the settled (un-clamped) document fails the section-bbox gate
  // against a stale 1-viewport height. When the captured scrollHeight exceeds the
  // pinned root height AND the overflow clips, correct the root's bbox to the real
  // document extent (a genuine internal-scroll shell instead reports scrollHeight ==
  // its own height, so it is left untouched). Mirrors the CSS un-clamp.
  const fixRootScrollLock = (node: IRNode): void => {
    if (node.tag === "body" || node.tag === "html") {
      for (const vw of viewports) {
        const bb = node.bboxByVp[vw]; const cs = node.computedByVp[vw];
        const sh = perViewport[vw]?.scrollHeight ?? 0;
        if (!bb || !cs) continue;
        const ov = cs.overflowY || cs.overflow || "visible";
        if (/^(scroll|hidden|auto|clip)$/.test(ov) && sh > bb.height + 4) bb.height = sh;
      }
    }
    for (const c of node.children) if (!isTextChild(c)) fixRootScrollLock(c);
  };
  fixRootScrollLock(root);

  // Sizing-intent overlay: when the SOURCE capture predates the probe — e.g. this
  // sandbox cannot re-fetch the live site through the egress proxy — fall back to the LOCAL clone
  // render's probe (the gate-verified faithful proxy), matched back to IR nodes by cid. In normal
  // operation the source capture carries `sizing` natively and this overlay is skipped.
  if (!(canonSnap.root as RawNode).sizing) attachSizingOverlay(root, join(sourceDir, "..", "rendered", "dom"), viewports);

  return { doc, root };
}

function attachSizingOverlay(root: IRNode, renderedDomDir: string, viewports: number[]): void {
  const byVp: Record<number, Map<string, { wAuto: boolean; wFill: boolean; hAuto: boolean }>> = {};
  for (const vw of viewports) {
    const p = join(renderedDomDir, `dom-${vw}.json`);
    if (!fileExists(p)) continue;
    const snap = readJSON<PageSnapshot>(p);
    const m = new Map<string, { wAuto: boolean; wFill: boolean; hAuto: boolean }>();
    const walk = (n: RawNode | RawChild | undefined): void => {
      if (!n || typeof n !== "object" || "text" in n) return;
      const cid = n.attrs?.["data-cid"]; if (cid && n.sizing) m.set(cid, n.sizing);
      for (const c of n.children || []) walk(c);
    };
    walk(snap.root);
    byVp[vw] = m;
  }
  const apply = (node: IRNode): void => {
    for (const vw of viewports) {
      const s = byVp[vw]?.get(node.id);
      if (s) { (node.sizingByVp ??= {})[vw] = s; }
    }
    for (const c of node.children) if (!("text" in c)) apply(c);
  };
  apply(root);
}

export function writeIR(ir: IR, sourceDir: string): void {
  writeJSONCompact(join(sourceDir, "normalized-dom", "ir.json"), ir);
  // A small summary for quick human inspection.
  writeJSON(join(sourceDir, "normalized-dom", "ir-summary.json"), {
    doc: ir.doc,
    rootTag: ir.root.tag,
    nodeCount: ir.doc.nodeCount,
  });
}
