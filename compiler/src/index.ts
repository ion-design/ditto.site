/**
 * Public library boundary for the deterministic cloner.
 *
 * This barrel exists so the service layer (packages/core) has ONE clean import
 * surface and never reaches into compiler internals. It only re-exports existing
 * functions/types — it adds no behavior and changes no clone semantics. Every
 * entry module guards its CLI `main()` behind `import.meta.url === ...`, so
 * importing them here is side-effect free.
 */

// ---- Single-page clone (capture + generate, no build) ----
export { runClone, siteIdFromUrl, latestSourceDir } from "./cli.js";
export type { CloneOptions, CloneResult } from "./cli.js";

// ---- Multi-page / whole-site clone ----
export { runCloneSite, regenerateSite } from "./site/cloneSite.js";
export type { CloneSiteOptions, CloneSiteResult } from "./site/cloneSite.js";

// ---- Validation / verify (build + serve + re-render + grade) ----
export { validateRun } from "./validate/validate.js";
export { validateSite } from "./site/validateSite.js";
export type { SiteReport, SiteRouteReport } from "./site/validateSite.js";
export type { Report, Scorecard } from "./validate/report.js";

// ---- Pure generation from a frozen capture (deterministic; Gate 6) ----
export { generateAll } from "./generate/pipeline.js";
export type { GenerateAllResult } from "./generate/pipeline.js";

// ---- Capture sanity (pollution / bot-wall detection — no build needed) ----
export { gatePollution } from "./validate/gates.js";
export type { GateResult } from "./validate/gates.js";
export { buildIR } from "./normalize/ir.js";
export type { IR } from "./normalize/ir.js";

// ---- Pattern knowledge (frozen catalog; deterministic hints; pin asserted on load) ----
export { resolvePatternHints, loadPatternIndex, assertPinnedCatalog, matchCatalogNode } from "./knowledge/patternIndex.js";
export type { PatternHints, PatternMatch, PatternDef, PatternCatalog } from "./knowledge/patternIndex.js";

// ---- Capture surface + version ----
export { captureSite, REQUIRED_VIEWPORTS } from "./capture/capture.js";
export type { CaptureResult } from "./capture/capture.js";
export { COMPILER_VERSION, SCHEMA_VERSION } from "./generate/manifest.js";

// ---- Filesystem helpers (canonical/deterministic JSON, etc.) ----
export { readJSON, fileExists, writeJSON, ensureDir } from "./util/fsx.js";
export { canonicalStringify } from "./util/canonical.js";
