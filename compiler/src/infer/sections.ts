import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { round } from "../util/canonical.js";

/**
 * Deterministic section detection. Splits the page into visually coherent
 * top-level bands using semantic tags and geometry (we do not rely on class
 * names — those are intentionally dropped from the IR).
 *
 * The core is a recursive descent: a container that covers most of the page
 * (<body> → <div id=root> → <main>) is a WRAPPER, not a band — descend into it
 * and re-collect among its children, repeating until every candidate is
 * band-like. A descent only replaces the container when its children actually
 * tile it (stacked full-width blocks with near-complete coverage), so a page
 * that truly is one tall band legally stays a single section.
 *
 * Sections are metadata: stable ids + per-viewport bboxes for the layout/section
 * gate, and the shared root set for section-per-file emission (sectionSplit).
 * Role guesses are advisory and never affect fidelity.
 */

export type Section = {
  id: string; // section-001
  nodeId: string;
  role: string;
  order: number;
  bboxByVp: Record<number, { x: number; y: number; width: number; height: number }>;
};

const SEMANTIC = new Set(["header", "nav", "main", "section", "article", "footer", "aside"]);
const MIN_BAND_H = 64;
const MIN_SEMANTIC_H = 24; // a 62px navbar is still the navbar
const MIN_BAND_W_FRAC = 0.55; // a band spans most of the viewport
const WRAPPER_FRAC = 0.5; // taller than this fraction of the page → wrapper, try descending
const MIN_CHILD_COVERAGE = 0.8; // children must tile the container to replace it
const MAX_STACK_OVERLAP = 0.3; // consecutive bands may overlap at most this much of the smaller
const MAX_BANDS_PER_SPLIT = 20; // a split into more pieces than this is fragmentation, not bands
const MAX_DEPTH = 12;

type Cand = { node: IRNode; y: number; width: number; height: number };
type Ctx = { cw: number; pageH: number };

/** The ordered section-root nodes of the page (top to bottom). Shared by the
 *  validator (detectSections) and the generator's section splitter, so the gate's
 *  section list and the emitted section components describe the same bands.
 *  Falls back to `[ir.root]` when the page has no decomposable structure. */
export function detectSectionNodes(ir: IR): IRNode[] {
  const cw = ir.doc.canonicalViewport;
  const ctx: Ctx = { cw, pageH: ir.doc.perViewport[cw]?.scrollHeight ?? 0 };
  const bands = bandsOf(ir.root, 0, ctx);
  // Stable sort by top edge; ties keep document order (a fixed nav stays before
  // the hero it overlays).
  bands.sort((a, b) => a.y - b.y);
  // Nested wrappers can repeat the same box from disjoint subtrees — keep the first.
  const final: Cand[] = [];
  for (const c of bands) {
    if (!final.some((f) => Math.abs(f.y - c.y) < 4 && Math.abs(f.height - c.height) < 4)) final.push(c);
  }
  if (final.length === 0) return [ir.root];
  return final.map((c) => c.node);
}

export function detectSections(ir: IR): Section[] {
  const cw = ir.doc.canonicalViewport;
  const pageH = ir.doc.perViewport[cw]?.scrollHeight ?? 0;
  const nodes = detectSectionNodes(ir);
  const roles = guessRoles(nodes, cw, pageH);
  return nodes.map((node, i) => ({
    id: `section-${String(i + 1).padStart(3, "0")}`,
    nodeId: node.id,
    role: roles[i]!,
    order: i,
    bboxByVp: bboxesFor(node),
  }));
}

/** Landmark evidence that a bar is site chrome: an ARIA landmark role on the node
 *  itself, or a <nav> within a shallow wrapper chain. Lets a thin fixed bar (often a
 *  62px styled <div> around the real <nav>) clear the semantic height bar. */
export function navEvidence(node: IRNode): boolean {
  const role = node.attrs.role ?? "";
  if (role === "banner" || role === "navigation") return true;
  return subtreeHas(node, (n) => n.tag === "nav" || n.attrs.role === "navigation", 3);
}

function candOf(node: IRNode, ctx: Ctx): Cand | null {
  const bbox = node.bboxByVp[ctx.cw];
  if (!bbox || !node.visibleByVp[ctx.cw]) return null;
  const display = node.computedByVp[ctx.cw]?.display ?? "";
  if (/^(inline|inline-block|none)$/.test(display)) return null;
  if (bbox.width < ctx.cw * MIN_BAND_W_FRAC) return null;
  const minH = SEMANTIC.has(node.tag) || navEvidence(node) ? MIN_SEMANTIC_H : MIN_BAND_H;
  if (bbox.height < minH) return null;
  return { node, y: bbox.y, width: bbox.width, height: bbox.height };
}

