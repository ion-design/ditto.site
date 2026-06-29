/**
 * Fast dev loop: regenerate a run's app from its EXISTING capture (no browser), then
 * print the output-quality score. Lets us iterate on the generator and immediately see
 * the quality delta without re-capturing. Pair with `validate-one <runDir>` to confirm
 * fidelity gates haven't regressed.
 *
 *   npm run regen -- <runDir> [--components] [--no-components] [--no-publish]
 *
 * Component extraction is read from the run's clone-options.json (as the deliverable
 * does); pass --components / --no-components to override for this regen. By default the
 * freshly-generated app is also PUBLISHED to the sibling deliverable `app/` (copy + strip
 * data-cids, exactly as a full clone does) so the shipped tree never goes stale behind the
 * validation build; pass --no-publish to refresh only the validation `generated/` tree.
 */
import { join, resolve } from "node:path";
import { generateAll } from "../generate/pipeline.js";
import { exportApp } from "../cli.js";
import { scoreApp } from "./qualityScore.js";
import { readJSON, writeJSON, fileExists } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runDir = resolve(args.find((a) => !a.startsWith("--")) ?? "");
  if (!runDir) { console.error("usage: regen <runDir> [--components|--no-components]"); process.exit(1); }
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const input = readJSON<{ url: string; viewports: number[] }>(join(runDir, "input.json"));
  const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));

  const optPath = join(sourceDir, "clone-options.json");
  // Preserve any persisted reflow/humanizeMode when toggling components, so a component
  // override never silently drops the run's reflow decision.
  const prevOpts = fileExists(optPath) ? readJSON<{ components?: boolean; humanizeMode?: "tailwind" | "css"; reflow?: boolean }>(optPath) : {};
  if (args.includes("--components")) writeJSON(optPath, { ...prevOpts, components: true });
  else if (args.includes("--no-components")) writeJSON(optPath, { ...prevOpts, components: false });
  else if (!fileExists(optPath)) writeJSON(optPath, { components: true });

  const t0 = Date.now();
  const gen = generateAll({ sourceDir, capture, viewports: input.viewports, sampleViewports: capture.viewports, url: input.url, outDir: generatedDir });
  const ms = Date.now() - t0;

  // Publish the deliverable (copy generated → sibling app/, strip per-node data-cid) unless opted out,
  // so the shipped tree a developer reads is never stale behind the validation build.
  let published: { removed: number; kept: number } | undefined;
  if (!args.includes("--no-publish")) published = exportApp(join(generatedDir, "app"), resolve(runDir, "..", "app"));

  const rep = scoreApp(join(generatedDir, "app"));
  console.log(JSON.stringify({
    event: "regen_done",
    ms,
    quality: rep.total,
    categories: Object.fromEntries(Object.entries(rep.categories).map(([k, v]) => [k, v.score])),
    recipes: {
      total: gen.recipeReport.summary.totalCandidates,
      highConfidence: gen.recipeReport.summary.highConfidence,
      byKind: gen.recipeReport.summary.byKind,
    },
    interactionRecipes: {
      total: gen.interactionRecipeReport.summary.totalCandidates,
      highConfidence: gen.interactionRecipeReport.summary.highConfidence,
      byKind: gen.interactionRecipeReport.summary.byKind,
      semanticRuntime: gen.interactionRecipeReport.summary.semanticRuntime,
    },
    ...(published ? { published } : {}),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
