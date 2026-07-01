import { basename } from "node:path";
import { collectFiles, scoreApp, type QualityReport, type SrcFile } from "../runner/qualityScore.js";
import type { RecipeCandidate, RecipeReport } from "../infer/recipes.js";

export type CodeQualityMetrics = {
  files: number;
  jsxTags: number;
  arbitraryPxRem: number;
  decimalArbitraryPx: number;
  arbitraryBands: number;
  breakpointUtilities: number;
  dataCid: number;
  dataDittoId: number;
  styleRefs: number;
  switchCases: number;
  variantSlotComponents: number;
  mapCalls: number;
};

export type RecipeCodeQuality = {
  id: string;
  kind: RecipeCandidate["kind"];
  confidence: number;
  rootCid: string;
  itemParentCid: string | null;
  dataModel: string | null;
  itemCount: number | null;
  files: string[];
  metrics: CodeQualityMetrics;
  notes: string[];
};

export type CodeQualityReport = {
  version: 1;
  appDir: string;
  quality: QualityReport;
  summary: CodeQualityMetrics & {
    componentModules: number;
    totalTags: number;
    qualityTotal: number;
  };
  hotspots: Array<{ file: string; metrics: CodeQualityMetrics }>;
  recipes: RecipeCodeQuality[];
};

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function countJsxTags(text: string): number {
  return count(text, /<[a-zA-Z][a-zA-Z0-9.]*(\s|\/|>)/g);
}

