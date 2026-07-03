import { join } from "node:path";
import { readJSON, fileExists } from "../util/fsx.js";
import type { IR } from "../normalize/ir.js";
import type { PageSnapshot, RawNode, RawChild } from "../capture/walker.js";
import type { GateResult } from "../validate/gates.js";
import { collectSrcNodes, normText } from "./gateHelpers.js";
import { indexByCid } from "./render.js";

/** Visible per-tag counts + visible direct-text corpus from a raw capture/render
 *  snapshot tree. Live-page snapshots carry no data-cid identity, so witness
 *  comparisons work on tag counts and text presence rather than per-cid lookups. */
function collectVisible(root: RawNode): { tags: Map<string, number>; texts: string[]; corpus: string } {
  const tags = new Map<string, number>();
  const texts: string[] = [];
  const parts: string[] = [];
  const walk = (n: RawNode): void => {
    if (n.visible) {
      tags.set(n.tag, (tags.get(n.tag) ?? 0) + 1);
      let direct = "";
      for (const c of n.children) if ((c as { text?: string }).text !== undefined) direct += (c as { text: string }).text;
      const t = normText(direct);
      if (t) { texts.push(t); parts.push(t); }
    }
    for (const c of n.children) if ((c as RawNode).tag !== undefined) walk(c as RawNode);
  };
  walk(root);
  return { tags, texts, corpus: parts.join(" ") };
}

function captureDomPath(sourceDir: string, vp: number): string {
  // The live witness stores page.html + screenshot only (no walker dump), so the
  // frozen walker snapshot the IR was built from is the witness DOM.
  const witnessDom = join(sourceDir, "evidence", "live-witness", String(vp), "dom.json");
  return fileExists(witnessDom) ? witnessDom : join(sourceDir, "capture", `dom-${vp}.json`);
}

/** Gate 3b: IR vs the canonical capture snapshot — capture-drift check. The IR's
 *  structure comes from the canonical viewport's walker snapshot, so every visible
 *  IR node's tag must be accounted for by the snapshot's visible tag counts and
 *  visible IR text must exist in the snapshot corpus. (Per-cid lookup is impossible:
 *  live pages carry no data-cid, and IR ids are renumbered after pruning.) */
export function gate3bIrVsWitness(ir: IR, sourceDir: string, viewports: number[]): GateResult {
  const issues: string[] = [];
  const vp = viewports.includes(ir.doc.canonicalViewport) ? ir.doc.canonicalViewport : viewports[viewports.length - 1]!;
  const domPath = captureDomPath(sourceDir, vp);
  if (!fileExists(domPath)) {
    return { gate: "dom_witness", pass: false, metrics: { checked: 0 }, issues: [`vp${vp} missing witness/capture dom`] };
  }
  const snap = readJSON<PageSnapshot>(domPath);
  const raw = collectVisible(snap.root as RawNode);

  let checked = 0;
  let matched = 0;
  let textTotal = 0;
  let textPresent = 0;
  const budget = new Map(raw.tags);
  for (const s of collectSrcNodes(ir, vp)) {
    if (!s.visible) continue;
    checked++;
    const left = budget.get(s.node.tag) ?? 0;
    if (left > 0) { budget.set(s.node.tag, left - 1); matched++; }
    const t = normText(s.directText);
    if (t.length >= 4) {
      textTotal++;
      if (raw.corpus.includes(t)) textPresent++;
    }
  }

  const matchPct = checked ? matched / checked : 1;
  const textPct = textTotal ? textPresent / textTotal : 1;
  if (matchPct < 0.98) issues.push(`IR vs witness node match ${(matchPct * 100).toFixed(1)}% (< 98%)`);
  if (textPct < 0.995) issues.push(`IR vs witness text ${(textPct * 100).toFixed(1)}% (< 99.5%)`);

  return {
    gate: "dom_witness",
    pass: issues.length === 0,
    metrics: {
      checked, matched, matchPct: Math.round(matchPct * 10000) / 10000,
      textTotal, textPresent, textPct: Math.round(textPct * 10000) / 10000, viewport: vp,
    },
    issues,
  };
}

/** Gate 3c: built clone vs frozen witness snapshot — end-user fidelity. Every
 *  visible witness text run must appear in the rendered clone's visible text, and
 *  page heights must agree within 8%. */
export function gate3cCloneVsWitness(
  genSnaps: Record<number, PageSnapshot>,
  sourceDir: string,
  viewports: number[],
): GateResult {
  const issues: string[] = [];
  let textTotal = 0;
  let textPresent = 0;

  for (const vp of viewports) {
    const domPath = captureDomPath(sourceDir, vp);
    if (!fileExists(domPath)) {
      issues.push(`vp${vp} missing witness dom`);
      continue;
    }
    const gen = genSnaps[vp];
    if (!gen) continue;
    const witness = readJSON<PageSnapshot>(domPath);
    const w = collectVisible(witness.root as RawNode);
    // The rendered clone snapshot carries data-cid identity; its text corpus is the
    // same either way, so reuse the cid index the other gates already build.
    const genText = normText([...indexByCid(gen).values()].filter((n) => n.visible).map((n) => n.text).join(" "));

    for (const t of w.texts) {
      if (t.length < 4) continue;
      textTotal++;
      if (genText.includes(t)) textPresent++;
    }
    if (Math.abs(witness.doc.scrollHeight - gen.doc.scrollHeight) / Math.max(witness.doc.scrollHeight, 1) > 0.08) {
      issues.push(`vp${vp} scrollHeight drift witness=${witness.doc.scrollHeight} clone=${gen.doc.scrollHeight}`);
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
