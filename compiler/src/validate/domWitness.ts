import { join } from "node:path";
import { readJSON, fileExists } from "../util/fsx.js";
import type { IR } from "../normalize/ir.js";
import type { PageSnapshot } from "../capture/walker.js";
import type { GateResult } from "../validate/gates.js";
import { collectSrcNodes, normText } from "./gateHelpers.js";
import { indexByCid } from "./render.js";

/** Gate 3b: frozen live-witness DOM (capture-time) vs IR — capture drift check. */
export function gate3bIrVsWitness(ir: IR, sourceDir: string, viewports: number[]): GateResult {
  const issues: string[] = [];
  let checked = 0;
  let matched = 0;

  for (const vp of viewports) {
    const witnessDom = join(sourceDir, "evidence", "live-witness", String(vp), "dom.json");
    const captureDom = join(sourceDir, "capture", `dom-${vp}.json`);
    const domPath = fileExists(witnessDom) ? witnessDom : captureDom;
    if (!fileExists(domPath)) {
      issues.push(`vp${vp} missing witness/capture dom`);
      continue;
    }
    const snap = readJSON<PageSnapshot>(domPath);
    const gen = indexByCid(snap);
    const srcNodes = collectSrcNodes(ir, vp);
    for (const s of srcNodes) {
      if (!s.visible) continue;
      checked++;
      const g = gen.get(s.node.id);
      if (g && (g.tag === s.node.tag)) matched++;
    }
  }

  const matchPct = checked ? matched / checked : 1;
  if (matchPct < 0.98) issues.push(`IR vs witness node match ${(matchPct * 100).toFixed(1)}% (< 98%)`);

  return {
    gate: "dom_witness",
    pass: issues.length === 0,
    metrics: { checked, matched, matchPct: Math.round(matchPct * 10000) / 10000 },
    issues,
  };
}

/** Gate 3c: built clone vs frozen live-witness — end-user fidelity. */
export function gate3cCloneVsWitness(
  genSnaps: Record<number, PageSnapshot>,
  sourceDir: string,
  viewports: number[],
): GateResult {
  const issues: string[] = [];
  let textTotal = 0;
  let textPresent = 0;

  for (const vp of viewports) {
    const witnessDom = join(sourceDir, "evidence", "live-witness", String(vp), "dom.json");
    const captureDom = join(sourceDir, "capture", `dom-${vp}.json`);
    const domPath = fileExists(witnessDom) ? witnessDom : captureDom;
    if (!fileExists(domPath)) {
      issues.push(`vp${vp} missing witness dom`);
      continue;
    }
    const witness = readJSON<PageSnapshot>(domPath);
    const wByCid = indexByCid(witness);
    const gen = genSnaps[vp] ? indexByCid(genSnaps[vp]!) : new Map();
    const witnessText = normText([...wByCid.values()].filter((n) => n.visible).map((n) => n.text).join(" "));
    const genText = normText([...gen.values()].filter((n) => n.visible).map((n) => n.text).join(" "));

    for (const w of wByCid.values()) {
      if (!w.visible) continue;
      const t = normText(w.text);
      if (t.length < 4) continue;
      textTotal++;
      if (genText.includes(t)) textPresent++;
    }
    if (Math.abs(witness.doc.scrollHeight - (genSnaps[vp]?.doc.scrollHeight ?? 0)) / Math.max(witness.doc.scrollHeight, 1) > 0.08) {
      issues.push(`vp${vp} scrollHeight drift witness=${witness.doc.scrollHeight} clone=${genSnaps[vp]?.doc.scrollHeight ?? 0}`);
    }
  }

  const textPct = textTotal ? textPresent / textTotal : 1;
  if (textPct < 0.995) issues.push(`clone vs witness text ${(textPct * 100).toFixed(1)}%`);

  return {
    gate: "dom_clone_witness",
    pass: issues.length === 0,
    metrics: { textTotal, textPresent, textPct: Math.round(textPct * 10000) / 10000 },
    issues,
  };
}
