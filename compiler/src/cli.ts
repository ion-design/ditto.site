#!/usr/bin/env -S npx tsx
import { basename, dirname, join, resolve, sep } from "node:path";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { captureSite, REQUIRED_VIEWPORTS, SAMPLE_VIEWPORTS, type CaptureResult } from "./capture/capture.js";
import { fileURLToPath } from "node:url";
import { generateAll } from "./generate/pipeline.js";
import { refineSizing } from "./generate/refineSizing.js";
import { writeJSON, writeText, ensureDir, readJSON, fileExists } from "./util/fsx.js";
import { doneSummary, serveApp } from "./cliSummary.js";
import type { AppFramework } from "./generate/app.js";

export type CloneOptions = {
  url: string;
  runsDir?: string;
  viewports?: number[];
  reuseSource?: string; // path to an existing source/ dir to skip capture
  interactions?: boolean; // Stage 4 — capture & reproduce hover/focus states (opt-in)
  components?: boolean; // Stage 4.5 — extract repeated subtrees into components (opt-in)
  motion?: boolean; // Stage 5 — capture & replay motion (CSS @keyframes / WAAPI / rotating text)
  dense?: boolean; // capture intermediate/wide widths (SAMPLE_VIEWPORTS) to strengthen size inference
  humanizeMode?: "tailwind" | "css"; // styling output — Tailwind utilities (default) or semantic CSS
  framework?: AppFramework; // output framework — Next.js App Router (default) or Vite React
  outDir?: string; // write a clean <outDir>/<siteName>/{app,.clone} layout instead of runs/<id>/<ts>
  refineSizing?: boolean; // iterate render→regen until the clone-probe converges (proxy mode)
  reflow?: boolean; // Reflow trade: flow all heights (cleaner code,
                    // content re-positions between breakpoints; backstopped by the perceptual gate).
                    // ON by default at the CLI (--no-reflow to disable); persisted per-run in clone-options.json.
  screenshots?: boolean; // capture per-viewport screenshots (default on); --no-screenshots skips them for a
                         // faster production clone (validation-only artifact — generation ignores pixels).
  log?: (event: Record<string, unknown>) => void;
};

export type CloneResult = {
  runDir: string;
  sourceDir: string;
  appDir: string;
  sourceUrl: string;
  /** A stable, timestamp-free path to the app (via the `runs/<site>/latest` symlink),
   *  present in runs-layout mode when the symlink could be created. */
  stableAppDir?: string;
  /** Visual assets (image/svg/video) that could not be downloaded — those boxes render
   *  as placeholders. Surfaced in the CLI summary; details in generated/assets.json. */
  visualAssetsMissing?: number;
};

export function siteIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    return (host + (path ? "-" + path : "")).replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 80);
  } catch {
    return "site-" + url.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);
  }
}

// Common multi-part public suffixes — not exhaustive, covers the frequent ones; anything
// else is treated as a single-chunk TLD.
const MULTIPART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz",
  "co.za", "co.jp", "or.jp", "ne.jp", "com.br", "com.mx", "com.ar", "com.sg", "com.hk",
  "co.in", "co.kr", "com.tr", "com.cn",
]);
/** A short, human folder name for a site: the registrable domain's main label, minus
 *  `www.` and the TLD — `www.ion.design` → `ion`, `blog.example.co.uk` → `example`,
 *  `blog.example.co.uk` → `example`. Falls back to the full slug for non-host URLs
 *  (e.g. file://) so it's always a valid, non-empty directory name. */
export function siteName(url: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* not a URL */ }
  host = host.replace(/^www\./i, "");
  const labels = host.split(".").filter(Boolean);
  let name = "";
  if (labels.length <= 1) name = labels[0] ?? "";
  else {
    const tldParts = MULTIPART_TLDS.has(labels.slice(-2).join(".")) ? 2 : 1;
    name = labels[labels.length - 1 - tldParts] ?? labels[0]!;
  }
  name = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return name || siteIdFromUrl(url);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** `--out` layout: a clean, predictable `<outDir>/<siteName>/` folder holding the
 *  deliverable app at `app/` and the reusable working artifacts (capture/IR/validation)
 *  under `.clone/` — so a later `clone-site --out` can expand into the full site without
 *  re-capturing page 1. Single + multi clones of the same site share this folder. */
