/**
 * Delivery cleanup — the pass that turns a raw generated app into the SHIPPED app.
 *
 * The compiler keeps validation-only `data-cid` probe ids on every node in
 * `.clone/generated` so the fidelity grader can align the clone to the source.
 * Deliverables must not expose those probe ids, so this pass strips them and
 * rewrites the runtime/CSS references that still need a DOM anchor to semantic
 * `data-ditto-id` values (see `stripDeliveryDataCids`).
 *
 * Shared seam: the CLI `--out` path (exportApp from cli.ts / cloneSite.ts /
 * runner/regen.ts) and the service path (packages/core collectDeliveryFileMap)
 * both ship apps through this module, so both deliver byte-identical output.
 *
 * The pass is idempotent: re-running it on an already-cleaned app is a no-op
 * (guarded explicitly for the extracted-component meta rewrites, which would
 * otherwise strip kept anchors on a second run — see `metaAlreadyClean`).
 */
import { basename, dirname, join, sep } from "node:path";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

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
  // Idempotency guard: an already-cleaned app has a `ditto-meta.ts` module but no
  // `_cids.ts`. Re-running the component-meta rewrites in that state would strip
  // every kept anchor and import (componentsWithMetaAnchors is empty without
  // `_cids.ts`), so skip them — every other rewrite is naturally a no-op on
  // cleaned output. First runs are unaffected: with `_cids.ts` present the guard
  // is false, and without any meta plumbing the rewrites match nothing.
  const metaAlreadyClean = !cidsFile && files.some((f) => basename(f) === "ditto-meta.ts");
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
      if (!metaAlreadyClean) next = rewriteDeliveryImportsAndMeta(next, componentsWithMetaAnchors);
      next = rewriteRuntimeAnchorQueries(next, basename(f));
      if (/\bDittoMotion\b|\bDittoLottie\b/.test(next)) next = next.replace(/"cid":/g, '"anchor":');
      next = next.replace(/\sdata-cid="([^"]+)"/g, (_full, cid: string) => {
        const anchor = anchors.get(cid)?.name;
        if (anchor) { kept++; return ` data-ditto-id="${anchor}"`; }
        removed++; return "";
      });
      if (isJsxFile(f)) {
        if (!metaAlreadyClean) next = rewriteComponentMetaAttrs(next, componentsWithMetaAnchors, metaAnchorIndexes);
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
