/**
 * Semantic class map (output-quality, fidelity-neutral).
 *
 * The per-node fidelity engine (css.ts) emits one `.c<id>{…}` rule per DOM node —
 * pixel-exact but a wall of opaque, unshared rules. This module rewrites that into a
 * small set of SHARED, semantically-named classes:
 *
 *   1. Compute each node's full rule (base + per-band deltas + pseudos) via the same
 *      collectNodeRules used by css.ts — one source of truth.
 *   2. Dedup nodes whose rule is BYTE-IDENTICAL into one class. Identical own-decls ⇒
 *      identical own-style; each node still inherits from its real parent, so the
 *      grader (which compares each node's FINAL computed style by data-cid) is
 *      unaffected. This is the safety invariant: sharing a class never changes a
 *      node's computed style.
 *   3. Name each class by ROLE (primitive type → btn/link/icon/…, else tag/layout →
 *      heading/list/row/stack/box), deduped with a numeric suffix.
 *
 * Result: ditto.css shrinks dramatically and reads as a component stylesheet, and
 * every element carries a meaningful class instead of `c142`. Determinism holds —
 * grouping + naming are pure functions of document order.
 */
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { PrimitiveType } from "../infer/primitives.js";
import type { TokenResolver } from "../infer/tokens.js";
import { collectNodeRules, assembleCss, keyframesCss, computeBands, type NodeRule } from "./css.js";

export type ClassMap = {
  /** cid → semantic class name (null/absent when the node has no own styles). */
  classOf: Map<string, string>;
  css: string;
  stats: { nodes: number; classes: number; reusePct: number };
};

function serDecls(m: Map<string, string>): string {
  let s = "";
  for (const [k, v] of m) s += k + ":" + v + ";";
  return s;
}
/** Canonical (exact, order-preserving) serialization of a node's full rule. Two nodes
 *  with the same string have byte-identical declarations at every viewport + pseudo. */
function signature(nr: NodeRule): string {
  let s = serDecls(nr.base);
  for (const b of nr.bands) s += `@${b.media}{${serDecls(b.decls)}}`;
  if (nr.before) { s += "::before{" + serDecls(nr.before.base); for (const b of nr.before.bands) s += `@${b.media}{${serDecls(b.decls)}}`; s += "}"; }
  if (nr.after) { s += "::after{" + serDecls(nr.after.base); for (const b of nr.after.bands) s += `@${b.media}{${serDecls(b.decls)}}`; s += "}"; }
  return s;
}

const PRIM_CLASS: Record<PrimitiveType, string> = {
  button: "btn", link: "link", input: "input", select: "select", textarea: "textarea",
  icon: "icon", image: "image", avatar: "avatar", badge: "badge", heading: "heading", nav: "nav",
};

/** A node's display role for class naming (only used for divs/spans/generic boxes). */
function layoutHint(nr: NodeRule): string | null {
  const disp = nr.base.get("display");
  if (disp === "grid" || disp === "inline-grid") return "grid";
  if (disp === "flex" || disp === "inline-flex") {
    const dir = nr.base.get("flex-direction");
    return dir === "column" || dir === "column-reverse" ? "stack" : "row";
  }
  return null;
}

const TAG_CLASS: Record<string, string> = {
  section: "section", header: "header", footer: "footer", nav: "nav", main: "main",
  aside: "aside", article: "article", ul: "list", ol: "list", li: "list-item",
  a: "link", button: "btn", p: "text", span: "text", label: "label", form: "form",
  figure: "figure", figcaption: "caption", blockquote: "quote", table: "table",
  thead: "thead", tbody: "tbody", tr: "row", td: "cell", th: "cell", img: "image",
  picture: "image", svg: "icon", video: "video", input: "input", select: "select",
  textarea: "textarea", h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
};

/** Semantic base name for a node's class — primitive type first (the strongest signal),
 *  then tag, then layout role for generic boxes. */
function classBaseName(node: IRNode, prim: string | undefined, nr: NodeRule): string {
  if (prim && PRIM_CLASS[prim as PrimitiveType]) return PRIM_CLASS[prim as PrimitiveType]!;
  const t = node.tag;
  if (TAG_CLASS[t]) return TAG_CLASS[t]!;
  if (t.includes("-")) return "widget"; // custom element
  // div / unknown: name by layout role so the markup reads (stack/row/grid/box).
  return layoutHint(nr) ?? "box";
}

function indexNodes(ir: IR): Map<string, IRNode> {
  const m = new Map<string, IRNode>();
  const walk = (n: IRNode): void => { m.set(n.id, n); for (const c of n.children) if (!isTextChild(c)) walk(c); };
  walk(ir.root);
  return m;
}

