import { mkdtempSync, rmSync, cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runClone,
  runCloneSite,
  validateRun,
  validateSite,
  buildIR,
  gatePollution,
  readJSON,
  siteIdFromUrl,
  COMPILER_VERSION,
  type CaptureResult,
  type CloneResult as CompilerCloneResult,
  type CloneSiteResult,
} from "clone-static";
import { collectFileMap } from "./collectFileMap.js";
import { ensureAppPreview } from "./ensureAppPreview.js";
import type { CaptureSanity, CloneJobResult, CloneOptions, RouteInfo, RunCloneJobInput } from "./types.js";
import { normalizeCloneRequestOptions, resolveCloneOptions, type ResolvedCloneOptions } from "./options.js";

/** Compute the cheap capture-sanity audit (no build): node count + whether the
 *  pollution gate flags the capture as degenerate, and whether bot/egress-wall text
 *  was seen. Falls back to safe defaults if the source artifacts are missing. */
function captureSanity(sourceDir: string, viewports: number[]): CaptureSanity {
  try {
    const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
    const vps = capture.viewports?.length ? capture.viewports : viewports;
    const ir = buildIR(sourceDir, vps);
    const p = gatePollution(ir, capture, vps);
    return { nodeCount: ir.doc.nodeCount, pollution: !p.pass, blocked: !!p.metrics.wallTextDetected };
  } catch {
    return { nodeCount: 0, pollution: true, blocked: false };
  }
}

/** Persistent entry-capture cache path for a URL. Key = the compiler's full host+path
 *  site id (collision-safe, unlike the bare folder name), so only the SAME page reuses. */
function entryCacheSource(cacheDir: string, url: string): string {
  return join(cacheDir, siteIdFromUrl(url), "source");
}
/** Whether a cached capture exists and is fresh enough to reuse (ttlMs 0/undefined =
 *  no expiry). Staleness is measured from the capture artifact's mtime. */
function freshCapture(dir: string, ttlMs?: number): boolean {
  const f = join(dir, "capture", "capture-result.json");
  if (!existsSync(f)) return false;
  if (!ttlMs) return true;
  try { return Date.now() - statSync(f).mtimeMs < ttlMs; } catch { return false; }
}
/** Copy a fresh capture into the cache (atomic-ish: clear then copy). No-op if the
 *  source has no capture artifact. */
function persistCapture(srcDir: string | undefined, dest: string): void {
  if (!srcDir || !existsSync(join(srcDir, "capture", "capture-result.json"))) return;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(srcDir, dest, { recursive: true });
}

/** Whether a cached capture can substitute for a fresh one under these options.
 *  The cache is keyed by URL only, so feature parity is checked here: every
 *  requested viewport must have been captured, interaction/motion evidence must
 *  match the request EXACTLY (a motion-bearing capture generates different output
 *  than a no-motion one), and screenshots must exist when validation needs them. */
