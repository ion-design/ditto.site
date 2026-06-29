// TEMP diagnostic (untracked): for grid nodes with multi-track px rows, report each in-flow element
// child's hAuto (does its content fill the row, or is it stretched taller?).
// Usage: npx tsx src/runner/inspectRows.ts <site>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] || "sample";
const ir = JSON.parse(readFileSync(join("output", site, ".clone", "source", "normalized-dom", "ir.json"), "utf8"));
const VPS = ir.doc?.sampleViewports || ir.doc?.viewports || [375, 768, 1280, 1920];
const parseTracks = (v?: string): number[] | null => {
  if (!v || v === "none" || /subgrid/.test(v)) return null;
  const toks = v.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const t of toks) { if (!/^-?\d+(?:\.\d+)?px$/.test(t)) return null; out.push(parseFloat(t)); }
  return out.length ? out : null;
};
const REPLACED = new Set(["img", "svg", "video", "canvas", "iframe", "input", "picture", "image"]);

function walk(node: any) {
  if (node?.tag && node.computedByVp) {
    for (const vp of VPS) {
      const cs = node.computedByVp[vp];
      const tr = parseTracks(cs?.gridTemplateRows);
      if (!tr || tr.length < 2) continue;
      const equal = Math.max(...tr) - Math.min(...tr) <= Math.max(1.5, 0.02 * Math.max(...tr));
      if (!equal) continue;
      const kids = (node.children || []).filter((c: any) => c?.tag && !REPLACED.has(c.tag) && c.computedByVp?.[vp] && c.visibleByVp?.[vp] && (c.computedByVp[vp].display || "") !== "none" && !/^(absolute|fixed)$/.test(c.computedByVp[vp].position || "static"));
      const hAutos = kids.map((c: any) => c.sizingByVp?.[vp]?.hAuto);
      console.log(`#${node.id} <${node.tag}> vp${vp} rows=[${tr.map((x) => Math.round(x)).join(",")}] kids=${kids.length} hAuto=[${hAutos.join(",")}]`);
      break; // one line per node
    }
  }
  if (node?.children) for (const c of node.children) if (c?.tag) walk(c);
}
walk(ir.root || ir.doc?.root || ir);
