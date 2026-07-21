import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { runClone, latestSourceDir, siteIdFromUrl } from "../cli.js";
import { validateRun } from "../validate/validate.js";
import type { Report } from "../validate/report.js";

/**
 * Stage 4.5 dev check: prove component extraction is render-equivalent. From ONE
 * capture, generate + validate the clone twice — without extraction (baseline) and
 * with extraction enabled — and report both scorecards plus the components that
 * were promoted. A regression is any gate that passes in the baseline but fails with
 * extraction on. Usage: `componentCheck <url> [--tier=easy]`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = resolve(HERE, "..", "..", "..", "runs");

function summarize(r: Report): { score: number; g06: boolean; failing: string[] } {
  return {
    score: r.scorecard.total,
    g06: r.gates0to6Pass,
    failing: Object.entries(r.gates).filter(([, g]) => !g.pass).map(([k]) => k),
  };
}

/** The promoted components, from the run's authoritative summary (one entry per
 *  unique component after skeleton dedup: { name, runs, instances }). */
function promotedFrom(runDir: string): Array<{ name: string; runs: number; instances: number }> {
  const p = join(runDir, "generated", "extracted-components.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) { console.error("usage: componentCheck <url> [--tier=easy]"); process.exit(1); }
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "easy";
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

  // 1. Baseline: capture + generate with extraction OFF.
  const reuse = args.includes("--reuse") ? latestSourceDir(RUNS, url) ?? undefined : undefined;
  const baseRun = await runClone({ url, runsDir: RUNS, reuseSource: reuse, components: false });
  const baseReport = await validateRun(baseRun.runDir, { tier });
  const base = summarize(baseReport);

  // 2. Extraction: reuse the SAME capture, regenerate with it ON.
  const src = latestSourceDir(RUNS, url) ?? undefined;
  const extRun = await runClone({ url, runsDir: RUNS, reuseSource: src, components: true });
  const extReport = await validateRun(extRun.runDir, { tier });
  const ext = summarize(extReport);
  const promoted = promotedFrom(extRun.runDir);

  const regressed = ext.failing.filter((g) => !base.failing.includes(g));
  log({
    event: "component_check",
    url,
    baseline: base,
    extraction: ext,
    promoted,
    promotedCount: promoted.length,
    runsExtracted: promoted.reduce((a, p) => a + p.runs, 0),
    instancesExtracted: promoted.reduce((a, p) => a + p.instances, 0),
    regressedGates: regressed,
    ok: regressed.length === 0 && ext.score >= base.score - 0.05,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
