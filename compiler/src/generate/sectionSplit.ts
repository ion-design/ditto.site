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
import { subtreeSignature } from "../site/sharedLayout.js";

export type SectionPlan = {
  /** section-root cid → PascalCase component name. */
  roots: Map<string, string>;
};

const MIN_SECTION_H = 56;
const MAX_SECTIONS = 24;

function box(n: IRNode, cw: number): { width: number; height: number } | undefined {
  return n.bboxByVp[cw] ?? Object.values(n.bboxByVp)[0];
}
function yOf(n: IRNode, cw: number): number {
  return (n.bboxByVp[cw] ?? Object.values(n.bboxByVp)[0])?.y ?? 0;
}
function visible(n: IRNode, cw: number): boolean {
  return !!(n.visibleByVp[cw] ?? Object.values(n.visibleByVp)[0]);
}
function elementChildren(n: IRNode): IRNode[] {
  return n.children.filter((c): c is IRNode => !isTextChild(c));
}
function significantChildren(n: IRNode, cw: number): IRNode[] {
  return elementChildren(n).filter((c) => visible(c, cw) && (box(c, cw)?.height ?? 0) >= MIN_SECTION_H);
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
  // Descend through the wrapper chain (single significant child) to the container
  // whose children are the actual sections.
  let node = ir.root;
  for (let i = 0; i < 10; i++) {
    const sig = significantChildren(node, cw);
    if (sig.length >= 2) break;
    if (sig.length === 1) { node = sig[0]!; continue; }
    const kids = elementChildren(node);
    if (kids.length === 1) { node = kids[0]!; continue; }
    break;
  }
  // Exclude any child that is part of a REPEATED run (≥3 same-signature siblings): that's
  // a component cluster (a card/logo grid), which component extraction should turn into a
  // `.map()` over a data array — not a wall of near-identical "section" files. Only the
  // distinct, one-off blocks become sections.
  const distinctOf = (list: IRNode[]): IRNode[] => {
    const count = new Map<string, number>();
    for (const s of list) { const sig = subtreeSignature(s); count.set(sig, (count.get(sig) ?? 0) + 1); }
    return list.filter((s) => (count.get(subtreeSignature(s)) ?? 0) < 3);
  };

  let candidates = significantChildren(node, cw);
  let sections = distinctOf(candidates);
  const fallback = recipeFallbackSections(ir, recipes);
  // If the container yields too few sections, a dominant child is a wrapper (e.g. <main>)
  // holding the real sections — expand such oversized children into their own significant
  // children, keeping the other siblings (e.g. a sibling <footer>). Gated on <3 so a page
  // that already splits cleanly is untouched.
  if (sections.length < 3) {
    const pageH = ir.doc.perViewport[cw]?.scrollHeight ?? 0;
    const expanded: IRNode[] = [];
    for (const c of candidates) {
      const inner = significantChildren(c, cw);
      const h = box(c, cw)?.height ?? 0;
      if (inner.length >= 3 && pageH > 0 && h >= pageH * 0.4) expanded.push(...inner);
      else expanded.push(c);
    }
    candidates = expanded;
    sections = distinctOf(candidates);
  }
  let recipeNameHints = new Map<string, string>();
  if (sections.length < 3 && fallback.sections.length >= 3) {
    sections = fallback.sections;
    recipeNameHints = fallback.names;
  }
  const roots = new Map<string, string>();
  if (sections.length < 3 || sections.length > MAX_SECTIONS) return { roots };

  const used = new Map<string, number>();
  const dedupe = (base: string): string => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  };

  let heroAssigned = false;
  sections.forEach((sec, i) => {
    const isLast = i === sections.length - 1;
    const recipeName = recipeNameHints.get(sec.id) ?? recipeNameForSection(sec, recipes);
    let name: string;
    if (sec.tag === "footer" || (isLast && looksLikeNav(sec, cw) === false && subtreeHasTag(sec, "a") && (box(sec, cw)?.height ?? 0) < 700)) {
      name = sec.tag === "footer" ? "Footer" : (titleText(sec) ? slugWords(titleText(sec)) + "Section" : "Footer");
    } else if (i === 0 && looksLikeNav(sec, cw)) {
      name = "Navbar";
    } else if (sec.tag === "header") {
      name = "Header";
    } else if (!heroAssigned) {
      heroAssigned = true;
      name = "HeroSection";
    } else if (recipeName) {
      name = recipeName;
    } else {
      const slug = slugWords(titleText(sec));
      name = slug ? `${slug}Section` : `Section${i + 1}`;
    }
    roots.set(sec.id, dedupe(identName(name)));
  });
  return { roots };
}
