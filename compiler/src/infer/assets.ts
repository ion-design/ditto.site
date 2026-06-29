import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { ensureDir, fileExists } from "../util/fsx.js";
import type { CaptureResult, DiscoveredAsset } from "../capture/capture.js";

/**
 * Asset graph. Maps every discovered source asset URL to a deterministic local
 * path under the generated app's public dir, or records why it was skipped
 * (rubric Gate 2: every reference must be classified, none may 404, and none may
 * point back to a remote origin unless explicitly external-allowed).
 */

export type AssetClassification = "downloaded" | "skipped";

export type AssetEntry = {
  sourceUrl: string;
  type: string;
  classification: AssetClassification;
  localPath: string | null; // public-relative URL, e.g. /assets/cloned/images/ab.png
  storedFile: string | null;
  bytes: number;
  reason: string | null;
  impact: string | null;
  via: string[];
};

export type AssetGraph = {
  entries: AssetEntry[];
  byUrl: Map<string, AssetEntry>;
};

const TYPE_DIR: Record<string, string> = {
  image: "images", svg: "svg", video: "videos", font: "fonts", lottie: "lottie",
  css: "css", manifest: "manifest", other: "other",
};

function publicPathFor(type: string, storedFile: string): string {
  const dir = TYPE_DIR[type] ?? "other";
  return `/assets/cloned/${dir}/${storedFile}`;
}

export function buildAssetGraph(capture: CaptureResult): AssetGraph {
  const entries: AssetEntry[] = [];
  const byUrl = new Map<string, AssetEntry>();

  for (const a of capture.assets) {
    const entry = classify(a);
    entries.push(entry);
    byUrl.set(a.url, entry);
  }
  entries.sort((x, y) => x.sourceUrl.localeCompare(y.sourceUrl));
  return { entries, byUrl };
}

function classify(a: DiscoveredAsset): AssetEntry {
  // CSS is consumed by the compiler (font/url extraction), not referenced by the
  // generated app directly, so it is neither downloaded-as-asset nor a gap.
  const base: AssetEntry = {
    sourceUrl: a.url,
    type: a.type,
    classification: "skipped",
    localPath: null,
    storedFile: null,
    bytes: a.bytes,
    reason: null,
    impact: null,
    via: a.via.slice().sort(),
  };

  if (a.storedAs && a.bytes > 0) {
    return {
      ...base,
      classification: "downloaded",
      localPath: publicPathFor(a.type, a.storedAs),
      storedFile: a.storedAs,
    };
  }

  // Not stored — record a deterministic skip reason.
  let reason = "not_downloaded";
  if (a.status && a.status >= 400) reason = `http_${a.status}`;
  else if (a.status === null && a.via.every((v) => v.startsWith("css") || v === "css-url")) reason = "css_referenced_unfetched";
  return {
    ...base,
    reason,
    impact: a.type === "image" || a.type === "video" ? "visual_missing" : "minor",
  };
}

/** Copy downloaded asset bytes into the generated app's public dir. */
export function materializeAssets(graph: AssetGraph, sourceDir: string, appPublicDir: string, seenPublicPaths?: Set<string>): { copied: number; missing: string[] } {
  const storeDir = join(sourceDir, "assets-store");
  const cssDir = join(sourceDir, "capture", "css");
  let copied = 0;
  const missing: string[] = [];
  for (const e of graph.entries) {
    if (e.classification !== "downloaded" || !e.storedFile || !e.localPath) continue;
    if (e.type === "css") continue; // not served by the app
    // A <video> is rendered as its poster still (streaming sources are dropped in
    // generation), so the materialized video file is never referenced — skip
    // copying it to public/ to save disk and build time. Its first-frame poster is
    // a separate image asset that is still materialized.
    if (e.type === "video") continue;
    if (seenPublicPaths?.has(e.localPath)) continue;
    const src = join(storeDir, e.storedFile);
    const from = fileExists(src) ? src : join(cssDir, e.storedFile);
    if (!fileExists(from)) { missing.push(e.sourceUrl); continue; }
    const dest = join(appPublicDir, e.localPath.replace(/^\//, ""));
    ensureDir(join(dest, ".."));
    copyFileSync(from, dest);
    seenPublicPaths?.add(e.localPath);
    copied++;
  }
  return { copied, missing };
}