// Typographic / inherited properties. Split into their own SHARED class so the (few
// distinct) text styles on a page are reused across all elements that share them — the
// way a real stylesheet factors typography out of per-box layout. The remaining box/
// layout/visual props stay on a role-named box class. The two prop sets are disjoint, so
// an element carrying both classes resolves to exactly its original declarations.
const TYPO_PROPS = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "word-spacing", "text-align", "text-transform", "text-decoration-line",
  "text-decoration-style", "text-decoration-color", "white-space", "word-break", "overflow-wrap",
  "text-indent", "text-shadow", "font-variant-caps", "font-feature-settings", "list-style-type",
  "list-style-position", "writing-mode", "direction", "-webkit-text-fill-color", "-webkit-text-stroke",
]);
// Layout / flow properties (flex/grid container + item, gaps, overflow). These few
// patterns repeat heavily across a page, so factoring them into a shared layout class
// (.row/.stack/.grid/.flow) lifts reuse far above what whole-block classes allow — while
// geometry (width/height/padding/margin/border/position/visuals) stays per-element.
const LAYOUT_PROPS = new Set([
  "display", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content",
  "align-self", "flex-grow", "flex-shrink", "flex-basis", "order", "gap", "row-gap", "column-gap",
  "grid-template-columns", "grid-template-rows", "grid-template-areas", "grid-auto-flow",
  "grid-auto-rows", "grid-auto-columns", "justify-items", "overflow-x", "overflow-y",
]);

function partition(m: Map<string, string>): { typo: Map<string, string>; layout: Map<string, string>; box: Map<string, string> } {
  const typo = new Map<string, string>(), layout = new Map<string, string>(), box = new Map<string, string>();
  for (const [k, v] of m) (TYPO_PROPS.has(k) ? typo : LAYOUT_PROPS.has(k) ? layout : box).set(k, v);
  return { typo, layout, box };
}
/** Split a node's rule into typography / layout / geometry(box) rules (disjoint prop
 *  sets), with banded deltas split too. Pseudo-elements stay with the box rule. */
function splitRule(nr: NodeRule): { typo: NodeRule; layout: NodeRule; box: NodeRule } {
  const b0 = partition(nr.base);
  const typo: NodeRule = { base: b0.typo, bands: [] };
  const layout: NodeRule = { base: b0.layout, bands: [] };
  const box: NodeRule = { base: b0.box, bands: [], before: nr.before, after: nr.after };
  for (const band of nr.bands) {
    const bs = partition(band.decls);
    if (bs.typo.size) typo.bands.push({ media: band.media, decls: bs.typo });
    if (bs.layout.size) layout.bands.push({ media: band.media, decls: bs.layout });
    if (bs.box.size) box.bands.push({ media: band.media, decls: bs.box });
  }
  return { typo, layout, box };
}

/** Layout-class base name from the display/flex role. */
function layoutName(nr: NodeRule): string {
  const disp = nr.base.get("display");
  if (disp === "grid" || disp === "inline-grid") return "grid";
  if (disp === "flex" || disp === "inline-flex") {
    const dir = nr.base.get("flex-direction");
    return dir === "column" || dir === "column-reverse" ? "stack" : "row";
  }
  return "flow";
}

export function buildClassMap(ir: IR, assetMap: Map<string, string>, colorVar?: (v: string) => string | null, primitives?: Map<string, string>, tokenResolver?: TokenResolver): ClassMap {
  const rules = collectNodeRules(ir, assetMap, undefined, colorVar, tokenResolver);
  const bands = computeBands(ir.doc.viewports, ir.doc.canonicalViewport);
  const nodeByCid = indexNodes(ir);

  const sigToClass = new Map<string, string>();
  const classToRule = new Map<string, NodeRule>();
  const order: string[] = [];
  const nameCount = new Map<string, number>();
  const classOf = new Map<string, string>();

  // Dedup a (typo or box) rule by its signature → one shared class; name it `base`,
  // suffixing for distinct rules that want the same base name. Disjoint typo/box prop
  // sets mean their signatures never collide, so one map is safe.
  const assign = (sig: string, base: string, rule: NodeRule): string => {
    if (sig === "") return "";
    let cls = sigToClass.get(sig);
    if (!cls) {
      const n = (nameCount.get(base) ?? 0) + 1;
      nameCount.set(base, n);
      cls = n === 1 ? base : `${base}-${n}`;
      sigToClass.set(sig, cls);
      classToRule.set(cls, rule);
      order.push(cls);
    }
    return cls;
  };

  let usages = 0;
  for (const [cid, nr] of rules) { // document pre-order
    const { typo, layout, box } = splitRule(nr);
    const boxCls = assign(signature(box), classBaseName(nodeByCid.get(cid)!, primitives?.get(cid), box), box);
    const layoutCls = assign(signature(layout), layoutName(layout), layout);
    const typoCls = assign(signature(typo), "type", typo);
    // role/geometry class first, then layout, then typography
    const full = [boxCls, layoutCls, typoCls].filter(Boolean).join(" ");
    if (full) { classOf.set(cid, full); usages += (boxCls ? 1 : 0) + (layoutCls ? 1 : 0) + (typoCls ? 1 : 0); }
  }

  const kf = keyframesCss(ir, assetMap);
  const css = assembleCss(order, (c) => classToRule.get(c)!, (c) => `.${c}`, bands, kf);
  const reusePct = usages ? Math.round((1 - order.length / usages) * 1000) / 10 : 0;
  return { classOf, css, stats: { nodes: classOf.size, classes: order.length, reusePct } };
}
