/**
 * Page structural signature — the deterministic fingerprint used to confirm that
 * a URL-template family really is one template before collapsing it (Stage-3
 * route-reproduction policy, step 2). Two pages of the same template share a DOM
 * skeleton; distinct pages that merely share a URL prefix do not.
 *
 * The signature is a bag of parent→child tag bigrams over the visible IR (the IR
 * already drops text and class, so this is purely structural). Similarity is the
 * cosine of the two count vectors — robust to length differences (a long blog post
 * vs a short one have the same *distribution* of tag transitions, different
 * magnitude), so it isolates template identity from content volume. This is the
 * page-level precursor to the subtree signatures used for component dedup (M4).
 */
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

export type PageSignature = Map<string, number>;

/** Bag of `parentTag>childTag` bigrams over visible element nodes. */
export function pageSignature(ir: IR): PageSignature {
  const bag = new Map<string, number>();
  const bump = (k: string) => bag.set(k, (bag.get(k) ?? 0) + 1);
  const anyVisible = (n: IRNode): boolean => Object.values(n.visibleByVp).some(Boolean);
  const walk = (node: IRNode): void => {
    for (const c of node.children) {
      if (isTextChild(c)) continue;
      if (anyVisible(c)) bump(`${node.tag}>${c.tag}`);
      walk(c);
    }
  };
  // Seed with the root tag so single-node pages still differ by type.
  bump(`:root>${ir.root.tag}`);
  walk(ir.root);
  return bag;
}

export function cosineSimilarity(a: PageSignature, b: PageSignature): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return na === nb ? 1 : 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Default confirmation threshold: same-template pages reliably exceed this; pages
 *  that merely share a URL prefix (a listing vs a detail, two unrelated sections)
 *  fall below it. Conservative — on a near-miss we keep routes distinct (fidelity). */
export const SIMILARITY_THRESHOLD = 0.8;

export function structurallySimilar(a: IR, b: IR, threshold = SIMILARITY_THRESHOLD): { similar: boolean; score: number } {
  const score = cosineSimilarity(pageSignature(a), pageSignature(b));
  return { similar: score >= threshold, score };
}