export function namedOutDirs(outDir: string, url: string): { namedDir: string; runDir: string; appDir: string } {
  const namedDir = join(resolve(outDir), siteName(url));
  return { namedDir, runDir: join(namedDir, ".clone"), appDir: join(namedDir, "app") };
}
/** Publish the freshly-generated app to the deliverable `app/` dir (replacing any prior). */
export function exportApp(generatedAppDir: string, appOutDir: string): { removed: number; kept: number } {
  rmSync(appOutDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  cpSync(generatedAppDir, appOutDir, { recursive: true });
  rmSync(join(appOutDir, ".next"), { recursive: true, force: true });
  rmSync(join(appOutDir, "out"), { recursive: true, force: true });
  rmSync(join(appOutDir, "node_modules"), { recursive: true, force: true });
  return stripDeliveryDataCids(appOutDir);
}

/** Strip the validation-only `data-cid` plumbing from the SHIPPED app. The compiler keeps
 *  `data-cid` on every node in `.clone/generated` so the fidelity grader can align the clone
 *  to the source. The deliverable should not expose those probe ids. Runtime/CSS references
 *  that still need a DOM anchor are rewritten to semantic `data-ditto-id` values; extracted
 *  component `cids` arrays become typed `ditto-meta` anchor objects. */
export function stripDeliveryDataCids(appDir: string): { removed: number; kept: number } {
  const srcDir = join(appDir, "src");
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (existsSync(srcDir)) walk(srcDir);
  const walkHtml = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "src" || name === "public" || name === "node_modules" || name === ".next" || name === "out" || name === "dist") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walkHtml(p);
      else if (name.endsWith(".html")) files.push(p);
    }
  };
  if (existsSync(appDir)) walkHtml(appDir);
  if (!files.length) return { removed: 0, kept: 0 };

  const isCodeFile = (f: string): boolean => /\.(tsx|jsx|ts)$/.test(f);
  const isJsxFile = (f: string): boolean => /\.(tsx|jsx)$/.test(f);
  const isHtmlFile = (f: string): boolean => /\.html$/.test(f);
  const exactCidStringRe = /"([A-Za-z]*n\d+)"/g;
  const hintByCid = collectDeliveryCidHints(files);
  const anchors = new Map<string, { name: string; kind: string }>();
  const usedAnchors = new Set<string>();
  const counters = new Map<string, number>();
  const anchorFor = (cid: string, kind: string): string => {
    const existing = anchors.get(cid);
    if (existing) return existing.name;
    const hint = hintByCid.get(cid);
    const numbered = (base: string): string => {
      const clean = slug(base) || kind;
      let out = clean;
      let n = 2;
      while (usedAnchors.has(out)) out = `${clean}-${n++}`;
      usedAnchors.add(out);
      return out;
    };
    const base = hint ? `${kind}-${hint}` : `${kind}-${(counters.get(kind) ?? 0) + 1}`;
    counters.set(kind, (counters.get(kind) ?? 0) + 1);
    const name = numbered(base);
    anchors.set(cid, { name, kind });
    return name;
  };

  // Runtime refs first, so an element used by both runtime and CSS gets a meaningful
  // anchor (`motion-*`, `menu-trigger-*`) instead of a generic stylesheet name.
  for (const f of files) {
    if (!isCodeFile(f) && !f.endsWith(".css") && !isHtmlFile(f)) continue;
    const text = readFileSync(f, "utf8");
    if (isCodeFile(f)) {
      for (const line of text.split("\n")) {
        if (line.includes("<DittoMotion")) {
          for (const m of line.matchAll(exactCidStringRe)) anchorFor(m[1]!, "motion");
        } else if (line.includes("<DittoLottie")) {
          for (const m of line.matchAll(exactCidStringRe)) anchorFor(m[1]!, "lottie");
        } else if (line.includes("<DittoWire") || line.includes("<Accordion")) {
          for (const m of line.matchAll(exactCidStringRe)) anchorFor(m[1]!, "interaction");
        } else if (line.includes("<DropdownMenu")) {
          for (const m of line.matchAll(/"trigger":\s*"([^"]+)"/g)) anchorFor(m[1]!, "menu-trigger");
        }
      }
      for (const m of text.matchAll(/"(?:trigger|region|panel|track|next|prev)":\s*"([A-Za-z]*n\d+)"/g)) anchorFor(m[1]!, "interaction");
    }
    if (f.endsWith(".css")) for (const m of text.matchAll(/\[data-cid="([^"]+)"\]/g)) anchorFor(m[1]!, "style");
  }

  let removed = 0, kept = 0;
  const cidsFile = files.find((f) => basename(f) === "_cids.ts");
  let componentsWithMetaAnchors = new Set<string>();
  let metaAnchorIndexes = new Map<string, Set<number>>();
  if (cidsFile) {
    const text = readFileSync(cidsFile, "utf8");
    const meta = rewriteCidsModuleToMeta(text, (cid) => anchors.get(cid)?.name ?? null, (hasAnchor) => {
      if (hasAnchor) kept++; else removed++;
    });
    componentsWithMetaAnchors = meta.componentsWithAnchors;
    metaAnchorIndexes = meta.anchorIndexesByComponent;
    const metaPath = join(dirname(cidsFile), "ditto-meta.ts");
    if (componentsWithMetaAnchors.size) writeFileSync(metaPath, pruneCloneMetaModule(meta.text, componentsWithMetaAnchors));
    else rmSync(metaPath, { force: true });
    rmSync(cidsFile, { force: true });
  }

  for (const f of files) {
    if (!existsSync(f) || (!isCodeFile(f) && !f.endsWith(".css") && !isHtmlFile(f))) continue;
    const text = readFileSync(f, "utf8");
    let next = text;
    if (f.endsWith(".css")) {
      next = next.replace(/\[data-cid="([^"]+)"\]/g, (_full, cid: string) => `[data-ditto-id="${anchors.get(cid)?.name ?? anchorFor(cid, "style")}"]`);
    }
    if (isHtmlFile(f)) {
      next = next.replace(/\sdata-cid="([^"]+)"/g, (_full, cid: string) => {
        const anchor = anchors.get(cid)?.name;
        if (anchor) { kept++; return ` data-ditto-id="${anchor}"`; }
        removed++; return "";
      });
    }
    if (isCodeFile(f)) {
      next = rewriteDeliveryImportsAndMeta(next, componentsWithMetaAnchors);
      next = rewriteRuntimeAnchorQueries(next, basename(f));
      if (/\bDittoMotion\b|\bDittoLottie\b/.test(next)) next = next.replace(/"cid":/g, '"anchor":');
      next = next.replace(/\sdata-cid="([^"]+)"/g, (_full, cid: string) => {
        const anchor = anchors.get(cid)?.name;
        if (anchor) { kept++; return ` data-ditto-id="${anchor}"`; }
        removed++; return "";
      });
      if (isJsxFile(f)) {
        next = rewriteComponentMetaAttrs(next, componentsWithMetaAnchors, metaAnchorIndexes);
        next = rewriteSvgDittoIdProps(next, (cid) => anchors.get(cid)?.name ?? null, (hasAnchor) => {
          if (hasAnchor) kept++; else removed++;
        });
      }
      next = next.replace(exactCidStringRe, (full, cid: string) => {
        const anchor = anchors.get(cid)?.name;
        return anchor ? JSON.stringify(anchor) : full;
      });
    }
    if (next !== text) writeFileSync(f, next);
  }
  pruneUnusedSvgDittoIds(files);
  return { removed, kept };
}

