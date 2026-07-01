import { join } from "node:path";
import { writeJSON, fileExists, readJSON, ensureDir } from "../util/fsx.js";
import {
  DEVICE_SCALE_FACTOR,
  FONT_READY_TIMEOUT_MS,
  SCROLL_BOTTOM_MS,
  SCROLL_SLEEP_MS,
  SCROLL_STEP_PX,
  SCROLL_TOP_MS,
  SETTLE_RECIPE_VERSION,
} from "../settle/recipe.js";
import type { AssetManifestHash } from "../materialize/manifest-hash.js";

export type EvidenceManifest = {
  schemaVersion: 1;
  settleRecipeVersion: string;
  deviceScaleFactor: number;
  scroll: { stepPx: number; sleepMs: number; bottomMs: number; topMs: number };
  fontReadyTimeoutMs: number;
  viewports: number[];
  sourceUrl: string;
  userAgent: string;
  locale: string;
  timezone: string;
  assetManifest?: AssetManifestHash;
};

export function evidenceManifestPath(sourceDir: string): string {
  return join(sourceDir, "evidence", "evidence-manifest.json");
}

export function writeEvidenceManifest(sourceDir: string, manifest: EvidenceManifest): void {
  ensureDir(join(sourceDir, "evidence"));
  writeJSON(evidenceManifestPath(sourceDir), manifest);
}

export function readEvidenceManifest(sourceDir: string): EvidenceManifest | null {
  const p = evidenceManifestPath(sourceDir);
  if (!fileExists(p)) return null;
  return readJSON<EvidenceManifest>(p);
}

export function baseEvidenceManifest(opts: {
  sourceUrl: string;
  viewports: number[];
  userAgent: string;
  locale?: string;
  timezone?: string;
  assetManifest?: AssetManifestHash;
}): EvidenceManifest {
  return {
    schemaVersion: 1,
    settleRecipeVersion: SETTLE_RECIPE_VERSION,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    scroll: {
      stepPx: SCROLL_STEP_PX,
      sleepMs: SCROLL_SLEEP_MS,
      bottomMs: SCROLL_BOTTOM_MS,
      topMs: SCROLL_TOP_MS,
    },
    fontReadyTimeoutMs: FONT_READY_TIMEOUT_MS,
    viewports: opts.viewports.slice().sort((a, b) => a - b),
    sourceUrl: opts.sourceUrl,
    userAgent: opts.userAgent,
    locale: opts.locale ?? "en-US",
    timezone: opts.timezone ?? "UTC",
    assetManifest: opts.assetManifest,
  };
}