function metricsFor(files: SrcFile[]): CodeQualityMetrics {
  let arbitraryPxRem = 0;
  let decimalArbitraryPx = 0;
  const text = files.map((f) => f.text).join("\n");
  for (const m of text.matchAll(/\[(-?[0-9]+\.?[0-9]*)(px|rem)\]/g)) {
    arbitraryPxRem++;
    const px = parseFloat(m[1] ?? "0") * (m[2] === "rem" ? 16 : 1);
    if (Math.abs(px - Math.round(px)) > 0.02) decimalArbitraryPx++;
  }

  return {
    files: files.length,
    jsxTags: files.reduce((sum, f) => sum + countJsxTags(f.text), 0),
    arbitraryPxRem,
    decimalArbitraryPx,
    arbitraryBands: count(text, /\b(?:min|max)-\[[0-9]+px\]:/g),
    breakpointUtilities: count(text, /\b(?:sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl):/g),
    dataCid: count(text, /data-cid/g),
    dataDittoId: count(text, /data-ditto-id/g),
    styleRefs: count(text, /\b(?:styles\.[A-Za-z_]\w*|\w+Styles|styles)\b/g),
    switchCases: count(text, /\bcase\s+["']/g),
    variantSlotComponents: count(text, /function\s+\w+Slot\d+\b/g),
    mapCalls: count(text, /\.map\(/g),
  };
}

function addMetrics(a: CodeQualityMetrics, b: CodeQualityMetrics): CodeQualityMetrics {
  return {
    files: a.files + b.files,
    jsxTags: a.jsxTags + b.jsxTags,
    arbitraryPxRem: a.arbitraryPxRem + b.arbitraryPxRem,
    decimalArbitraryPx: a.decimalArbitraryPx + b.decimalArbitraryPx,
    arbitraryBands: a.arbitraryBands + b.arbitraryBands,
    breakpointUtilities: a.breakpointUtilities + b.breakpointUtilities,
    dataCid: a.dataCid + b.dataCid,
    dataDittoId: a.dataDittoId + b.dataDittoId,
    styleRefs: a.styleRefs + b.styleRefs,
    switchCases: a.switchCases + b.switchCases,
    variantSlotComponents: a.variantSlotComponents + b.variantSlotComponents,
    mapCalls: a.mapCalls + b.mapCalls,
  };
}

function emptyMetrics(): CodeQualityMetrics {
  return {
    files: 0,
    jsxTags: 0,
    arbitraryPxRem: 0,
    decimalArbitraryPx: 0,
    arbitraryBands: 0,
    breakpointUtilities: 0,
    dataCid: 0,
    dataDittoId: 0,
    styleRefs: 0,
    switchCases: 0,
    variantSlotComponents: 0,
    mapCalls: 0,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filesForRecipe(files: SrcFile[], c: RecipeCandidate): SrcFile[] {
  const cidNeedles = [
    c.rootCid,
    c.itemParentCid,
    ...(c.repeatedItems ?? []).map((item) => item.cid),
  ].filter((x): x is string => !!x);
  const cidPatterns = cidNeedles.map((cid) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(cid)}(?![A-Za-z0-9_-])`));
  const kindNeedle = c.kind.replace(/-/g, "-");
  const componentNeedle = c.componentName;
  const componentPattern = componentNeedle ? new RegExp(`\\b${escapeRegExp(componentNeedle)}\\b`) : null;
  const matched = files.filter((f) => {
    if (cidPatterns.some((re) => re.test(f.text))) return true;
    const rel = f.rel.toLowerCase();
    if (componentPattern?.test(f.text)) return true;
    if (rel.includes(kindNeedle)) return true;
    if (c.kind === "card-grid" && rel.includes("card-grid-item")) return true;
    if (c.kind === "feature-grid" && rel.includes("feature-grid-item")) return true;
    if (c.kind === "logo-cloud" && rel.includes("logo-cloud-item")) return true;
    return false;
  });
  return [...new Map(matched.map((f) => [f.rel, f])).values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

function notesForRecipe(c: RecipeCandidate, m: CodeQualityMetrics): string[] {
  const notes: string[] = [];
  if (m.variantSlotComponents > 0) notes.push("uses variant-slot helper(s) for heterogeneous media/content");
  if (m.switchCases > 0 && m.variantSlotComponents === 0) notes.push("still emitted as a full switch fallback");
  if (m.styleRefs > 0) notes.push("uses per-instance style override plumbing");
  if (m.arbitraryBands === 0) notes.push("no arbitrary breakpoint bands in matched files");
  if (m.decimalArbitraryPx > 0) notes.push("contains frozen non-integer arbitrary measurements");
  if (m.breakpointUtilities > 0 && m.arbitraryBands === 0) notes.push("responsive logic uses named breakpoints");
  if (m.files === 0) notes.push("no generated file could be matched back to this recipe");
  if (c.confidence < 0.86) notes.push("low-confidence recipe; report-only for now");
  return notes;
}

export function buildCodeQualityReport(appDir: string, recipes: RecipeReport): CodeQualityReport {
  const files = collectFiles(appDir);
  const quality = { ...scoreApp(appDir), dir: "app" };
  const summaryMetrics = metricsFor(files);
  const hotspots = files
    .map((f) => ({ file: f.rel, metrics: metricsFor([f]) }))
    .filter((h) => h.metrics.arbitraryPxRem || h.metrics.decimalArbitraryPx || h.metrics.arbitraryBands || h.metrics.switchCases || h.metrics.variantSlotComponents || h.metrics.styleRefs)
    .sort((a, b) => {
      const aScore = a.metrics.decimalArbitraryPx * 8 + a.metrics.arbitraryPxRem * 3 + a.metrics.arbitraryBands * 6 + a.metrics.switchCases + a.metrics.styleRefs + a.metrics.variantSlotComponents;
      const bScore = b.metrics.decimalArbitraryPx * 8 + b.metrics.arbitraryPxRem * 3 + b.metrics.arbitraryBands * 6 + b.metrics.switchCases + b.metrics.styleRefs + b.metrics.variantSlotComponents;
      return bScore - aScore || a.file.localeCompare(b.file);
    })
    .slice(0, 20);

  return {
    version: 1,
    appDir: "app",
    quality,
    summary: {
      ...summaryMetrics,
      componentModules: quality.raw.componentModules ?? 0,
      totalTags: quality.raw.totalTags ?? 0,
      qualityTotal: quality.total,
    },
    hotspots,
    recipes: recipes.candidates.map((c) => {
      const matched = filesForRecipe(files, c);
      const metrics = matched.reduce((sum, f) => addMetrics(sum, metricsFor([f])), emptyMetrics());
      return {
        id: c.id,
        kind: c.kind,
        confidence: c.confidence,
        rootCid: c.rootCid,
        itemParentCid: c.itemParentCid ?? null,
        dataModel: c.dataModel ?? null,
        itemCount: c.itemCount ?? null,
        files: matched.map((f) => f.rel),
        metrics,
        notes: notesForRecipe(c, metrics),
      };
    }),
  };
}

function metricSummary(m: CodeQualityMetrics): string {
  return [
    `${m.files} files`,
    `${m.jsxTags} tags`,
    `${m.arbitraryPxRem} arb px/rem`,
    `${m.decimalArbitraryPx} decimal`,
    `${m.breakpointUtilities} breakpoints`,
    `${m.arbitraryBands} arb bands`,
    `${m.switchCases} cases`,
    `${m.variantSlotComponents} slots`,
  ].join(" · ");
}

export function codeQualityReportToMarkdown(report: CodeQualityReport): string {
  const lines: string[] = [];
  lines.push(`# Code Quality Report`);
  lines.push("");
  lines.push(`App: \`${basename(report.appDir)}\``);
  lines.push(`Quality: **${report.quality.total}/100**`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- ${metricSummary(report.summary)}`);
  lines.push(`- component modules: ${report.summary.componentModules}; total tags: ${report.summary.totalTags}; data-cid in generated validation tree: ${report.summary.dataCid}; data-ditto-id: ${report.summary.dataDittoId}`);
  lines.push("");
  lines.push(`## Recipes`);
  lines.push("");
  if (!report.recipes.length) {
    lines.push(`No recipe candidates detected.`);
  } else {
    for (const r of report.recipes) {
      lines.push(`### ${r.id} · ${r.kind} · confidence ${r.confidence}`);
      lines.push("");
      lines.push(`- model: ${r.dataModel ?? "none"}; items: ${r.itemCount ?? "n/a"}; root: \`${r.rootCid}\`; item parent: \`${r.itemParentCid ?? "none"}\``);
      lines.push(`- ${metricSummary(r.metrics)}`);
      if (r.files.length) lines.push(`- files: ${r.files.map((f) => `\`${f}\``).join(", ")}`);
      if (r.notes.length) lines.push(`- notes: ${r.notes.join("; ")}`);
      lines.push("");
    }
  }
  lines.push(`## Hotspots`);
  lines.push("");
  if (!report.hotspots.length) {
    lines.push(`No code-quality hotspots detected.`);
  } else {
    for (const h of report.hotspots.slice(0, 12)) {
      lines.push(`- \`${h.file}\`: ${metricSummary(h.metrics)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
