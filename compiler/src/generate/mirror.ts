import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, fileExists, readText, writeText } from "../util/fsx.js";
import type { AssetGraph, AssetEntry } from "../infer/assets.js";
import { liveWitnessHtmlPath } from "../evidence/liveWitness.js";
import { normalizeFetchUrl } from "../materialize/url-canonical.js";

export const MIRROR_MOUNT = "/static";
export const MIRROR_ASSET_PREFIX = `${MIRROR_MOUNT}/assets/cloned`;

/**
 * Static HTML mirror served at /static/ alongside the generated Next.js app.
 * Uses frozen live-witness HTML when present; rewrites asset URLs to local paths.
 */
export function generateMirror(opts: {
  sourceDir: string;
  assetGraph: AssetGraph;
  sourceUrl: string;
  mirrorPublicDir: string;
  canonicalViewport?: number;
}): { htmlPath: string; assetsCopied: number } {
  const vp = opts.canonicalViewport ?? 1280;
  const witnessPath = liveWitnessHtmlPath(opts.sourceDir, vp);
  let html = fileExists(witnessPath)
    ? readText(witnessPath)
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mirror</title></head><body><p>No live witness for viewport ${vp}</p></body></html>`;

  html = rewriteHtmlAssetUrls(html, opts.assetGraph, opts.sourceUrl);
  html = injectMirrorBase(html);

  ensureDir(opts.mirrorPublicDir);
  const htmlPath = join(opts.mirrorPublicDir, "index.html");
  writeText(htmlPath, html);

  const assetsCopied = materializeMirrorAssets(opts.assetGraph, opts.sourceDir, join(opts.mirrorPublicDir, "assets", "cloned"));
  return { htmlPath, assetsCopied };
}

function injectMirrorBase(html: string): string {
  const base = `<base href="${MIRROR_MOUNT}/">`;
  if (/<base\s/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  return `<!DOCTYPE html><html><head>${base}</head>${html}</html>`;
}

function rewriteHtmlAssetUrls(html: string, graph: AssetGraph, sourceUrl: string): string {
  let out = html;
  const origin = (() => { try { return new URL(sourceUrl).origin; } catch { return ""; } })();
  const entries = [...graph.entries].filter((e) => e.classification === "downloaded" && e.localPath);
  entries.sort((a, b) => b.sourceUrl.length - a.sourceUrl.length);

  for (const e of entries) {
    const local = mirrorAssetPath(e);
    if (!local) continue;
    const variants = urlVariants(e.sourceUrl, origin);
    for (const v of variants) {
      out = out.split(v).join(local);
    }
  }
  // Protocol-relative CDN refs
  out = out.replace(/(?:src|href)=(["'])\/\/([^"']+)\1/gi, (_, q, rest) => {
    const abs = normalizeFetchUrl("//" + rest, sourceUrl);
    const entry = graph.byUrl.get(abs) ?? findByUrlPrefix(graph, abs);
    const local = entry ? mirrorAssetPath(entry) : null;
    return local ? `src=${q}${local}${q}` : `src=${q}https://${rest}${q}`;
  });
  return out;
}

function mirrorAssetPath(e: AssetEntry): string | null {
  if (!e.localPath) return null;
  return `${MIRROR_ASSET_PREFIX}${e.localPath.replace(/^\/assets\/cloned/, "")}`;
}

function urlVariants(url: string, origin: string): string[] {
  const canon = normalizeFetchUrl(url);
  const set = new Set<string>([url, canon]);
  try {
    const u = new URL(canon);
    if (u.origin === origin) set.add(u.pathname);
    set.add(u.href.replace(/^https:/, "http:"));
  } catch { /* ignore */ }
  return [...set].filter(Boolean);
}

function findByUrlPrefix(graph: AssetGraph, url: string): AssetEntry | undefined {
  const canon = normalizeFetchUrl(url);
  for (const e of graph.entries) {
    if (normalizeFetchUrl(e.sourceUrl) === canon) return e;
  }
  return undefined;
}

function materializeMirrorAssets(graph: AssetGraph, sourceDir: string, destRoot: string): number {
  const storeDir = join(sourceDir, "assets-store");
  const cssDir = join(sourceDir, "capture", "css");
  let copied = 0;
  for (const e of graph.entries) {
    if (e.classification !== "downloaded" || !e.storedFile || !e.localPath) continue;
    if (e.type === "css" || e.type === "video") continue;
    const rel = e.localPath.replace(/^\/assets\/cloned\//, "");
    const src = fileExists(join(storeDir, e.storedFile))
      ? join(storeDir, e.storedFile)
      : join(cssDir, e.storedFile);
    if (!fileExists(src)) continue;
    const dest = join(destRoot, rel);
    ensureDir(join(dest, ".."));
    copyFileSync(src, dest);
    copied++;
  }
  return copied;
}