function captureCompatible(dir: string, options: ResolvedCloneOptions, needScreenshots: boolean): boolean {
  try {
    const cap = readJSON<CaptureResult>(join(dir, "capture", "capture-result.json"));
    const requested = options.viewports ?? [375, 768, 1280, 1920];
    const captured = new Set(cap.viewports ?? []);
    if (!requested.every((vp) => captured.has(vp))) return false;
    if (!!cap.interaction !== options.interactions) return false;
    if (!!cap.motion !== options.motion) return false;
    if (needScreenshots && !requested.every((vp) => existsSync(join(dir, "screenshots", `${vp}.png`)))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The single seam the service depends on: run one clone end-to-end into a temp
 * dir, collect its generated app into a file map, optionally verify it, then return
 * a typed result. The caller (worker/api) uploads artifacts + persists, then the
 * temp dir is removed in `finally`. No compiler behavior is changed — this only
 * orchestrates the existing entry points with a parameterized output dir.
 *
 * Incremental speed path: when `captureCacheDir` is set, a single-page job stashes its
 * entry capture there; a later multi-page job for the same URL reuses it as the entry
 * route (skips re-capturing page 1) and regenerates the whole site on top of it.
 */
export async function runCloneJob(input: RunCloneJobInput): Promise<CloneJobResult> {
  const requestOptions: CloneOptions = normalizeCloneRequestOptions(input.options ?? {});
  const options = resolveCloneOptions(requestOptions);
  const syncVerify = !!options.verify && !options.asyncVerify;
  const captureValidationArtifacts = !!(options.verify || options.asyncVerify);
  const log = input.log ?? (() => {});
  const ownsTemp = !input.runsDir;
  const runsDir = input.runsDir ?? mkdtempSync(join(tmpdir(), "clone-job-"));
  const kind: "clone" | "clone_site" = options.mode === "multi" ? "clone_site" : "clone";

  // Best-by-default (matches the CLI): interactions/components/motion ON unless the
  // caller explicitly disables them. (runClone itself defaults them OFF; the CLI is
  // what turns them on — so the service does the same here.)
  const interactions = options.interactions;
  const components = options.components;
  const motion = options.motion;

  try {
    const t0 = Date.now();
    let runDir: string;
    let routes: RouteInfo[] | undefined;
    let sanity: CaptureSanity;
    let captureReused = false;
    // Persistent entry-capture cache (the single→multi speed path), keyed by URL.
    const cacheEntry = input.captureCacheDir ? entryCacheSource(input.captureCacheDir, input.url) : undefined;

    if (kind === "clone_site") {
      // Reuse a prior single-page capture for the entry route when the cache holds a fresh one.
      const reuseEntrySource = cacheEntry && freshCapture(cacheEntry, input.captureCacheTtlMs) ? cacheEntry : undefined;
      captureReused = !!reuseEntrySource;
      const res: CloneSiteResult = await runCloneSite({
        url: input.url,
        runsDir,
        validate: false,
        interactions,
        components,
        humanizeMode: options.styling,
        framework: options.framework,
        reuseEntrySource,
        maxRoutes: options.maxRoutes,
        maxCollectionInstances: options.maxCollection,
        captureConcurrency: options.captureConcurrency,
        validationConcurrency: options.validationConcurrency,
        viewportConcurrency: options.viewportConcurrency,
        screenshots: captureValidationArtifacts,
        log,
      });
      runDir = res.runDir;
      // Reproduced routes + the collapsed-collection map (representativeOf).
      routes = res.routes.map((r) => ({ route: r.routePath }));
      for (const c of res.plan.collections) {
        const rep = res.routes.find((r) => r.routePath === c.representative);
        if (rep) {
          for (const inst of c.instances) {
            if (inst !== c.representative) routes!.push({ route: inst, representativeOf: c.representative });
          }
        }
      }
      const entry = res.routes.find((r) => r.routePath === res.plan.entry) ?? res.routes[0];
      sanity = entry
        ? captureSanity(entry.sourceDir, entry.ir.doc.viewports)
        : { nodeCount: 0, pollution: true, blocked: false };
      // Refresh the cache with the entry capture (seeds it for a cold multi-page run).
      if (cacheEntry && entry) persistCapture(entry.sourceDir, cacheEntry);
    } else {
      // Repeat-clone speed path: reuse the URL-keyed cached capture when it is fresh
      // AND feature-compatible with this request (viewports/interactions/motion/screenshots).
      const reuseSource =
        cacheEntry &&
        freshCapture(cacheEntry, input.captureCacheTtlMs) &&
        captureCompatible(cacheEntry, options, captureValidationArtifacts)
          ? cacheEntry
          : undefined;
      captureReused = !!reuseSource;
      const res: CompilerCloneResult = await runClone({
        url: input.url,
        runsDir,
        viewports: options.viewports,
        interactions,
        components,
        motion,
        humanizeMode: options.styling,
        framework: options.framework,
        screenshots: captureValidationArtifacts,
        reuseSource,
        log,
      });
      runDir = res.runDir;
      sanity = captureSanity(res.sourceDir, options.viewports ?? [375, 768, 1280, 1920]);
      // Stash this page's capture so a later job can reuse it (speed path). Skip on
      // reuse: re-copying identical data would only refresh the TTL artificially.
      if (cacheEntry && !captureReused) persistCapture(res.sourceDir, cacheEntry);
    }
    const captureMs = Date.now() - t0;

    // Optional verify (build + serve + re-render + grade). The single isolation-
    // sensitive step: pass a per-worker harnessDir so concurrent builds don't collide.
    let verify: unknown;
    let verifyMs: number | undefined;
    if (syncVerify) {
      const done = await verifyCloneJobResult({ kind, runDir }, { harnessDir: input.harnessDir, tier: input.tier ?? "stage2", validationConcurrency: options.validationConcurrency, viewportConcurrency: options.viewportConcurrency, log });
      verify = done.verify;
      verifyMs = done.verifyMs;
    }

    // App preview: static export published under public/app-preview/ so it rides the
    // file map. Build failure is non-fatal — the clone's sources still deliver.
    let previewMs: number | undefined;
    if (options.preview) {
      const p = ensureAppPreview(runDir, { harnessDir: input.harnessDir, log });
      previewMs = p.previewMs;
      if (!p.ok) log({ event: "app_preview_failed", error: p.error?.slice(-400) });
    }

    const files = collectFileMap(runDir);

    return {
      url: input.url,
      kind,
      options: requestOptions,
      status: "succeeded",
      compilerVersion: COMPILER_VERSION,
      timings: { captureMs, generateMs: 0, ...(verifyMs !== undefined ? { verifyMs } : {}), ...(previewMs !== undefined ? { previewMs } : {}) },
      routes,
      files,
      capture: sanity,
      captureReused,
      verify,
      runDir,
    };
  } finally {
    if (ownsTemp && !input.keepTemp) {
      rmSync(runsDir, { recursive: true, force: true });
    }
  }
}

export async function verifyCloneJobResult(
  result: Pick<CloneJobResult, "kind" | "runDir">,
  opts?: {
    harnessDir?: string;
    tier?: string;
    validationConcurrency?: number;
    viewportConcurrency?: number;
    log?: (e: Record<string, unknown>) => void;
  },
): Promise<{ verify: unknown; verifyMs: number }> {
  const t0 = Date.now();
  const tier = opts?.tier ?? "stage2";
  const verify = result.kind === "clone_site"
    ? await validateSite(result.runDir, { harnessDir: opts?.harnessDir, tier, routeConcurrency: opts?.validationConcurrency, viewportConcurrency: opts?.viewportConcurrency, log: opts?.log })
    : await validateRun(result.runDir, { harnessDir: opts?.harnessDir, tier, log: opts?.log });
  return { verify, verifyMs: Date.now() - t0 };
}
