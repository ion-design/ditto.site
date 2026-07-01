// TEMP diagnostic (untracked): for LOAD-BEARING widths that VARY across viewports (the snapping
// set), dump per-vp {actual width, container content width, wMin, wMax, ratio} so a fluid width LAW
// (%/clamp/flex/auto) can be designed from real intrinsic-size data.
// Usage: npx tsx src/runner/inspectWidthLaw.ts <site> [maxRows]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] || "ridge";
const maxRows = Number(process.argv[3] || 24);
const ir = JSON.parse(readFileSync(join("output", site, ".clone", "source", "normalized-dom", "ir.json"), "utf8"));
const VPS: number[] = ir.doc?.sampleViewports || ir.doc?.viewports || [375, 768, 1280, 1920];
const REPLACED = new Set(["img", "svg", "video", "canvas", "iframe", "input", "picture", "image", "object", "embed", "textarea", "select"]);
const pf = (v?: string) => { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : NaN; };

let probeHasMinMax = 0, probeTotal = 0;
const rows: string[] = [];

function contentW(parent: any, vp: number): number {
  const pcs = parent?.computedByVp?.[vp]; const pb = parent?.bboxByVp?.[vp];
  if (!pcs || !pb) return NaN;
  return pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
}

const visibleAt = (node: any, vp: number): boolean => {
  const cs = node.computedByVp?.[vp]; const bb = node.bboxByVp?.[vp];
  return !!(cs && bb && node.visibleByVp?.[vp] && (cs.display || "") !== "none" && bb.width > 0);
};

function walk(node: any, parent: any) {
  if (node?.tag && node.computedByVp && !REPLACED.has(node.tag) && !node.tag.includes("-")) {
    const s = node.sizingByVp;
    if (s) {
      for (const vp of VPS) { if (s[vp]) { probeTotal++; if (s[vp].wMin != null) probeHasMinMax++; break; } }
    }
    // Load-bearing varying width, judged ONLY at viewports where the node actually paints (bbox px,
    // not the computed string — "100%" must not read as 100px). Never wAuto/wFill at those vps.
    const vis = VPS.filter((vp) => visibleAt(node, vp));
    const ws = vis.map((vp) => node.bboxByVp[vp].width);
    let loadBearing = !!s;
    if (s) for (const vp of vis) { const f = s[vp]; if (f && (f.wAuto || f.wFill)) loadBearing = false; }
    if (loadBearing && vis.length >= 2 && Math.max(...ws) - Math.min(...ws) > 8 && rows.length < maxRows) {
      const cells = vis.map((vp) => {
        const w = node.bboxByVp[vp].width;
        const cw = contentW(parent, vp);
        const f = s?.[vp];
        const ratio = Number.isFinite(cw) && cw > 0 ? (w / cw).toFixed(3) : "?";
        return `${vp}:w=${Math.round(w)} cw=${Number.isFinite(cw) ? Math.round(cw) : "-"} r=${ratio} min=${f?.wMin ?? "-"} max=${f?.wMax ?? "-"}`;
      });
      const disp = vis.map((vp) => `${vp}:${node.computedByVp[vp]?.display}`).join(" ");
      rows.push(`#${node.id} <${node.tag}> ${disp}\n   ${cells.join("\n   ")}`);
    }
  }
  if (node?.children) for (const c of node.children) if (c?.tag) walk(c, node);
}
walk(ir.root || ir.doc?.root || ir, null);

console.log(`SITE=${site} VPS=${VPS}`);
console.log(`probe coverage: ${probeHasMinMax}/${probeTotal} probed nodes have wMin/wMax (0 ⇒ capture predates Probe 3)`);
console.log(`--- load-bearing varying-width candidates (the snapping set) ---`);
for (const r of rows) console.log(r);