function collectDeliveryCidHints(files: string[]): Map<string, string> {
  const hints = new Map<string, string>();
  for (const f of files) {
    if (!/\.(tsx|jsx)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    const tagRe = /<([A-Za-z][\w:-]*)\b[^>]*\sdata-cid="([^"]+)"[^>]*>/g;
    for (const m of text.matchAll(tagRe)) {
      const tag = m[0]!;
      const tagName = m[1]!;
      const cid = m[2]!;
      const attr = (name: string): string => {
        const a = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
        return a?.[1] ?? a?.[2] ?? "";
      };
      const hint = attr("id") || attr("aria-label") || attr("data-component") || tagName;
      if (!hints.has(cid)) hints.set(cid, slug(hint));
    }
  }
  return hints;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
}

function rewriteCidsModuleToMeta(
  text: string,
  anchorOf: (cid: string) => string | null,
  count: (hasAnchor: boolean) => void,
): { text: string; componentsWithAnchors: Set<string>; anchorIndexesByComponent: Map<string, Set<number>> } {
  const componentsWithAnchors = new Set<string>();
  const anchorIndexesByComponent = new Map<string, Set<number>>();
  const rows = text.replace(/export const ([A-Za-z_$][\w$]*)_cids(\d*): string\[\]\[\] = ([\s\S]*?);/g, (_full, name: string, suffix: string, body: string) => {
    let hasAnchor = false;
    const indexSet = anchorIndexesByComponent.get(name) ?? new Set<number>();
    anchorIndexesByComponent.set(name, indexSet);
    let sourceRows: string[][] = [];
    try { sourceRows = JSON.parse(body) as string[][]; } catch { sourceRows = []; }
    const metaBody = sourceRows.map((row) => {
      const entries: string[] = [];
      row.forEach((cid, idx) => {
        const anchor = anchorOf(cid);
        count(!!anchor);
        if (!anchor) return;
        hasAnchor = true;
        indexSet.add(idx);
        entries.push(`${idx}: { anchor: ${JSON.stringify(anchor)} }`);
      });
      return `{ ${entries.join(", ")} }`;
    }).join(",\n    ");
    if (hasAnchor) componentsWithAnchors.add(name);
    return `export const ${name}_meta${suffix}: DittoNodeMetaMap[] = [\n    ${metaBody}\n];`;
  });
  return {
    text: `// Per-instance Ditto metadata. Validation-only node ids stay in .clone/generated.\nexport type DittoNodeMeta = { anchor?: string };\nexport type DittoNodeMetaMap = Record<number, DittoNodeMeta | undefined>;\n\n${rows.replace(/^\/\/.*\n\n?/, "")}`,
    componentsWithAnchors,
    anchorIndexesByComponent,
  };
}

