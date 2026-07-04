/**
 * Section splitting (output-quality, fidelity-neutral).
 *
 * The page is one deep tree, so inlined it becomes a single 400-line page.tsx. A readable
 * app should instead be a short composition of named sections — Navbar, HeroSection,
 * AboutSection, ..., Footer — each in its own file. This module
 * finds those section roots and names them; the generator (app.ts) emits each section
 * subtree as its own module and leaves a `<HeroSection />` placeholder in page.tsx.
 *
 * Render-identical: a section module renders the exact same subtree (same tags, cids,
 * classes), so the composed DOM is byte-for-byte what inlining produced — gates align
 * by data-cid with no change. We do NOT flatten the wrapper chain (those divs are real,
 * styled nodes); page.tsx keeps the wrappers and plugs section components into them.
 */
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { RecipeCandidate, RecipeKind, RecipeReport } from "../infer/recipes.js";
import { detectSectionNodes, heroLikeHeader } from "../infer/sections.js";
import { subtreeSignature } from "../site/sharedLayout.js";

export type SectionPlan = {
  /** section-root cid → PascalCase component name. */
  roots: Map<string, string>;
};

const MIN_SECTION_H = 56;
const MAX_SECTIONS = 32;

function box(n: IRNode, cw: number): { width: number; height: number } | undefined {
  return n.bboxByVp[cw] ?? Object.values(n.bboxByVp)[0];
}
function yOf(n: IRNode, cw: number): number {
  return (n.bboxByVp[cw] ?? Object.values(n.bboxByVp)[0])?.y ?? 0;
}
function elementChildren(n: IRNode): IRNode[] {
  return n.children.filter((c): c is IRNode => !isTextChild(c));
}

function subtreeHasTag(n: IRNode, tag: string, depth = 4): boolean {
  if (depth < 0) return false;
  for (const c of elementChildren(n)) {
    if (c.tag === tag) return true;
    if (subtreeHasTag(c, tag, depth - 1)) return true;
  }
  return false;
}

function collectIds(n: IRNode, out = new Set<string>()): Set<string> {
  out.add(n.id);
  for (const c of elementChildren(n)) collectIds(c, out);
  return out;
}

/** First heading text (h1–h6) in a subtree, else the first non-trivial text run. */
function titleText(n: IRNode, depth = 6): string {
  const fromHeadings = (node: IRNode, d: number): string => {
    if (d < 0) return "";
    for (const c of elementChildren(node)) {
      if (/^h[1-6]$/.test(c.tag)) { const t = textOf(c); if (t.trim()) return t; }
      const sub = fromHeadings(c, d - 1); if (sub) return sub;
    }
    return "";
  };
  const h = fromHeadings(n, depth);
  if (h) return h;
  return textOf(n);
}
function textOf(n: IRNode): string {
  let s = "";
  const walk = (x: IRNode): void => {
    for (const c of x.children) {
      if (isTextChild(c)) { if (c.text.trim()) s += " " + c.text.trim(); }
      else walk(c);
      if (s.length > 60) return;
    }
  };
  walk(n);
  return s.trim();
}

const STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "for", "with", "your", "our", "is", "are", "be", "at", "on", "we", "you", "that", "this", "from", "by", "or", "it", "as", "new"]);
/** Slugify prominent text into ≤3 PascalCase words for a section name. */
function slugWords(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (kept.length >= 3) break;
    if (STOP.has(w) && kept.length === 0) continue;
    if (/^\d+$/.test(w) && kept.length === 0) continue; // drop leading numeric-only noise (e.g. layer ids "0019")
    if (w.length < 2 && !/\d/.test(w)) continue;
    kept.push(w);
  }
  return kept.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}

/** Ensure a generated name is a valid JS identifier (it's used as an import/export id,
 *  and the kebab filename derives from it — so fixing it here keeps id + path in sync).
 *  A name that doesn't start with a letter/_/$ (e.g. "3dSection") gets an "S" prefix. */
function identName(name: string): string {
  return /^[A-Za-z_$]/.test(name) ? name : "S" + name;
}

// Generic structural words that carry no section identity — dropped from source-derived names.
const GENERIC_NAME_WORDS = new Set([
  "section", "sections", "wrapper", "container", "block", "blocks", "template", "templates",
  "group", "inner", "outer", "content", "contents", "row", "col", "column", "grid", "layout",
  "shopify", "js", "tvg", "elementor", "wp", "widget", "module", "region", "main", "page",
  "component", "components", "el", "root", "body", "area", "box", "item", "items", "wrap",
]);

