/**
 * Tailwind end-to-end verification harness (dev-only).
 *
 *   npx tsx src/runner/verifyTw.ts <mode> <runDir...>
 *
 * For each run dir: rewrite its clone-options to the given humanizeMode (preserving
 * `components`/`reflow`), regenerate from the existing capture, then run the full validator.
 * Prints one compact line per run with the quality score + every fidelity gate's
 * pass/fail and key metric, so we can A/B "tailwind" vs "css" on the SAME capture and
 * confirm Tailwind introduces no fidelity degrade.
 */
import { join, resolve, basename } from "node:path";
import { generateAll } from "../generate/pipeline.js";
import { validateRun } from "../validate/validate.js";
import { scoreApp } from "./qualityScore.js";
import { readJSON, writeJSON } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";
import { pathToFileURL } from "node:url";

async function one(runDir: string, mode: "tailwind" | "css", tier: string) {
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const input = readJSON<{ url: string; viewports: number[] }>(join(runDir, "input.json"));
  const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
  const optPath = join(sourceDir, "clone-options.json");
  const prev = readJSON<{ components?: boolean; reflow?: boolean }>(optPath);
  writeJSON(optPath, { components: !!prev.components, humanizeMode: mode, ...(prev.reflow ? { reflow: true } : {}) });

  generateAll({ sourceDir, capture, viewports: input.viewports, sampleViewports: capture.viewports, url: input.url, outDir: generatedDir });
  const q = scoreApp(join(generatedDir, "app"));
  const rep = await validateRun(resolve(runDir), { tier, log: () => {} });

  const g = rep.gates;
  const cell = (name: string) => {
    const x = g[name];
    if (!x) return `${name}=NA`;
    return `${name}=${x.pass ? "OK" : "FAIL"}`;
  };
  const dom = g.dom?.metrics as any;
  const perc = g.perceptual?.metrics as any;
  const style = g.style?.metrics as any;
  const layout = g.layout?.metrics as any;
  return {
    site: runDir.includes("fixtures-") ? runDir.split("fixtures-")[1]!.split("-html")[0]! : basename(runDir),
    mode,
    quality: q.total,
    status: rep.status,
    gates: ["build", "style", "layout", "dom", "determinism", "perceptual", "interaction", "motion", "pollution"].map(cell).join(" "),
    detail: {
      stylePassPct: style?.passPct,
      styleTopFail: style?.topFailingProps,
      layoutWorst: layout?.worstShiftPx ?? layout?.maxDeltaPx,
      domLinkPct: dom?.linkPct,
      domNodePct: dom?.nodeMatchPct,
      percWorst: perc?.worstDiffPct,
      percPerVp: perc?.perViewport,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a === "tailwind" || a === "css") ?? "tailwind") as "tailwind" | "css";
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "medium";
  const dirs = args.filter((a) => !a.startsWith("--") && a !== "tailwind" && a !== "css");
  for (const d of dirs) {
    try {
      const r = await one(resolve(d), mode, tier);
      console.log(JSON.stringify(r));
    } catch (e) {
      console.log(JSON.stringify({ site: basename(d), mode, error: String(e).slice(0, 300) }));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
