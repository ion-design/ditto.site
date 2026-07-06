/**
 * Service-layer types. These are the public wire shapes for clone options,
 * clone results, and the eager output file map, plus the core's internal
 * collected-file shape.
 *
 * The core layer is the ONLY place that imports the compiler. Everything above
 * it (api, worker, mcp) speaks these types.
 */

export type CloneMode = "single" | "multi";
export type CloneStyling = "tailwind" | "css";
export type CloneFramework = "next" | "vite";

/** Clone options accepted by the service/core boundary.
 *
 * Normal callers should use only the product choices:
 * - `mode`: single page or multi-page site clone.
 * - `styling`: Tailwind v4 or plain CSS output.
 * - `framework`: Next.js App Router or Vite React output.
 *
 * The remaining fields are operational/dev controls or deprecated compatibility
 * aliases. Internal pipeline features such as probing, recipes, component
 * extraction, interactions, and motion stay automatic by default.
 */
export type CloneOptions = {
  mode?: CloneMode;
  styling?: CloneStyling;
  framework?: CloneFramework;
  /** Build a browsable static export of the clone into `public/app-preview/`
   *  (served by the API's app-preview route). Defaults ON for single-page clones. */
  preview?: boolean;
  verify?: boolean;
  /** DB/worker mode: persist the clone first, then attach verify in the background. */
  asyncVerify?: boolean;
  maxRoutes?: number;
  maxCollection?: number;
  captureConcurrency?: number;
  validationConcurrency?: number;
  viewportConcurrency?: number;
  /** Service-level: bypass the cache on read AND write (does not affect output). */
  noCache?: boolean;

  /** @deprecated Use `mode: "multi"` instead. */
  multiPage?: boolean;
  /** @deprecated Use `styling` instead. */
  humanizeMode?: CloneStyling;

  /** Dev-only/output-affecting escape hatches. Not part of the normal product surface. */
  viewports?: number[];
  interactions?: boolean;
  components?: boolean;
  motion?: boolean;
};

/** A single file in a clone's output, as collected from `generated/app/`.
 *  Text files carry their content inline; binaries carry only a local path +
 *  hash (the storage layer turns `absPath` into a presigned URL after upload). */
export type CollectedFile = {
  /** app-relative POSIX path, e.g. "src/app/page.tsx" or "public/assets/cloned/images/ab.png" */
  path: string;
  kind: "text" | "binary";
  bytes: number;
  /** sha256 of the raw file bytes (content-addressing for storage + cache integrity). */
  sha256: string;
  /** present for text files only */
  content?: string;
  /** local filesystem path (ephemeral — used by the storage layer to upload/stream). */
  absPath: string;
};

export type FileMap = Record<string, CollectedFile>;

/** Capture-sanity audit — surfaced so a structurally-perfect clone of the WRONG
 *  page (bot wall, empty shell) is flagged rather than sold as success. */
export type CaptureSanity = {
  nodeCount: number;
  pollution: boolean; // the pollution gate failed (degenerate capture)
  blocked: boolean; // bot/egress wall text detected
};

export type CloneTimings = { captureMs: number; generateMs: number; verifyMs?: number; previewMs?: number };

export type RouteInfo = { route: string; representativeOf?: string };

/** What `runCloneJob` returns — the full result for one clone, BEFORE storage
 *  upload assigns URLs to binaries. The worker/api persists + uploads from this. */
export type CloneJobResult = {
  url: string;
  kind: "clone" | "clone_site";
  options: CloneOptions;
  status: "succeeded";
  compilerVersion: string;
  timings: CloneTimings;
  routes?: RouteInfo[];
  files: FileMap;
  capture: CaptureSanity;
  /** true when a multi-page job reused a prior single-page entry capture (no re-capture
   *  of the entry route) — the "single page first, then expand" speed path. */
  captureReused?: boolean;
  /** present only when options.verify === true */
  verify?: unknown; // compiler Report — kept opaque here to avoid leaking gate internals upward
  /** the ephemeral local run dir (already collected into `files`); caller cleans up
   *  unless `keepTemp` was set. */
  runDir: string;
};

export type RunCloneJobInput = {
  url: string;
  options?: CloneOptions;
  /** override the temp base dir (tests). When set, the dir is NOT auto-removed. */
  runsDir?: string;
  /** keep the run dir after collecting the file map (debug/tests). */
  keepTemp?: boolean;
  /** Persistent entry-capture cache base dir, keyed by URL. A single-page job copies its
   *  capture here; a later multi-page job for the same URL REUSES it as the entry route
   *  (no re-capture) — the "single page first, then expand to the full site" speed path. */
  captureCacheDir?: string;
  /** Max age (ms) of a cached entry capture that may be reused; older ⇒ re-capture.
   *  Undefined/0 ⇒ no expiry (reuse whenever present). Bounds staleness for a service. */
  captureCacheTtlMs?: number;
  /** isolated build harness dir for verify (per-worker; defaults to the compiler's). */
  harnessDir?: string;
  /** tier threshold for the perceptual gate when verifying (default "stage2"). */
  tier?: string;
  log?: (e: Record<string, unknown>) => void;
};