/** A trailing token looks like a build hash (mixed-case or long alnum entropy, e.g.
 *  `JtTWTt`, `RbEALJ`, `x19f2a`, `dDMm2q`) rather than a real word — strip it. A token is
 *  hashy when it is ≥4 chars and either mixes upper+lower case or is a long digit-bearing run. */
function looksHashy(tok: string): boolean {
  if (tok.length < 4) return false;
  const hasUpper = /[A-Z]/.test(tok), hasLower = /[a-z]/.test(tok), hasDigit = /\d/.test(tok);
  if (hasUpper && hasLower) return true;                 // camel/entropy hash: JtTWTt, dDMm2q
  if (hasDigit && tok.length >= 6) return true;          // long id run: 19797275672650
  if (!/[aeiou]/i.test(tok) && tok.length >= 5) return true; // vowelless run: bcdfgh
  return false;
}

/** Turn a source id/class token stream into ≤3 semantic PascalCase words, or "" when the
 *  evidence is all-generic or hashy. Strips CMS prefixes (shopify-section-…__), leading
 *  numeric template ids, generic structural words, and trailing hash suffixes. Exported for
 *  tests (the hashy-suffix stripping + generic-word filtering is the load-bearing part). */
export function nameFromSourceToken(raw: string): string {
  // Peel known CMS section-id prefixes, keeping the semantic slug after `__` / the hook name.
  // Case is preserved through prefix-stripping + tokenizing so `looksHashy` can see the
  // mixed-case entropy of build hashes (RbEALJ, JtTWTt) BEFORE we normalize to lowercase.
  const s = raw.trim()
    .replace(/^shopify-section-(?:template|sections)--\d+__/i, "")
    .replace(/^shopify-(?:section|block)-/i, "")
    .replace(/^(?:js|tvg|elementor|wp|et|elementor-element)[-_]/i, "");
  const tokens = s.split(/[\s\-_]+/).filter(Boolean);
  const kept: string[] = [];
  for (const t of tokens) {
    if (kept.length >= 3) break;
    if (/^\d+$/.test(t)) continue;                  // pure numeric template ids
    if (GENERIC_NAME_WORDS.has(t.toLowerCase())) continue; // structural noise
    if (looksHashy(t)) continue;                    // trailing entropy suffix (mixed-case aware)
    if (t.length < 2) continue;
    const lc = t.toLowerCase();
    kept.push(lc[0]!.toUpperCase() + lc.slice(1));
  }
  return kept.join("");
}

// A source `id` (or `data-section-type`) is a DELIBERATE, developer-authored block name only
// when it carries a recognized CMS section prefix — Shopify's `shopify-section-…__split_callout`,
// or a generic `section-…`/`…-section`. Arbitrary utility classes (`g_section_space`,
// `duraldar-cta_section`) are styling noise, so we do NOT mine class names — a truncated heading
// slug reads better than a made-up name. `js-*` behaviour hooks ARE intentional and allowed.
const CMS_SECTION_ID = /shopify-section|^section[-_]|[-_]section(?:[-_]|$)|data-section/i;

/** Best semantic name derivable from a section subtree's source *ids* + `js-*` hooks — the
 *  only source signals reliable enough to beat a heading slug. Scans the root + shallow
 *  descendants. Returns "" when no trustworthy semantic evidence exists. */
function sourceNameForSection(sec: IRNode): string {
  const candidates: string[] = [];
  const collect = (n: IRNode, depth: number): void => {
    const id = n.attrs.id;
    if (id && CMS_SECTION_ID.test(id)) candidates.push(id);
    const sectionType = n.attrs["data-section-type"] ?? n.attrs["data-section"];
    if (sectionType) candidates.push(sectionType);
    if (n.srcClass) {
      // Only explicit `js-…` behaviour hooks — a deliberate semantic handle, not a utility class.
      for (const cls of n.srcClass.split(/\s+/)) if (/^js[-_][a-z]/i.test(cls)) candidates.push(cls);
    }
    if (depth > 0) for (const c of elementChildren(n)) collect(c, depth - 1);
  };
  collect(sec, 2);
  for (const c of candidates) {
    const name = nameFromSourceToken(c);
    if (name && name.length >= 3) return name;
  }
  return "";
}

function looksLikeNav(n: IRNode, cw: number): boolean {
  if (n.tag === "nav" || n.tag === "header") return true;
  if (subtreeHasTag(n, "nav")) return true;
  const b = box(n, cw);
  return !!b && b.height <= 140; // a short full-width bar at the top
}

const RECIPE_SECTION_NAME: Partial<Record<RecipeKind, string>> = {
  "logo-cloud": "LogoCloudSection",
  "feature-grid": "FeatureGridSection",
  "product-grid": "ProductGridSection",
  "gallery-showcase": "GalleryShowcaseSection",
  "cta-band": "CtaSection",
};

