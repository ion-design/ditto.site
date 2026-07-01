import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { round } from "../util/canonical.js";

/**
 * Deterministic section detection. Splits the page into visually coherent
 * top-level blocks using semantic tags and geometry (we do not rely on class
 * names — those are intentionally dropped from the IR). Sections are metadata:
 * stable ids + per-viewport bboxes for the layout/section gate. Role guesses are
 * advisory and never affect fidelity.
 */

export type Section = {
  id: string; // section-001
  nodeId: string;
  role: string;
  order: number;
  bboxByVp: Record<number, { x: number; y: number; width: number; height: number }>;
};

const SEMANTIC = new Set(["header", "nav", "main", "section", "article", "footer", "aside"]);

type Cand = { node: IRNode; path: string; y: number; width: number; height: number };

export function detectSections(ir: IR): Section[] {
  const cw = ir.doc.canonicalViewport;
  const vpWidth = cw;

  const candidates: Cand[] = [];
  const walk = (node: IRNode, path: string): void => {
    const bbox = node.bboxByVp[cw];
    const visible = node.visibleByVp[cw];
    if (bbox && visible) {
      const isSemantic = SEMANTIC.has(node.tag);
      const isBigBlock = bbox.width >= vpWidth * 0.55 && bbox.height >= 64;
      const display = node.computedByVp[cw]?.display ?? "";
      const blockish = !/^(inline|inline-block|none)$/.test(display);
      if ((isSemantic || isBigBlock) && blockish) {
        candidates.push({ node, path, y: bbox.y, width: bbox.width, height: bbox.height });
      }
    }
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      walk(c, `${path}/${c.id}`);
    }
  };
  walk(ir.root, ir.root.id);

  // Outermost wins: drop candidates nested inside another candidate.
  const byShallow = candidates.slice().sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  let kept: Cand[] = [];
  for (const c of byShallow) {
    if (kept.some((k) => c.path.startsWith(k.path + "/"))) continue;
    kept.push(c);
  }

  // If the only survivor is a giant wrapper, expand into its section-like children.
  const pageHeight = ir.doc.perViewport[cw]?.scrollHeight ?? 0;
  kept = expandOversized(kept, vpWidth, pageHeight, cw);

  // Sort by Y, then assign ids/roles.
  kept.sort((a, b) => a.y - b.y || b.height - a.height);
  // Deduplicate near-identical y/height wrappers (keep the first/shallowest).
  const final: Cand[] = [];
  for (const c of kept) {
    const dup = final.find((f) => Math.abs(f.y - c.y) < 4 && Math.abs(f.height - c.height) < 4);
    if (!dup) final.push(c);
  }

  return final.map((c, i) => ({
    id: `section-${String(i + 1).padStart(3, "0")}`,
    nodeId: c.node.id,
    role: guessRole(c.node, i, final.length),
    order: i,
    bboxByVp: bboxesFor(c.node),
  }));
}

function expandOversized(cands: Cand[], vpWidth: number, pageHeight: number, cw: number): Cand[] {
  if (cands.length > 2) return cands;
  const threshold = Math.max(pageHeight * 0.55, 1200);
  const out: Cand[] = [];
  for (const c of cands) {
    if (c.height < threshold) { out.push(c); continue; }
    const inner: Cand[] = [];
    const collect = (node: IRNode, path: string, depth: number): void => {
      if (depth > 6) return;
      for (const ch of node.children) {
        if (isTextChild(ch)) continue;
        const bbox = ch.bboxByVp[cw];
        if (bbox && ch.visibleByVp[cw] && bbox.width >= vpWidth * 0.5 && bbox.height >= 64) {
          inner.push({ node: ch, path: `${path}/${ch.id}`, y: bbox.y, width: bbox.width, height: bbox.height });
        } else {
          collect(ch, `${path}/${ch.id}`, depth + 1);
        }
      }
    };
    collect(c.node, c.path, 0);
    // outermost wins within inner
    const byShallow = inner.slice().sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    const keptInner: Cand[] = [];
    for (const ic of byShallow) {
      if (keptInner.some((k) => ic.path.startsWith(k.path + "/"))) continue;
      keptInner.push(ic);
    }
    if (keptInner.length >= 3) out.push(...keptInner);
    else out.push(c);
  }
  return out;
}

function guessRole(node: IRNode, index: number, total: number): string {
  if (node.tag === "header") return "header";
  if (node.tag === "nav") return "nav";
  if (node.tag === "footer") return "footer";
  if (node.tag === "main") return "main";
  if (index === 0) return "hero";
  if (index === total - 1) return "footer";
  return "section";
}

function bboxesFor(node: IRNode): Section["bboxByVp"] {
  const out: Section["bboxByVp"] = {};
  for (const [vp, b] of Object.entries(node.bboxByVp)) {
    out[Number(vp)] = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
  }
  return out;
}
