// TEMP diagnostic (untracked): audit the width sizing-probe verdict.
// How often does sizingVerdict() return null despite wAuto holding at SOME (not all) painted vps?
// That's the "drop at the painted vps, band the dissenter" opportunity. Also reports whether the
// node currently emits a baked px width (an arbitrary w-[..] in the output would be the symptom).
// Usage: npx tsx src/runner/auditProbe.ts <site>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] || "sample";
const ir = JSON.parse(readFileSync(join("output", site, ".clone", "source", "normalized-dom", "ir.json"), "utf8"));
const VPS: number[] = ir.doc?.sampleViewports || ir.doc?.viewports || [375, 768, 1280, 1920];
const REPLACED = new Set(["img", "svg", "video", "canvas", "iframe", "input", "picture", "image", "object", "embed"]);

let probed = 0;            // nodes with any sizing data
let unanimousAuto = 0;     // sizingVerdict -> "auto" today
let unanimousFill = 0;     // -> "fill" today
let mixedAutoNull = 0;     // wAuto at >=1 but <n vps, not all-fill -> null today (the opportunity)
let neither = 0;
const examples: string[] = [];

function walk(node: any) {
  if (node?.tag && node.computedByVp && node.sizingByVp) {
    if (!REPLACED.has(node.tag) && !node.tag.includes("-")) {
      let n = 0, autoC = 0, fillC = 0;
      const pat: string[] = [];
      for (const vp of VPS) {
        const s = node.sizingByVp[vp];
        if (!s) { pat.push(`${vp}:-`); continue; }
        n++; if (s.wAuto) autoC++; if (s.wFill) fillC++;
        pat.push(`${vp}:${s.wAuto ? "A" : ""}${s.wFill ? "F" : ""}${!s.wAuto && !s.wFill ? "x" : ""}`);
      }
      if (n > 0) {
        probed++;
        const allAuto = autoC === n, allFill = fillC === n;
        if (allAuto) unanimousAuto++;
        else if (allFill) unanimousFill++;
        else if (autoC >= 1) {
          mixedAutoNull++;
          // does it carry a per-vp width that VARIES (would otherwise bake a band)?
          const widths = VPS.map((vp) => node.computedByVp[vp]?.width).filter(Boolean);
          const wset = new Set(widths.map((w: string) => Math.round(parseFloat(w))));
          if (examples.length < 16) examples.push(`#${node.id} <${node.tag}> autoC=${autoC}/${n} [${pat.join(" ")}] width@vps={${[...wset].join(",")}}`);
        } else neither++;
      }
    }
  }
  if (node?.children) for (const c of node.children) if (c?.tag) walk(c);
}
walk(ir.root || ir.doc?.root || ir);

console.log(`SITE=${site}  VPS=${VPS}`);
console.log(`probed nodes (have sizing data): ${probed}`);
console.log(`  unanimous wAuto -> "auto" today: ${unanimousAuto}`);
console.log(`  unanimous wFill -> "fill" today: ${unanimousFill}`);
console.log(`  MIXED wAuto (>=1 but <n), not all-fill -> NULL today (opportunity): ${mixedAutoNull}`);
console.log(`  never wAuto/Fill: ${neither}`);
console.log(`--- mixed examples (A=wAuto F=wFill x=neither -=no-data) ---`);
for (const e of examples) console.log(e);
