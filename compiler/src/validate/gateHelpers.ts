import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

export function normText(s: string): string { return s.replace(/\s+/g, " ").trim(); }

type SrcNode = { node: IRNode; computed: Record<string, string>; bbox: { x: number; y: number; width: number; height: number }; visible: boolean; directText: string };

export function collectSrcNodes(ir: IR, vp: number): SrcNode[] {
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
