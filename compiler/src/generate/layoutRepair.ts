import { join } from "node:path";
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { PageSnapshot } from "../capture/walker.js";
import { indexByCid } from "../validate/render.js";
import { collectSrcNodes } from "../validate/gateHelpers.js";
import { readJSON, writeJSON, fileExists } from "../util/fsx.js";

export type LayoutRepairHints = { forceCenterCids: string[] };

const REPAIR_FILE = "layout-repair.json";

export function layoutRepairPath(sourceDir: string): string {
  return join(sourceDir, REPAIR_FILE);
}

export function readLayoutRepairHints(sourceDir: string): LayoutRepairHints | undefined {
  const p = layoutRepairPath(sourceDir);
  if (!fileExists(p)) return undefined;
  return readJSON<LayoutRepairHints>(p);
}

export function writeLayoutRepairHints(sourceDir: string, hints: LayoutRepairHints): void {
  writeJSON(layoutRepairPath(sourceDir), hints);
}

function pf(v: string | undefined): number {
  if (!v || v === "auto") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function srcCentered(node: IRNode, parent: IRNode, vp: number): boolean {
  const cs = node.computedByVp[vp];
  const nb = node.bboxByVp[vp];
  const pcs = parent.computedByVp[vp];
  const pb = parent.bboxByVp[vp];
  if (!cs || !nb || !pcs || !pb) return false;
  if (!/^(block|flow-root|list-item|flex|grid)$/.test(cs.display || "")) return false;
  const pos = cs.position || "static";
  if (pos !== "static" && pos !== "relative") return false;
  if (/(?:^|-)(?:flex|grid)$/.test(pcs.display || "")) return false;
  const pl = pb.x + pf(pcs.paddingLeft) + pf(pcs.borderLeftWidth);
  const pr = pb.x + pb.width - pf(pcs.paddingRight) - pf(pcs.borderRightWidth);
  const gapL = nb.x - pl;
  const gapR = pr - (nb.x + nb.width);
  return gapL > 2 && gapR > 2 && Math.abs(gapL - gapR) <= 1.5 && nb.width < pr - pl - 4;
}

function hasVisibleElementChild(node: IRNode, vp: number): boolean {
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    if (c.visibleByVp[vp]) return true;
  }
  return false;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

/** When gate 5 reports a uniform horizontal drift (classic centred fixed column baked
 *  with a constant left offset), pick source-centred containers to re-emit with mx-auto. */
export function detectUniformHorizontalOffset(
  ir: IR,
  genSnaps: Record<number, PageSnapshot>,
  viewports: number[],
): LayoutRepairHints | null {
  const vp = viewports.includes(1280) ? 1280 : viewports[viewports.length - 1]!;
  const gen = indexByCid(genSnaps[vp]!);
  const dxs: number[] = [];
  for (const s of collectSrcNodes(ir, vp)) {
    if (!s.visible || hasVisibleElementChild(s.node, vp)) continue;
    const g = gen.get(s.node.id);
    if (!g) continue;
    dxs.push(g.bbox.x - s.bbox.x);
  }
  if (dxs.length < 8) return null;
  const med = median(dxs);
  if (Math.abs(med) < 16) return null;
  if (stddev(dxs) > 24) return null;
  const sign = Math.sign(med);
  const sameSign = dxs.filter((d) => Math.sign(d) === sign || Math.abs(d) < 2).length / dxs.length;
  if (sameSign < 0.75) return null;

  const parentOf = new Map<string, IRNode>();
  const walk = (n: IRNode, p: IRNode | undefined): void => {
    parentOf.set(n.id, p!);
    for (const c of n.children) if (!isTextChild(c)) walk(c, n);
  };
  walk(ir.root, undefined);

  const forceCenterCids: string[] = [];
  const visit = (n: IRNode): void => {
    const parent = parentOf.get(n.id);
    if (parent && srcCentered(n, parent, vp)) {
      const nb = n.bboxByVp[vp];
      if (nb && nb.width >= 400 && nb.width <= 900) forceCenterCids.push(n.id);
    }
    for (const c of n.children) if (!isTextChild(c)) visit(c);
  };
  visit(ir.root);
  if (!forceCenterCids.length) return null;
  forceCenterCids.sort();
  return { forceCenterCids };
}
