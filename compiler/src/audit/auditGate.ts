import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { GateResult } from "../validate/gates.js";
import type { IR } from "../normalize/ir.js";
import type { PageSnapshot } from "../capture/walker.js";
import type { Section } from "../infer/sections.js";
import { fileExists } from "../util/fsx.js";
import { liveWitnessScreenshotPath } from "../evidence/liveWitness.js";

/** Gate 7: visual audit — banded pixel diff vs frozen live-witness screenshots. */
export function pixelAuditGate(opts: {
  sourceDir: string;
  renderedDir: string;
  viewports: number[];
  outDir: string;
  threshold?: number;
}): GateResult {
  const issues: string[] = [];
  const perVp: Record<number, number> = {};
  let worst = 0;
  const threshold = opts.threshold ?? 0.14;

  for (const vp of opts.viewports) {
    const srcPath = liveWitnessScreenshotPath(opts.sourceDir, vp);
    const genPath = join(opts.renderedDir, "screenshots", `${vp}.png`);
    if (!fileExists(srcPath) || !fileExists(genPath)) {
      perVp[vp] = 1;
      worst = 1;
      issues.push(`vp${vp} missing witness or rendered screenshot`);
      continue;
    }
    const srcPng = PNG.sync.read(readFileSync(srcPath));
    const genPng = PNG.sync.read(readFileSync(genPath));
    const w = Math.min(srcPng.width, genPng.width);
    const h = Math.min(srcPng.height, genPng.height);
    if (w === 0 || h === 0) {
      perVp[vp] = 1;
      worst = 1;
      issues.push(`vp${vp} zero-dimension screenshot`);
      continue;
    }
    const srcCrop = cropPng(srcPng, w, h);
    const genCrop = cropPng(genPng, w, h);
    const diff = new PNG({ width: w, height: h });
    const diffPx = pixelmatch(srcCrop.data, genCrop.data, diff.data, w, h, { threshold: 0.1 });
    if (Math.abs(srcPng.height - genPng.height) / Math.max(srcPng.height, 1) > 0.05) {
      issues.push(`vp${vp} height mismatch witness=${srcPng.height} rendered=${genPng.height}`);
    }
    const ratio = diffPx / (w * h);
    perVp[vp] = Math.round(ratio * 10000) / 10000;
    worst = Math.max(worst, ratio);
  }

  const worstPct = Math.round(worst * 10000) / 10000;
  if (worstPct > threshold) issues.push(`visual audit worst ${(worstPct * 100).toFixed(1)}% (> ${(threshold * 100).toFixed(0)}%)`);

  return {
    gate: "visual_audit",
    pass: worst <= threshold,
    metrics: { perViewport: perVp, worstDiffPct: worstPct, threshold },
    issues,
  };
}

/** Placeholder for full fusion with Gate 4/5 node attribution (Phase 2). */
export function auditNodes(_ir: IR, _genSnaps: Record<number, PageSnapshot>, _sections: Section[], _viewports: number[]): unknown[] {
  return [];
}

function cropPng(png: PNG, w: number, h: number): PNG {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (png.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = png.data[si]!;
      out.data[di + 1] = png.data[si + 1]!;
      out.data[di + 2] = png.data[si + 2]!;
      out.data[di + 3] = png.data[si + 3]!;
    }
  }
  return out;
}