const RECIPE_FALLBACK_SECTION_NAME: Partial<Record<RecipeKind, string>> = {
  ...RECIPE_SECTION_NAME,
  "card-grid": "CardGridSection",
};

function recipeEligible(r: RecipeCandidate): boolean {
  if (r.kind === "gallery-showcase") return r.confidence >= 0.82;
  if (r.kind === "cta-band") return r.confidence >= 0.7;
  return r.confidence >= 0.82;
}

function recipeRank(kind: RecipeKind): number {
  switch (kind) {
    case "gallery-showcase": return 5;
    case "product-grid": return 4;
    case "cta-band": return 3;
    case "feature-grid": return 2;
    case "logo-cloud": return 1;
    default: return 0;
  }
}

function recipeNameForSection(sec: IRNode, recipes?: RecipeReport): string | null {
  if (!recipes) return null;
  const ids = collectIds(sec);
  const matches = recipes.candidates
    .filter((r) => recipeEligible(r) && RECIPE_SECTION_NAME[r.kind] && ids.has(r.rootCid))
    .sort((a, b) => recipeRank(b.kind) - recipeRank(a.kind) || b.confidence - a.confidence || a.id.localeCompare(b.id));
  const best = matches[0];
  return best ? RECIPE_SECTION_NAME[best.kind] ?? null : null;
}

function indexTree(root: IRNode): { byId: Map<string, IRNode>; parentById: Map<string, IRNode | undefined> } {
  const byId = new Map<string, IRNode>();
  const parentById = new Map<string, IRNode | undefined>();
  const walk = (node: IRNode, parent: IRNode | undefined): void => {
    byId.set(node.id, node);
    parentById.set(node.id, parent);
    for (const c of elementChildren(node)) walk(c, node);
  };
  walk(root, undefined);
  return { byId, parentById };
}

function sourceLooksSectionish(n: IRNode): boolean {
  return n.tag === "section" || n.tag === "article" || /\b(?:section|wrapper|container|surface|layout|above.?the.?fold|scroll.?container|content|root)\b/i.test(n.srcClass ?? "");
}

function recipeFallbackAnchor(ir: IR, recipe: RecipeCandidate, byId: Map<string, IRNode>, parentById: Map<string, IRNode | undefined>): IRNode | undefined {
  const cw = ir.doc.canonicalViewport;
  const pageH = ir.doc.perViewport[cw]?.scrollHeight ?? 0;
  const root = byId.get(recipe.rootCid);
  const rb = root ? box(root, cw) : undefined;
  const rootTooBroad = !root || root.id === ir.root.id || (!!pageH && !!rb && rb.height > pageH * 0.55);
  let anchor = rootTooBroad && recipe.itemParentCid ? byId.get(recipe.itemParentCid) : root;
  if (!anchor) return undefined;
  const maxH = pageH ? Math.max(1600, pageH * 0.35) : 1600;
  let best = anchor;
  let cur: IRNode | undefined = anchor;
  while (cur) {
    const parent = parentById.get(cur.id);
    if (!parent || parent.id === ir.root.id || parent.tag === "body") break;
    const pb = box(parent, cw);
    if (!pb || pb.height < MIN_SECTION_H || pb.height > maxH) break;
    if (pb.width >= cw * 0.45 && sourceLooksSectionish(parent)) best = parent;
    cur = parent;
  }
  return best;
}