/** Collect the band candidates among `container`'s children. A band-sized child is
 *  kept; a page-covering child is descended into (its children replace it only when
 *  they tile it — see acceptSplit); anything else is a transparent wrapper we look
 *  through. Output is in document order. */
function bandsOf(container: IRNode, depth: number, ctx: Ctx): Cand[] {
  if (depth > MAX_DEPTH) return [];
  const out: Cand[] = [];
  for (const child of container.children) {
    if (isTextChild(child)) continue;
    const cand = candOf(child, ctx);
    if (!cand) {
      out.push(...bandsOf(child, depth + 1, ctx));
      continue;
    }
    if (ctx.pageH > 0 && cand.height > ctx.pageH * WRAPPER_FRAC) {
      const inner = bandsOf(child, depth + 1, ctx);
      if (acceptSplit(inner, cand)) {
        out.push(...inner);
        continue;
      }
    }
    out.push(cand);
  }
  return out;
}

/** May `inner` replace its containing candidate? Only when it reads as a stack of
 *  bands: at least two, not a fragmentation explosion, vertically stacked (side-by-side
 *  columns or overlaid layers must not be split), and tiling the container with
 *  near-complete coverage so no substantial content is silently dropped. */
function acceptSplit(inner: Cand[], parent: Cand): boolean {
  if (inner.length < 2 || inner.length > MAX_BANDS_PER_SPLIT) return false;
  const sorted = inner.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!;
    const overlap = prev.y + prev.height - cur.y;
    if (overlap > Math.min(prev.height, cur.height) * MAX_STACK_OVERLAP) return false;
  }
  let covered = 0, cursor = -Infinity;
  for (const c of sorted) {
    const top = Math.max(c.y, cursor), bot = c.y + c.height;
    if (bot > top) covered += bot - top;
    cursor = Math.max(cursor, bot);
  }
  return covered >= parent.height * MIN_CHILD_COVERAGE;
}

function subtreeHas(node: IRNode, pred: (n: IRNode) => boolean, depth = 6): boolean {
  if (depth < 0) return false;
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    if (pred(c) || subtreeHas(c, pred, depth - 1)) return true;
  }
  return false;
}

/** A <header> that carries the page's h1 and real height is the hero band, not
 *  site chrome — "header → chrome" only holds for the thin bar variant. */
export function heroLikeHeader(node: IRNode, cw: number): boolean {
  const h = node.bboxByVp[cw]?.height ?? 0;
  return h >= 200 && subtreeHas(node, (n) => n.tag === "h1");
}

/** Advisory roles, one pass top-to-bottom: tag evidence first, then the first
 *  near-top content band claims "hero" (once), then content evidence. */
function guessRoles(nodes: IRNode[], cw: number, pageH: number): string[] {
  let heroClaimed = false;
  return nodes.map((node, index) => {
    if (node.tag === "nav") return "navbar";
    if (node.tag === "header") {
      if (!heroLikeHeader(node, cw)) return "header";
      heroClaimed = true;
      return "hero";
    }
    if (node.tag === "footer") return "footer";
    if (node.tag === "aside") return "aside";
    if (node.tag === "main") return "main";
    const bbox = node.bboxByVp[cw];
    const h = bbox?.height ?? 0, y = bbox?.y ?? 0;
    // thin top bar without the <nav> tag (first band, or a fixed bar with landmark evidence)
    if (h <= 140 && y <= 160 && (index === 0 || navEvidence(node))) return "navbar";
    if (!heroClaimed && (bbox?.y ?? 0) <= Math.max(900, pageH * 0.25)) {
      heroClaimed = true;
      return "hero";
    }
    if (index === nodes.length - 1) return "footer";
    if (subtreeHas(node, (n) => n.tag === "form")) return "contact";
    if (subtreeHas(node, (n) => n.tag === "video" || n.tag === "iframe")) return "media";
    return "section";
  });
}

function bboxesFor(node: IRNode): Section["bboxByVp"] {
  const out: Section["bboxByVp"] = {};
  for (const [vp, b] of Object.entries(node.bboxByVp)) {
    out[Number(vp)] = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
  }
  return out;
}
