import { join } from "node:path";
import { backfillLazyBackgrounds, buildIR, writeIR, type IR } from "../normalize/ir.js";
import { detectSections, type Section } from "../infer/sections.js";
import { extractTokens, tokensToCss, buildTokenResolver, type Tokens } from "../infer/tokens.js";
import { buildColorPalette } from "../infer/semanticTokens.js";
import { recognizePrimitives, inventoryOf } from "../infer/primitives.js";
import { buildAssetGraph, materializeAssets, type AssetGraph } from "../infer/assets.js";
import { buildFontGraph, type FontGraph } from "../infer/fonts.js";
import { buildRecipeReport, recipeReportToMarkdown, type RecipeReport } from "../infer/recipes.js";
import { buildInteractionRecipeReport, interactionRecipeReportToMarkdown, type InteractionRecipeReport } from "../infer/interactionRecipes.js";
import { generateApp, type AppFramework } from "./app.js";
import { buildCodeQualityReport, codeQualityReportToMarkdown, type CodeQualityReport } from "./codeQuality.js";
import { interactionRejectedSet } from "./interactive.js";
import { buildManifest } from "./manifest.js";
import { buildSeoInventory, seoInventoryToMarkdown, type SeoInventory } from "./seo.js";
import { resolvePatternHints, type PatternHints } from "../knowledge/patternIndex.js";
import { writeJSON, writeText, readJSON, fileExists } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";

export type GenerateAllResult = {
  ir: IR;
  sections: Section[];
  tokens: Tokens;
  assetGraph: AssetGraph;
  fontGraph: FontGraph;
  recipeReport: RecipeReport;
  interactionRecipeReport: InteractionRecipeReport;
  patternHints: PatternHints;
  seoInventory: SeoInventory;
  codeQuality: CodeQualityReport;
  manifest: Record<string, unknown>;
  assetsCopied: number;
  assetsMissing: string[];
};

/**
 * Pure deterministic generation from a frozen capture: IR → infer → generate app
 * → emit artifacts. Called by the CLI and twice by the determinism gate; given
 * the same sourceDir it must produce byte-identical output (rubric Gate 6).
 */
export function generateAll(opts: {
  sourceDir: string;
  capture: CaptureResult;
  viewports: number[];               // band/gate widths (standard breakpoints)
  sampleViewports?: number[];        // dense set for size inference (defaults to viewports)
  url: string;
  outDir: string; // the generated/ dir
  ignoreRejectedInteractions?: boolean; // validation retest mode: wire everything before pruning
}): GenerateAllResult {
  const { sourceDir, capture, viewports, url, outDir } = opts;
  const sampleViewports = opts.sampleViewports ?? viewports;
  const appDir = join(outDir, "app");

  // Stage 5: carry @keyframes only when motion capture ran (motion on by default;
  // `--no-motion` / the plain static benchmark leave `capture.motion` unset), so
  // `--no-motion` output is byte-identical to the pre-Stage-5 frozen clone. `!!capture.motion`
  // is stable across processes (persisted in capture-result.json) ⇒ determinism holds.
  const ir = buildIR(sourceDir, sampleViewports, { motion: !!capture.motion, bandViewports: viewports });
  backfillLazyBackgrounds(ir);
  writeIR(ir, sourceDir);

  const sections = detectSections(ir);
  const tokens = extractTokens(ir);
  // Pattern hints: frozen-catalog signature scan over the IR (deterministic; the
  // pin is asserted here and throws on catalog/lock drift). Fed as ADDITIVE evidence
  // into recipe recognition — never overrides captured geometry.
  const patternHints = resolvePatternHints(ir);
  const assetGraph = buildAssetGraph(capture);
  const fontGraph = buildFontGraph(capture.fontFaces, assetGraph, url);
  const seoInventory = buildSeoInventory(ir, assetGraph, capture);

  // Stage 3.5: semantic color tokens (load-bearing). The palette's :root supersedes
  // the decorative color group; ditto.css references var(--token) for colors.
  const palette = buildColorPalette(ir);
  const tokensCss = (palette.css ? palette.css + "\n" : "") + tokensToCss(tokens, true);
  const tokenResolver = buildTokenResolver(tokens);
  const primitives = recognizePrimitives(ir);
  const recipeReport = buildRecipeReport(ir, sections, primitives, patternHints);
  const interactionRecipeReport = buildInteractionRecipeReport(ir, sections, capture.interaction);
  // Patterns the interaction gate previously rejected (don't reproduce) → left static.
  const rejPath = join(sourceDir, "interaction-rejected.json");
  const rejectedSpecs = !opts.ignoreRejectedInteractions && fileExists(rejPath)
    ? interactionRejectedSet(readJSON<unknown>(rejPath))
    : undefined;
  // Stage 4.5: component extraction is opt-in, persisted in the source dir at clone
  // time so every generateAll for this run (deliverable, determinism gate, prune
  // regen) makes the SAME choice — keeping output deterministic across processes.
  const optPath = join(sourceDir, "clone-options.json");
  const cloneOpts = fileExists(optPath) ? readJSON<{ components?: boolean; humanizeMode?: "tailwind" | "css"; framework?: AppFramework; reflow?: boolean }>(optPath) : {};
  const components = !!cloneOpts.components;
  const humanizeMode = cloneOpts.humanizeMode; // undefined → generateApp default ("tailwind")
  const gen = generateApp({ ir, assetGraph, fontGraph, appDir, sourceDir, sourceUrl: url, seoInventory, colorVar: palette.varForColor, tokenResolver, primitives, recipeReport, interaction: capture.interaction, rejectedSpecs, components, humanizeMode, framework: cloneOpts.framework, motion: capture.motion, reflow: !!cloneOpts.reflow }, tokensCss);
  const mat = materializeAssets(assetGraph, sourceDir, join(appDir, "public"));

  // Stage 4.5: record promoted components (empty when extraction is off).
  writeJSON(join(outDir, "extracted-components.json"), gen.components);

  writeJSON(join(outDir, "sections.json"), sections);
  writeJSON(join(outDir, "tokens.json"), tokens);
  writeJSON(join(outDir, "assets.json"), assetGraph.entries);
  writeJSON(join(outDir, "fonts.json"), fontGraph.entries);
  const inventory = inventoryOf(ir, primitives);
  writeJSON(join(outDir, "components.json"), inventory);
  writeJSON(join(outDir, "patterns.json"), patternHints);
  writeJSON(join(outDir, "recipes.json"), recipeReport);
  writeText(join(outDir, "recipes.md"), recipeReportToMarkdown(recipeReport));
  writeJSON(join(outDir, "interaction-recipes.json"), interactionRecipeReport);
  writeText(join(outDir, "interaction-recipes.md"), interactionRecipeReportToMarkdown(interactionRecipeReport));
  writeJSON(join(outDir, "seo.json"), seoInventory);
  writeText(join(outDir, "seo.md"), seoInventoryToMarkdown(seoInventory));
  const codeQuality = buildCodeQualityReport(appDir, recipeReport);
  writeJSON(join(outDir, "code-quality.json"), codeQuality);
  writeText(join(outDir, "code-quality.md"), codeQualityReportToMarkdown(codeQuality));
  const manifest = buildManifest({ ir, sections, tokens, assetGraph, fontGraph, capture, componentCount: inventory.count, patternHints, previewHtml: gen.previewHtml });
  writeJSON(join(outDir, "manifest.json"), manifest);

  return { ir, sections, tokens, assetGraph, fontGraph, recipeReport, interactionRecipeReport, patternHints, seoInventory, codeQuality, manifest, assetsCopied: mat.copied, assetsMissing: mat.missing };
}
