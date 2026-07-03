import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readText, fileExists } from "../util/fsx.js";
import type { AssetGraph } from "../infer/assets.js";
import type { GateResult } from "../validate/gates.js";
import { normalizeFetchUrl } from "./url-canonical.js";

const REMOTE_ATTR_RE = /\b(?:src|href|srcset|data-src|data-bg|poster)\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

/** Extract every URL referenced in frozen live-witness HTML. */
export function extractHtmlRefs(html: string): string[] {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  REMOTE_ATTR_RE.lastIndex = 0;
  while ((m = REMOTE_ATTR_RE.exec(html)) !== null) {
    const v = m[1]!.trim();
    if (v && !v.startsWith("#") && !v.startsWith("javascript:")) refs.add(v);
  }
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(html)) !== null) {
    const v = m[1]!.trim();
    if (v && !v.startsWith("data:")) refs.add(v);
  }
  return [...refs].sort();
}

/** File extensions the pipeline materializes. The witness HTML also references
 *  pages (`<a href>`), scripts, and API endpoints — none of which the clone ships
 *  by design, so counting them as "unresolved assets" made this gate fail on every
 *  site. Only asset-like refs participate. */
const ASSET_EXT_RE = /\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|css|webmanifest)(\?|#|$)/i;

export function gate2bHtmlWitness(sourceDir: string, assetGraph: AssetGraph, sourceUrl: string, strict = false): GateResult {
  const issues: string[] = [];
  const witnessRoot = join(sourceDir, "evidence", "live-witness");
  let pagesChecked = 0;
  let remoteRefs = 0;
  let unresolved = 0;
  let untracked = 0;

  if (!fileExists(witnessRoot)) {
    return { gate: "html_witness", pass: false, metrics: { pagesChecked: 0 }, issues: ["missing evidence/live-witness"] };
  }

  let origin = "";
  try { origin = new URL(sourceUrl).origin; } catch { /* ignore */ }

  for (const vp of readdirSync(witnessRoot).sort()) {
    const htmlPath = join(witnessRoot, vp, "page.html");
    if (!fileExists(htmlPath)) continue;
    pagesChecked++;
    const html = readText(htmlPath);
    for (const ref of extractHtmlRefs(html)) {
      if (ref.startsWith("data:")) continue;
      const abs = normalizeFetchUrl(ref, sourceUrl);
      if (!/^https?:\/\//i.test(abs)) continue;
      try {
        if (new URL(abs).origin !== origin) continue;
      } catch { continue; }
      if (!ASSET_EXT_RE.test(abs)) continue;
      remoteRefs++;
      const hit = assetGraph.byUrl.get(abs)
        ?? assetGraph.entries.find((e) => normalizeFetchUrl(e.sourceUrl) === abs);
      // A tracked entry skipped WITH a recorded reason is deliberate policy (e.g.
      // css_referenced_unfetched, http_404) — surfaced by gate 2, not a witness gap.
      if (!hit) untracked++;
      else if (hit.classification !== "downloaded" && !hit.reason) unresolved++;
    }
  }

  if (pagesChecked === 0) issues.push("no live-witness HTML pages");
  if (unresolved > 0) issues.push(`${unresolved}/${remoteRefs} origin asset refs not materialized locally`);
  if (untracked > 0) issues.push(`${untracked}/${remoteRefs} origin asset refs never discovered by capture`);
  if (strict && (unresolved > 0 || untracked > 0)) issues.push("strict mode: all HTML asset refs must resolve");

  return {
    gate: "html_witness",
    pass: issues.length === 0,
    metrics: { pagesChecked, remoteRefs, unresolved, untracked },
    issues,
  };
}
