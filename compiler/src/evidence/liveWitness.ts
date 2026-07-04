import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, fileExists, writeText } from "../util/fsx.js";

export function evidenceDir(sourceDir: string): string {
  return join(sourceDir, "evidence");
}

export function liveWitnessDir(sourceDir: string): string {
  return join(evidenceDir(sourceDir), "live-witness");
}

/** Persist frozen live HTML + screenshot per viewport at capture time. */
export function writeLiveWitnessViewport(opts: {
  sourceDir: string;
  viewport: number;
  html: string;
  screenshotSrc?: string;
}): void {
  const dir = join(liveWitnessDir(opts.sourceDir), String(opts.viewport));
  ensureDir(dir);
  writeText(join(dir, "page.html"), opts.html);
  if (opts.screenshotSrc && fileExists(opts.screenshotSrc)) {
    copyFileSync(opts.screenshotSrc, join(dir, "screenshot.png"));
  }
}

export function liveWitnessHtmlPath(sourceDir: string, viewport: number): string {
  return join(liveWitnessDir(sourceDir), String(viewport), "page.html");
}

export function liveWitnessScreenshotPath(sourceDir: string, viewport: number): string {
  return join(liveWitnessDir(sourceDir), String(viewport), "screenshot.png");
}