function pruneCloneMetaModule(text: string, componentsWithAnchors: Set<string>): string {
  return text.replace(/export const ([A-Za-z_$][\w$]*)_meta(\d*): DittoNodeMetaMap\[] = [\s\S]*?;\n?/g, (full, name: string) => (
    componentsWithAnchors.has(name) ? full : ""
  ));
}

function metaVarComponent(varName: string): string | null {
  const m = /^([A-Za-z_$][\w$]*)_meta\d*$/.exec(varName);
  return m?.[1] ?? null;
}

function keepMetaVar(varName: string, componentsWithAnchors: Set<string>): boolean {
  const comp = metaVarComponent(varName);
  return !!comp && componentsWithAnchors.has(comp);
}

function rewriteDeliveryImportsAndMeta(text: string, componentsWithAnchors: Set<string>): string {
  let next = text
    .replace(/(["'])((?:\.\.?\/)+)_cids\1/g, (_full, q: string, rel: string) => `${q}${rel}ditto-meta${q}`)
    .replace(/\b([A-Za-z_$][\w$]*)_cids(\d*)\b/g, "$1_meta$2")
    .replace(/\bcids=/g, "meta=")
    .replace(/\bcids\b/g, "meta")
    .replace(/\bmeta:\s*string\[\]/g, "meta: DittoNodeMetaMap");
  next = next.replace(/^import \{ ([^}]+) \} from ["']((?:\.\.?\/)+ditto-meta)["'];\n?/gm, (_full, specs: string, rel: string) => {
    const kept = specs.split(",").map((s) => s.trim()).filter((s) => keepMetaVar(s, componentsWithAnchors));
    return kept.length ? `import { ${kept.join(", ")} } from "${rel}";\n` : "";
  });
  next = next.replace(/\smeta=\{([A-Za-z_$][\w$]*_meta\d*)\[i\]\}/g, (full, varName: string) => (
    keepMetaVar(varName, componentsWithAnchors) ? full : ""
  ));
  return next;
}

function rewriteComponentMetaAttrs(text: string, componentsWithAnchors: Set<string>, anchorIndexesByComponent: Map<string, Set<number>>): string {
  let next = text.replace(/\sdata-(?:cid|clone-id|ditto-id)=\{meta\[(\d+)\]\}/g, (_full, idx: string) => ` data-ditto-id={meta[${idx}]?.anchor}`);
  const comp = /export default function ([A-Za-z_$][\w$]*)\(/.exec(next)?.[1];
  if (comp && !componentsWithAnchors.has(comp)) {
    next = next
      .replace(/\sdata-ditto-id=\{meta\[\d+\]\?\.anchor\}/g, "")
      .replace(/\{ d, meta, styles \}/g, "{ d, styles }")
      .replace(/\{ d, meta \}/g, "{ d }")
      .replace(/;\s*meta:\s*(?:Clone|Ditto)NodeMeta(?:Map|\[\])/g, "")
      .replace(/import type \{ DittoNodeMetaMap \} from ["'][.]{2}\/ditto-meta["'];\n?/g, "");
  } else if (comp) {
    const keepIndexes = anchorIndexesByComponent.get(comp) ?? new Set<number>();
    next = next.replace(/\sdata-ditto-id=\{meta\[(\d+)\]\?\.anchor\}/g, (full, idx: string) => (
      keepIndexes.has(Number(idx)) ? full : ""
    ));
  }
  if (next.includes("DittoNodeMetaMap") && !/import type \{ DittoNodeMetaMap \} from ["'][.]{2}\/ditto-meta["'];/.test(next)) {
    next = `import type { DittoNodeMetaMap } from "../ditto-meta";\n${next}`;
  }
  return next;
}

function rewriteSvgDittoIdProps(text: string, anchorOf: (cid: string) => string | null, count: (hasAnchor: boolean) => void): string {
  let next = text
    .replace(/\(\{ cid \}: \{ cid\?: string \}\)/g, "({ dittoId }: { dittoId?: string })")
    .replace(/\sdata-(?:cid|clone-id|ditto-id)=\{cid\}/g, " data-ditto-id={dittoId}");
  next = next.replace(/\scid=\{\s*"([^"]+)"\s*\}/g, (_full, cid: string) => {
    const anchor = anchorOf(cid);
    if (anchor) {
      count(true);
      return ` dittoId={${JSON.stringify(anchor)}}`;
    }
    if (!/^[A-Za-z]*n\d+$/.test(cid)) return ` dittoId={${JSON.stringify(cid)}}`;
    count(false);
    return "";
  });
  next = next.replace(/\scid=\{([^}]+)\}/g, (_full, expr: string) => ` dittoId={${expr}}`);
  return next;
}

function pruneUnusedSvgDittoIds(files: string[]): void {
  const hasDittoIdUse = files.some((f) => {
    if (!existsSync(f) || !/\.(tsx|jsx)$/.test(f) || f.includes(`${sep}svgs${sep}`)) return false;
    return /\sdittoId=\{/.test(readFileSync(f, "utf8"));
  });
  if (hasDittoIdUse) return;
  for (const f of files) {
    if (!existsSync(f) || !f.includes(`${sep}svgs${sep}`) || !/\.(tsx|jsx)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    const next = text
      .replace(/export default function ([A-Za-z_$][\w$]*)\(\{ dittoId \}: \{ dittoId\?: string \}\)/g, "export default function $1()")
      .replace(/\sdata-ditto-id=\{dittoId\}/g, "");
    if (next !== text) writeFileSync(f, next);
  }
}

function rewriteRuntimeAnchorQueries(text: string, fileName: string): string {
  if (!/^(?:DittoMotion|DittoLottie|DittoWire|DropdownMenu|Accordion)\.tsx$/.test(fileName)) return text;
  let next = text
    .replace(/\bbyCid\b/g, "byDittoId")
    .replace(/const byDittoId = \(cid: string\): HTMLElement \| null => document\.querySelector\('\[data-cid="' \+ cid \+ '"\]'\);/g,
      `const byDittoId = (id: string): HTMLElement | null => document.querySelector('[data-ditto-id="' + id + '"]');`)
    .replace(/data-cid/g, "data-ditto-id");
  if (fileName === "DittoMotion.tsx" || fileName === "DittoLottie.tsx") {
    next = next
      .replace(/\bcid: string/g, "anchor: string")
      .replace(/\.cid\b/g, ".anchor");
  } else if (fileName === "DittoWire.tsx") {
    next = next
      .replace(/cid → style/g, "anchor → style")
      .replace(/for \(const cid in d\) applyStyle\(byDittoId\(cid\), d\[cid\]\);/g, "for (const anchor in d) applyStyle(byDittoId(anchor), d[anchor]);");
  }
  return next;
}

/** Run the deterministic compiler end-to-end. Capture is skippable via reuseSource. */
export async function runClone(opts: CloneOptions): Promise<CloneResult> {
  // The size-inference SAMPLE set. Defaults to the standard 4 (band) widths; pass `--dense` to
  // also capture intermediate/wide widths (SAMPLE_VIEWPORTS) — the IR feeds those to width
  // inference while still emitting bands only at the standard breakpoints. NOTE: dense capture
  // makes the inference STRICTER (verified at more widths → fewer false relatives), which is more
  // correct but currently nets slightly MORE baked px until container-level natural-size recovery
  // lands; left opt-in for now. A --viewports override sets both sets explicitly.
  const captureViewports = opts.viewports ?? (opts.dense ? [...SAMPLE_VIEWPORTS] : [...REQUIRED_VIEWPORTS]);
  const viewports = opts.viewports ?? [...REQUIRED_VIEWPORTS];
  const log = opts.log ?? (() => {});
  const runsDir = opts.runsDir ?? resolve(process.cwd(), "..", "runs");
  const siteId = siteIdFromUrl(opts.url);
  // --out: predictable <outDir>/<siteName>/.clone working dir + app/ deliverable.
  const out = opts.outDir ? namedOutDirs(opts.outDir, opts.url) : null;
  const runDir = out ? out.runDir : join(runsDir, siteId, timestamp());
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const appDir = join(generatedDir, "app");
  ensureDir(runDir);
  ensureDir(join(runDir, "logs"));

  const logEvents: Record<string, unknown>[] = [];
  const logBoth = (e: Record<string, unknown>) => { logEvents.push(e); log(e); };

  writeJSON(join(runDir, "input.json"), { url: opts.url, siteId, viewports, sampleViewports: captureViewports, startedAt: new Date().toISOString() });

  // 1. Capture (or reuse)
  let capture: CaptureResult;
  if (opts.reuseSource && fileExists(join(opts.reuseSource, "capture", "capture-result.json"))) {
    logBoth({ event: "capture_reuse", from: opts.reuseSource });
    capture = readJSON<CaptureResult>(join(opts.reuseSource, "capture", "capture-result.json"));
    // Copy reuseSource contents would be ideal; instead, point sourceDir at it via re-read.
    // For simplicity the IR is built from reuseSource and other artifacts written into runDir.
    copySourceRef(opts.reuseSource, sourceDir);
  } else {
    capture = await captureSite({ url: opts.url, outDir: sourceDir, viewports: captureViewports, interactions: opts.interactions, motion: opts.motion, screenshots: opts.screenshots, log: logBoth });
  }

  // Stage 4.5: persist the component-extraction choice in the source dir so every
  // generateAll for this run (deliverable + determinism/prune regens, possibly in a
  // separate validate process) reads the same flag and stays deterministic.
  writeJSON(join(sourceDir, "clone-options.json"), { components: !!opts.components, ...(opts.humanizeMode ? { humanizeMode: opts.humanizeMode } : {}), ...(opts.framework ? { framework: opts.framework } : {}), reflow: !!opts.reflow });

  // 2-5. Normalize → infer → generate → emit (shared deterministic pipeline)
  const gen = generateAll({ sourceDir, capture, viewports, sampleViewports: captureViewports, url: opts.url, outDir: generatedDir });
  logBoth({ event: "ir_built", nodes: gen.ir.doc.nodeCount });
  logBoth({ event: "inferred", sections: gen.sections.length, assets: gen.assetGraph.entries.length, fonts: gen.fontGraph.entries.length });
  const visualAssetsMissing = gen.assetGraph.entries.filter((e) => e.impact === "visual_missing").length;
  logBoth({ event: "generated", assetsCopied: gen.assetsCopied, assetsMissing: gen.assetsMissing.length, visualAssetsMissing });

  // When the source capture lacks native probe flags (this sandbox can't reach the
  // live site through the egress proxy), optionally iterate render→regen so the LOCAL clone-probe
  // converges. A no-op with a real source-probe (the source layout is fixed → one pass).
  if (opts.refineSizing) {
    const harness = fileURLToPath(new URL("../.harness", import.meta.url));
    const res = await refineSizing(runDir, harness, { maxIters: 4, log: logBoth });
    logBoth({ event: "refine_sizing_done", ...res });
  }

  writeText(join(runDir, "logs", "compiler.log.jsonl"), logEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");

  let stableAppDir: string | undefined;
  if (out) {
    // Publish the deliverable to <siteName>/app; keep working artifacts in .clone.
    exportApp(appDir, out.appDir);
    logBoth({ event: "exported", app: out.appDir });
  } else {
    // latest pointer (runs/ layout, used by --reuse / regen) + a `latest` symlink so the
    // app has a stable, timestamp-free path that survives copy-paste.
    stableAppDir = writeLatestPointer(runsDir, siteId, runDir);
  }

  return { runDir, sourceDir, appDir: out ? out.appDir : appDir, sourceUrl: opts.url, stableAppDir, visualAssetsMissing };
}

/** Record the newest run for a site in the runs layout: a `latest.json` breadcrumb (used by
 *  `--reuse`/regen) and a `latest` symlink → runDir. Returns the stable app path when the
 *  symlink was created (symlinks can be unavailable, e.g. Windows without privilege — non-fatal). */
export function writeLatestPointer(runsDir: string, siteId: string, runDir: string): string | undefined {
  writeJSON(join(runsDir, siteId, "latest.json"), { runDir, ts: timestamp() });
  const link = join(runsDir, siteId, "latest");
  try {
    // Refresh an existing symlink; refuse (via non-recursive rm) to clobber a real directory.
    rmSync(link, { force: true });
    symlinkSync(runDir, link, "junction");
    return join(link, "generated", "app");
  } catch {
    return undefined;
  }
}

function copySourceRef(from: string, to: string): void {
  // Symlink-free copy of the whole source dir for self-contained runs.
  if (resolve(from) === resolve(to)) return;
  ensureDir(to);
  cpSync(from, to, { recursive: true });
}

/** Latest prior run's source/ dir for a URL (for --reuse: regenerate, skip capture). */
export function latestSourceDir(runsDir: string, url: string): string | null {
  const siteDir = join(runsDir, siteIdFromUrl(url));
  if (!existsSync(siteDir)) return null;
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const src = join(siteDir, runs[i]!, "source");
    if (fileExists(join(src, "capture", "capture-result.json"))) return src;
  }
  return null;
}

// ---- CLI ----
type ProductMode = "single" | "multi";
type ProductStyling = "tailwind" | "css";
type ProductFramework = AppFramework;

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
}

function firstFlagValue(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const value = flagValue(args, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasAnyFlag(args: string[], names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

function parseProductMode(args: string[]): ProductMode {
  const raw = flagValue(args, "--mode");
  if (!raw) return "single";
  if (raw === "single" || raw === "multi") return raw;
  throw new Error(`invalid --mode=${raw}; expected "single" or "multi"`);
}

function parseProductStyling(args: string[]): ProductStyling {
  const raw = flagValue(args, "--styling");
  if (raw) {
    if (raw === "tailwind" || raw === "css") return raw;
    throw new Error(`invalid --styling=${raw}; expected "tailwind" or "css"`);
  }
  return args.includes("--css") ? "css" : "tailwind";
}

function parseProductFramework(args: string[]): ProductFramework {
  const raw = flagValue(args, "--framework");
  if (raw) {
    if (raw === "next" || raw === "vite") return raw;
    throw new Error(`invalid --framework=${raw}; expected "next" or "vite"`);
  }
  return args.includes("--vite") ? "vite" : "next";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: clone-static <url> [--mode=single|multi] [--styling=tailwind|css] [--framework=next|vite] [--out=<dir>] [--serve] [--open]");
    process.exit(1);
  }
  const mode = parseProductMode(args);
  const styling = parseProductStyling(args);
  const framework = parseProductFramework(args);
  // --serve installs deps + starts the dev server after cloning; --open also launches the browser.
  const open = hasAnyFlag(args, ["--open"]);
  const serve = open || hasAnyFlag(args, ["--serve"]);
  const finish = async (res: { appDir: string; stableAppDir?: string; visualAssetsMissing?: number }) => {
    if (serve) {
      await serveApp(res.appDir, { open });
    } else {
      process.stderr.write(doneSummary({ url, appDir: res.appDir, framework, stableAppDir: res.stableAppDir, visualAssetsMissing: res.visualAssetsMissing }));
    }
  };
  const vpArg = firstFlagValue(args, ["--dev-viewports", "--viewports"]);
  const runsArg = firstFlagValue(args, ["--dev-runs", "--runs"]);
  // --out=<dir>: clean <dir>/<siteName>/{app,.clone} layout (default: ./output when bare --out).
  const outArg = args.find((a) => a === "--out" || a.startsWith("--out="));
  const outDir = outArg ? (outArg.includes("=") ? outArg.split("=")[1] : "output") : undefined;
  const viewports = vpArg ? vpArg.split(",").map((s) => parseInt(s, 10)) : undefined;
  // Best-by-default: interactions (Stage 4) and component extraction (Stage 4.5) are
  // ON unless explicitly disabled. Both are safe — interactions apply nothing on mount
  // and are gate-pruned; extraction is render-identical — so the base clone is unchanged.
  const interactions = !hasAnyFlag(args, ["--dev-no-interactions", "--no-interactions"]);
  const components = !hasAnyFlag(args, ["--dev-no-components", "--no-components"]);
  const motion = !hasAnyFlag(args, ["--dev-no-motion", "--no-motion"]);
  const dense = hasAnyFlag(args, ["--dev-dense", "--dense"]);
  const refineSizingFlag = hasAnyFlag(args, ["--dev-refine-sizing", "--refine-sizing"]);
  // Reflow trade is ON by default (flow all heights → cleaner code; content re-positions between
  // breakpoints, backstopped by the perceptual/layout gates). Pass --no-reflow for sites where it
  // hurts mobile fidelity.
  const reflow = !hasAnyFlag(args, ["--dev-no-reflow", "--no-reflow"]);
  // Screenshots are a validation-only artifact (generation never reads pixels); --no-screenshots skips
  // the per-viewport full-page shots — the dominant capture cost on tall pages — for a faster production clone.
  const screenshots = !hasAnyFlag(args, ["--dev-no-screenshots", "--no-screenshots"]);
  const runsDir = runsArg ? resolve(runsArg) : resolve(process.cwd(), "..", "runs");
  // --reuse: regenerate from the latest existing capture (skip the browser pass).
  const reuseSource = hasAnyFlag(args, ["--dev-reuse", "--reuse"]) ? latestSourceDir(runsDir, url) ?? undefined : undefined;

  if (mode === "multi") {
    const { runCloneSite } = await import("./site/cloneSite.js");
    const maxRoutes = firstFlagValue(args, ["--dev-max-routes", "--max-routes"]);
    const maxCollection = firstFlagValue(args, ["--dev-max-collection", "--max-collection"]);
    const maxDepth = firstFlagValue(args, ["--dev-depth", "--depth"]);
    const concurrency = firstFlagValue(args, ["--dev-concurrency", "--concurrency"]);
    const validationConcurrency = firstFlagValue(args, ["--dev-validate-concurrency", "--validate-concurrency", "--validation-concurrency"]);
    const viewportConcurrency = firstFlagValue(args, ["--dev-viewport-concurrency", "--viewport-concurrency"]);
    const tier = firstFlagValue(args, ["--dev-tier", "--tier"]);
    const validate = hasAnyFlag(args, ["--dev-validate", "--validate"]) && !hasAnyFlag(args, ["--dev-no-validate", "--no-validate"]);
    const res = await runCloneSite({
      url,
      runsDir,
      maxRoutes: maxRoutes ? parseInt(maxRoutes, 10) : undefined,
      maxCollectionInstances: maxCollection ? parseInt(maxCollection, 10) : undefined,
      maxDepth: maxDepth ? parseInt(maxDepth, 10) : undefined,
      captureConcurrency: concurrency ? parseInt(concurrency, 10) : undefined,
      validationConcurrency: validationConcurrency ? parseInt(validationConcurrency, 10) : undefined,
      viewportConcurrency: viewportConcurrency ? parseInt(viewportConcurrency, 10) : undefined,
      validate,
      interactions,
      components,
      humanizeMode: styling,
      framework,
      reflow,
      screenshots: validate && screenshots,
      outDir,
      tier,
      log: (e) => console.log(JSON.stringify(e)),
    });
    console.log(JSON.stringify({ event: "done", runDir: res.runDir, app: res.appDir, stableApp: res.stableAppDir }));
    await finish(res);
    return;
  }

  const res = await runClone({
    url,
    viewports,
    runsDir,
    interactions,
    components,
    motion,
    dense,
    refineSizing: refineSizingFlag,
    reflow,
    screenshots,
    humanizeMode: styling,
    framework,
    outDir,
    reuseSource,
    log: (e) => console.log(JSON.stringify(e)),
  });
  console.log(JSON.stringify({ event: "done", runDir: res.runDir, app: res.appDir, stableApp: res.stableAppDir }));
  await finish(res);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}