function recipeFallbackSections(ir: IR, recipes?: RecipeReport): { sections: IRNode[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  if (!recipes) return { sections: [], names };
  const { byId, parentById } = indexTree(ir.root);
  const byRoot = new Map<string, { node: IRNode; name: string; rank: number; confidence: number }>();
  for (const recipe of recipes.candidates) {
    if (!recipeEligible(recipe)) continue;
    const name = RECIPE_FALLBACK_SECTION_NAME[recipe.kind];
    if (!name) continue;
    const node = recipeFallbackAnchor(ir, recipe, byId, parentById);
    if (!node || node.id === ir.root.id) continue;
    const b = box(node, ir.doc.canonicalViewport);
    if (!b || b.height < MIN_SECTION_H) continue;
    const rank = recipeRank(recipe.kind);
    const prev = byRoot.get(node.id);
    if (!prev || rank > prev.rank || (rank === prev.rank && recipe.confidence > prev.confidence)) {
      byRoot.set(node.id, { node, name, rank, confidence: recipe.confidence });
    }
  }
  let sections = [...byRoot.values()]
    .map((v) => v.node)
    .sort((a, b) => yOf(a, ir.doc.canonicalViewport) - yOf(b, ir.doc.canonicalViewport));
  sections = sections.filter((node, index) => {
    const ids = collectIds(node);
    return !sections.some((other, otherIndex) => otherIndex !== index && ids.has(other.id) && (box(other, ir.doc.canonicalViewport)?.height ?? 0) < (box(node, ir.doc.canonicalViewport)?.height ?? Infinity));
  });
  for (const node of sections) {
    const hit = byRoot.get(node.id);
    if (hit) names.set(node.id, hit.name);
  }
  return { sections, names };
}

export function planSections(ir: IR, recipes?: RecipeReport): SectionPlan {
  const cw = ir.doc.canonicalViewport;
  const pageH = ir.doc.perViewport[cw]?.scrollHeight ?? 0;
  // The shared recursive band decomposition (infer/sections) — the same roots the
  // section gate validates, so each emitted file corresponds to a gate section.
  const bands = detectSectionNodes(ir).filter((n) => n.id !== ir.root.id);
  // Exclude any band that is part of a REPEATED run (≥3 same-signature siblings): that's
  // a component cluster (a card/logo grid), which component extraction should turn into a
  // `.map()` over a data array — not a wall of near-identical "section" files. Only the
  // distinct, one-off blocks become sections.
  const distinctOf = (list: IRNode[]): IRNode[] => {
    const count = new Map<string, number>();
    for (const s of list) { const sig = subtreeSignature(s); count.set(sig, (count.get(sig) ?? 0) + 1); }
    return list.filter((s) => (count.get(subtreeSignature(s)) ?? 0) < 3);
  };

  let sections = distinctOf(bands);
  let recipeNameHints = new Map<string, string>();
  if (sections.length < 3) {
    const fallback = recipeFallbackSections(ir, recipes);
    if (fallback.sections.length >= 3) {
      sections = fallback.sections;
      recipeNameHints = fallback.names;
    }
  }
  const roots = new Map<string, string>();
  if (sections.length < 3 || sections.length > MAX_SECTIONS) return { roots };

  const used = new Map<string, number>();
  const dedupe = (base: string): string => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  };

  // Hero must actually start near the top of the page; without the gate a
  // mid-page band inherits the name when the true hero was excluded (e.g. as a
  // repeated run), which is worse than an honest content-derived name.
  const heroMaxY = Math.max(900, pageH * 0.25);
  let heroAssigned = false;
  sections.forEach((sec, i) => {
    const isLast = i === sections.length - 1;
    const recipeName = recipeNameHints.get(sec.id) ?? recipeNameForSection(sec, recipes);
    let name: string;
    if (sec.tag === "footer" || (isLast && looksLikeNav(sec, cw) === false && subtreeHasTag(sec, "a") && (box(sec, cw)?.height ?? 0) < 700)) {
      name = sec.tag === "footer" ? "Footer" : (titleText(sec) ? slugWords(titleText(sec)) + "Section" : "Footer");
    } else if (sec.tag === "nav"
      || (i === 0 && looksLikeNav(sec, cw) && !heroLikeHeader(sec, cw))
      // a thin fixed bar wrapping the real <nav> (often a styled <div>, sorted after
      // the hero it overlays) is still the navbar
      || (yOf(sec, cw) <= 160 && (box(sec, cw)?.height ?? 0) <= 160 && subtreeHasTag(sec, "nav"))) {
      name = "Navbar";
    } else if (sec.tag === "header" && !heroLikeHeader(sec, cw)) {
      // a <header> carrying the page h1 at real height is the hero, not chrome
      name = "Header";
    } else if (!heroAssigned && yOf(sec, cw) <= heroMaxY) {
      heroAssigned = true;
      name = "HeroSection";
    } else if (recipeName) {
      name = recipeName;
    } else {
      // Prefer a clean semantic name from the source markup (Shopify/CMS section ids +
      // `js-*` hooks, hash suffixes stripped) over a truncated heading slug — the source
      // slug (`split_callout` → SplitCalloutSection) reads more like a hand-authored name.
      const sourceName = sourceNameForSection(sec);
      const slug = slugWords(titleText(sec));
      name = sourceName ? `${sourceName}Section`
        : slug ? `${slug}Section`
        : subtreeHasTag(sec, "form", 6) ? "ContactSection"
        : subtreeHasTag(sec, "video", 6) || subtreeHasTag(sec, "iframe", 6) ? "MediaSection"
        : `Section${i + 1}`;
    }
    roots.set(sec.id, dedupe(identName(name)));
  });
  return { roots };
}
