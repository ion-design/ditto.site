import type { FontFace } from "../capture/walker.js";
import type { AssetGraph, AssetEntry } from "./assets.js";

/**
 * Font graph. Resolves @font-face src URLs to downloaded local font files and
 * emits deterministic @font-face CSS. Fonts are in V0 scope (rubric Gate 2):
 * every declaration must resolve to a cloned file or a recorded fallback.
 */

export type FontEntry = {
  family: string;
  weight: string;
  style: string;
  display: string;
  unicodeRange: string | null;
  localPaths: string[]; // resolved cloned font file paths, by format preference
  status: "resolved" | "fallback";
  reason: string | null;
};

export type FontGraph = {
  entries: FontEntry[];
  css: string; // @font-face blocks ready to inline in globals.css
};

const SYSTEM_FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function parseSrcUrls(src: string, sourceUrl: string): Array<{ url: string; format: string | null }> {
  const out: Array<{ url: string; format: string | null }> = [];
  const partRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(src)) !== null) {
    const raw = m[2]!;
    if (raw.startsWith("data:")) { out.push({ url: raw, format: m[4] ?? null }); continue; }
    let abs = raw;
    try { abs = new URL(raw, sourceUrl).href; } catch { /* keep raw */ }
    out.push({ url: abs, format: m[4] ?? null });
  }
  return out;
}

function basename(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  } catch {
    return url.slice(url.lastIndexOf("/") + 1).toLowerCase();
  }
}

const FORMAT_BY_EXT: Record<string, string> = {
  woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype", eot: "embedded-opentype",
};

export function buildFontGraph(fontFaces: FontFace[], assetGraph: AssetGraph, sourceUrl: string): FontGraph {
  // Index downloaded fonts by absolute URL and by basename for resilient lookup.
  const byBasename = new Map<string, AssetEntry>();
  for (const e of assetGraph.entries) {
    if (e.type === "font" && e.classification === "downloaded") {
      byBasename.set(basename(e.sourceUrl), e);
    }
  }

  const entries: FontEntry[] = [];
  const cssBlocks: string[] = [];
  const seen = new Set<string>();

  for (const ff of fontFaces) {
    const weight = (ff.weight || "400").trim();
    const style = (ff.style || "normal").trim();
    const display = (ff.display || "swap").trim();
    const key = `${ff.family}|${weight}|${style}|${ff.unicodeRange ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const srcs = parseSrcUrls(ff.src, sourceUrl);
    const resolved: Array<{ localPath: string; format: string }> = [];
    const dataUris: string[] = [];
    for (const s of srcs) {
      if (s.url.startsWith("data:")) { dataUris.push(s.url); continue; }
      const entry = assetGraph.byUrl.get(s.url) ?? byBasename.get(basename(s.url));
      if (entry?.classification === "downloaded" && entry.localPath) {
        const ext = (entry.localPath.split(".").pop() || "").toLowerCase();
        resolved.push({ localPath: entry.localPath, format: s.format || FORMAT_BY_EXT[ext] || "woff2" });
      }
    }

    // Prefer woff2 > woff > others for ordering.
    const order = ["woff2", "woff", "truetype", "opentype", "embedded-opentype"];
    resolved.sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format));

    if (resolved.length > 0 || dataUris.length > 0) {
      const srcParts: string[] = [];
      for (const r of resolved) srcParts.push(`url("${r.localPath}") format("${r.format}")`);
      for (const d of dataUris) srcParts.push(`url(${d})`);
      const block = [
        "@font-face {",
        `  font-family: "${ff.family}";`,
        `  font-style: ${style};`,
        `  font-weight: ${weight};`,
        `  font-display: ${display};`,
        `  src: ${srcParts.join(", ")};`,
        ff.unicodeRange ? `  unicode-range: ${ff.unicodeRange};` : null,
        "}",
      ].filter(Boolean).join("\n");
      cssBlocks.push(block);
      entries.push({
        family: ff.family, weight, style, display,
        unicodeRange: ff.unicodeRange ?? null,
        localPaths: resolved.map((r) => r.localPath),
        status: "resolved",
        reason: null,
      });
    } else {
      entries.push({
        family: ff.family, weight, style, display,
        unicodeRange: ff.unicodeRange ?? null,
        localPaths: [],
        status: "fallback",
        reason: "font_file_unavailable",
      });
    }
  }

  entries.sort((a, b) => `${a.family}${a.weight}${a.style}${a.unicodeRange}`.localeCompare(`${b.family}${b.weight}${b.style}${b.unicodeRange}`));
  return { entries, css: cssBlocks.join("\n\n") };
}

export { SYSTEM_FALLBACK };
