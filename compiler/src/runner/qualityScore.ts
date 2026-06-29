/**
 * Output-quality rubric (deterministic, framework-agnostic).
 *
 * The fidelity gates (validate/gates.ts) measure whether the clone *looks and
 * behaves* like the source. They say nothing about whether the generated CODE is
 * good — componentized, semantically named, styled through a reusable token/class
 * system, editable, and well organized. That "developer-facing quality" is exactly
 * where a deterministic converter is judged once fidelity is a given.
 *
 * This module statically analyzes a generated app directory and scores it 0–100 on
 * six categories. It reads only source text (`.tsx/.jsx/.ts/.astro/.css`). The
 * metrics are chosen to be framework-agnostic: e.g. "style reuse" rewards shared
 * classes whether they're Tailwind utilities or semantic clone classes, and
 * penalizes per-node unique rules (`.c1{...} .c2{...}`) regardless of framework.
 *
 * Pure + deterministic: same directory ⇒ same score.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".next", "out", "dist", ".git", ".wrangler", ".astro", "public", ".harness", ".harness2"]);
const CODE_EXT = new Set([".tsx", ".jsx", ".ts", ".astro", ".css"]);

export type SrcFile = { path: string; rel: string; ext: string; text: string; lines: number };

export function collectFiles(root: string): SrcFile[] {
  const out: SrcFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      if (name.startsWith("._")) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue; }
      const ext = extname(name).toLowerCase();
      if (!CODE_EXT.has(ext)) continue;
      if (name.endsWith(".d.ts")) continue;
      let text = "";
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      out.push({ path: p, rel: relative(root, p), ext, text, lines: text.split("\n").length });
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Primitive extraction
// ---------------------------------------------------------------------------

const CONFIG_NAME_RE = /(config|tsconfig|next-env|site-config|content\.config|\.config\.)/i;
const ROOT_NAME_RE = /(^|\/)(layout|_app|_document|root-layout)\.[jt]sx$/i;
/** Files that compose the whole page (the "entry"): page.tsx (Next), index/page in a
 *  pages/ dir, home.tsx, or an .astro route shell. Used for the dominance metric. */
function isEntryFile(rel: string): boolean {
  const b = basename(rel).toLowerCase();
  if (/^(page|index|home|app)\.[jt]sx$/.test(b)) return true;
  if (rel.includes("/pages/") && b.endsWith(".astro")) return true;
  if (b === "index.astro" || b === "[...slug].astro" || b === "404.astro") return true;
  return false;
}

const SECTION_WORDS = ["hero", "footer", "navbar", "nav", "header", "about", "cta", "feature", "pricing", "faq", "logo", "logocloud", "testimonial", "gallery", "stories", "spotlight", "knowledge", "news", "apply", "contact", "banner", "team", "stats", "partners", "alumni", "founder", "section"];

/** Count JSX/HTML opening element tags — a framework-agnostic proxy for page size
 *  (how many DOM nodes the output describes). Excludes React fragments + closing tags. */
function countTags(text: string): number {
  const m = text.match(/<[a-zA-Z][a-zA-Z0-9.]*(\s|\/|>)/g);
  return m ? m.length : 0;
}

/** All className / class string-literal tokens used on elements (space split).
 *  Catches JSX attribute form (className="…"), object/spread form (className: "…" —
 *  what our generator emits), and hoisted className consts. A dynamic per-node class
 *  (className: "c" + d._cid / className={"c"+…}) renders a UNIQUE opaque class per
 *  instance, so each occurrence is recorded as its own opaque token (keeping the
 *  reuse + semantic metrics honest for the per-node-CSS strategy). */
function classTokens(text: string): string[] {
  const out: string[] = [];
  // className="..."  /  className: "..."  /  "class": "..."  (attr + object form)
  const re = /\b(?:className|class)\s*(?:=|:)\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const t of m[1]!.split(/\s+/)) if (t) out.push(t);
  }
  // hoisted className consts: const xClassName = "..."
  const re2 = /\b(?:const|let)\s+\w*[Cc]lassName\w*\s*=\s*"([^"]*)"/g;
  while ((m = re2.exec(text)) !== null) {
    for (const t of m[1]!.split(/\s+/)) if (t) out.push(t);
  }
  // dynamic per-node class: className: "c" + d._cid  /  className={"c"+ ...}
  const dyn = (text.match(/\bclassName\s*(?:=\s*\{|:)\s*"c[a-z]?"\s*\+/g) ?? []).length
    + (text.match(/\bclassName\s*(?:=\s*\{|:)\s*"c[a-z]?\d*"\s*\+/g) ?? []).length;
  for (let i = 0; i < dyn; i++) out.push(`c__dyn${out.length}`); // unique opaque per occurrence
  return out;
}

const CID_CLASS_RE = /^c[a-z]?\d+$/; // our legacy per-node class: c12 / cn12
/** A class token that carries no human meaning (pure id / hash). */
function isOpaqueClass(t: string): boolean {
  if (CID_CLASS_RE.test(t)) return true;
  if (/^[a-z]?\d+$/.test(t)) return true;
  // hashed CSS-module-ish tokens: _foo_ab12 or 6-hex tails
  if (/_[a-z0-9]{5,}$/i.test(t) && /\d/.test(t)) return true;
  return false;
}

const GENERIC_COMP_RE = /^(Item|Card|List|ListItem|Link|LinkItem|Wrapper|Box|Div|El|Node|Group|Block|Comp|Component|Row|Col|Cell|Thing|Unit|Part|Chunk)\d*$/;
/** Exported / defined component names in a file. */
function componentNames(text: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const re1 = /export\s+default\s+function\s+([A-Z]\w*)/g;
  while ((m = re1.exec(text)) !== null) names.add(m[1]!);
  const re2 = /export\s+function\s+([A-Z]\w*)/g;
  while ((m = re2.exec(text)) !== null) names.add(m[1]!);
  const re3 = /(?:export\s+)?(?:const|function)\s+([A-Z]\w*)\s*[=(]/g;
  while ((m = re3.exec(text)) !== null) names.add(m[1]!);
  return [...names];
}

/** Data/content field names declared in a content or data module. */
function contentFieldNames(text: string): string[] {
  const out: string[] = [];
  // type Foo = { a: string; b?: number } — capture keys
  const typeBlocks = text.match(/(?:type|interface)\s+\w+\s*=?\s*\{([^}]*)\}/g) ?? [];
  for (const blk of typeBlocks) {
    const re = /(\w+)\s*\??\s*:/g; let m: RegExpExecArray | null;
    while ((m = re.exec(blk)) !== null) out.push(m[1]!);
  }
  return out;
}
const PLUMBING_FIELD_RE = /^(_cid\d*|cid\d*|value\d*|val\d*|f\d+|d\d+|field\d+|key\d*|prop\d+|arg\d+)$/;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type CategoryScore = { score: number; max: number; metrics: Record<string, number | string> };
export type QualityReport = {
  dir: string;
  total: number;
  categories: Record<string, CategoryScore>;
  raw: Record<string, number>;
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Linear ramp: value v mapped from [lo,hi] → [0,1]. */
const ramp = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo));
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function scoreApp(root: string): QualityReport {
  const files = collectFiles(root);
  const tsx = files.filter((f) => f.ext === ".tsx" || f.ext === ".jsx" || f.ext === ".astro");
  const css = files.filter((f) => f.ext === ".css");

  // Component modules = JSX-bearing files that aren't config/root-layout.
  const componentModules = tsx.filter((f) =>
    !CONFIG_NAME_RE.test(f.rel) && !ROOT_NAME_RE.test(f.rel) && countTags(f.text) > 0);
  const nonEntry = componentModules.filter((f) => !isEntryFile(f.rel));

  const totalTags = componentModules.reduce((s, f) => s + countTags(f.text), 0) || 1;
  const entryFiles = componentModules.filter((f) => isEntryFile(f.rel));
  const maxFileTags = Math.max(0, ...componentModules.map((f) => countTags(f.text)));
  const dominance = maxFileTags / totalTags; // 1.0 = one giant file

  // Section-named components (semantic top-level blocks). Tokenize the file path +
  // component names into words (splitting camelCase, kebab, snake, slashes) so both
  // `hero-section.tsx` and `HeroSection` are credited.
  const isSectionFile = (f: SrcFile): boolean => {
    const raw = f.rel + " " + componentNames(f.text).join(" ");
    const words = new Set(raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return SECTION_WORDS.some((w) => words.has(w));
  };
  const sectionComponents = nonEntry.filter(isSectionFile).length;
  const svgFiles = componentModules.filter((f) => /(^|\/)svgs?\//i.test(f.rel) || /icon/i.test(basename(f.rel)) || (countTags(f.text) > 0 && /^[^<]*<svg/m.test(f.text.replace(/import[^\n]*\n/g, "")))).length;

  // ---- naming ----
  const allComponentNames = new Set<string>();
  for (const f of componentModules) for (const n of componentNames(f.text)) allComponentNames.add(n);
  // exclude the page/Page entry symbol from the semantic judgement
  const judgedNames = [...allComponentNames].filter((n) => n !== "Page" && n !== "default" && n !== "RootLayout" && n !== "Layout");
  const genericNames = judgedNames.filter((n) => GENERIC_COMP_RE.test(n)).length;
  const compNameSemanticRatio = judgedNames.length ? 1 - genericNames / judgedNames.length : 0;

  const allClassToks: string[] = [];
  for (const f of tsx) allClassToks.push(...classTokens(f.text));
  const classTotal = allClassToks.length || 1;
  const opaqueClasses = allClassToks.filter(isOpaqueClass).length;
  const classSemanticRatio = 1 - opaqueClasses / classTotal;
  const distinctClasses = new Set(allClassToks).size || 1;
  const classReuse = 1 - distinctClasses / classTotal; // 0 = every class used once (per-node), →1 = heavy reuse

  // content field naming + editability
  const contentFiles = files.filter((f) => /(content|data)\.[jt]s$/i.test(basename(f.rel)) || /(^|\/)(content|lib)\//i.test(f.rel));
  const fieldNames: string[] = [];
  for (const f of contentFiles) fieldNames.push(...contentFieldNames(f.text));
  const plumbingFields = fieldNames.filter((n) => PLUMBING_FIELD_RE.test(n)).length;
  const fieldSemanticRatio = fieldNames.length ? 1 - plumbingFields / fieldNames.length : 0.5;

  // ---- styling system ----
  const cssBytes = css.reduce((s, f) => s + f.text.length, 0);
  const cssBytesPerNode = cssBytes / totalTags;
  let tokenRefs = 0, tokenDefs = 0;
  for (const f of css) {
    tokenRefs += (f.text.match(/var\(--/g) ?? []).length;
    tokenDefs += (f.text.match(/^\s*--[\w-]+\s*:/gm) ?? []).length;
  }
  // Tailwind-style theme tokens count as token usage too (utility classes referencing roles)
  const tailwindTokenClasses = allClassToks.filter((t) => /(^|[-:])(bg|text|border|fill|stroke|ring|from|to|via)-/.test(t)).length;
  // per-node-unique-rule penalty: count `.cNNN{` selectors in CSS
  let perNodeRules = 0;
  for (const f of css) perNodeRules += (f.text.match(/\.c[a-z]?\d+\s*[\{,]/g) ?? []).length;
  const perNodeRuleRatio = perNodeRules / totalTags; // 1.0 = a unique rule per node

  // magic literals in component markup (raw hex/rgb/px in className/style strings)
  let magicLiterals = 0;
  for (const f of componentModules) {
    magicLiterals += (f.text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
    magicLiterals += (f.text.match(/\brgba?\([^)]*\)/g) ?? []).length;
  }
  const magicPerNode = magicLiterals / totalTags;

  // ---- idiomatic styling (the axes the old rubric was blind to) ----
  // A px ARBITRARY value (`w-[713.938px]`, `py-[64px]`) is a measurement, not a design choice —
  // the single biggest "machine-generated" tell. Count them across markup + hoisted class
  // consts, vs the standard scale / rem a human writes.
  let arbPx = 0, arbBands = 0, stdBreakpoints = 0, dataCidCount = 0;
  for (const f of [...componentModules, ...css]) {
    arbPx += (f.text.match(/\[[0-9]+(?:\.[0-9]+)?px\]/g) ?? []).length;
    arbBands += (f.text.match(/(?:min|max)-\[[0-9]+px\]:/g) ?? []).length; // arbitrary midpoint media variants
    stdBreakpoints += (f.text.match(/(?:^|[\s"'`])(?:max-)?(?:sm|md|lg|xl|2xl):/g) ?? []).length;
    dataCidCount += (f.text.match(/data-cid/g) ?? []).length;
  }
  const arbPxPerNode = arbPx / totalTags;            // low is hand-authored; high is machine replay
  const bandShare = arbBands + stdBreakpoints > 0 ? arbBands / (arbBands + stdBreakpoints) : 0; // 1 = all arbitrary
  const dataCidPerNode = dataCidCount / totalTags;
  // Robotic, never-hand-written comment phrases.
  let roboticComments = 0;
  for (const f of [...componentModules, ...css, ...files.filter((x) => x.ext === ".ts")]) {
    roboticComments += (f.text.match(/Generated by clone-static|render-identical to the source|Do not edit by hand/g) ?? []).length;
  }

  // ---- editability ----
  const hasContentModule = contentFiles.some((f) => /export\s+(const|type)/.test(f.text)) ? 1 : 0;
  // Destructured props with a default value, in any function/arrow param block — counts
  // string, array, and identifier defaults alike (a default is a default).
  let propsWithDefaults = 0;
  for (const f of componentModules) {
    for (const blk of f.text.match(/\(\s*\{[^{}]*\}/g) ?? []) {
      propsWithDefaults += (blk.match(/\b\w+\s*=\s*(?![=>])/g) ?? []).length;
    }
  }
  const defaultsSignal = clamp01(propsWithDefaults / Math.max(6, nonEntry.length));

  // ---- file org ----
  const dirSet = new Set(componentModules.map((f) => f.rel.split("/").slice(0, -1).join("/")));
  const hasSectionsDir = [...dirSet].some((d) => /sections?$/i.test(d)) ? 1 : 0;
  const hasComponentsDir = [...dirSet].some((d) => /(components|ui)$/i.test(d)) ? 1 : 0;
  const hasLayoutDir = [...dirSet].some((d) => /(layout|svgs?)$/i.test(d)) ? 1 : 0;
  const orgDirs = hasSectionsDir + hasComponentsDir + hasLayoutDir;

  // ---- metadata ----
  let docHeaders = 0, annotations = 0;
  for (const f of componentModules) {
    docHeaders += (f.text.match(/\/\*\*[\s\S]*?\*\//g) ?? []).length;
    // component-type annotations in attribute, object, or doc-tag form.
    annotations += (f.text.match(/@component|data-component/g) ?? []).length;
  }

  // =========================================================================
  // Category scoring
  // =========================================================================

  // 1. Componentization (25): many components, low single-file dominance, sections present
  const cCount = ramp(nonEntry.length, 0, 12);        // 0 → 12+ components
  const cDom = 1 - ramp(dominance, 0.3, 0.95);        // penalize one giant file
  const cSections = ramp(sectionComponents, 0, 6);    // semantic sections
  const componentization = 25 * (0.4 * cCount + 0.35 * cDom + 0.25 * cSections);

  // 2. Semantic naming (25): component names, class names, content fields
  const naming = 25 * (0.4 * compNameSemanticRatio + 0.4 * classSemanticRatio + 0.2 * fieldSemanticRatio);

  // 3. Styling system (20): class reuse, tokens, low per-node verbosity, few magic literals AND
  //    — the axes the old rubric missed — idiomatic values (standard scale/rem, not a wall of
  //    px arbitraries) and standard breakpoints (not arbitrary midpoint bands).
  const sReuse = clamp01(classReuse / 0.6);            // 0.6+ reuse → full marks
  const sTokens = ramp(tokenRefs + tailwindTokenClasses, 0, Math.max(40, totalTags * 0.5));
  const sVerbosity = 1 - clamp01(perNodeRuleRatio);    // per-node rules are bad
  const sMagic = 1 - clamp01(magicPerNode / 0.25);
  const sArb = 1 - clamp01(arbPxPerNode / 2);          // ~0 arb-px/node → 1; 2+/node → 0
  const sBp = 1 - bandShare;                           // 0 arbitrary bands → 1
  const styling = 20 * (0.22 * sReuse + 0.13 * sTokens + 0.13 * sVerbosity + 0.07 * sMagic + 0.27 * sArb + 0.18 * sBp);

  // 4. Editability (15): content module, typed fields, semantic fields, prop defaults
  const editability = 15 * (0.4 * hasContentModule + 0.3 * fieldSemanticRatio + 0.3 * defaultsSignal);

  // 5. File org (10): folder structure + svgs extracted
  const fileOrg = 10 * (0.7 * (orgDirs / 3) + 0.3 * clamp01(svgFiles / 4));

  // 6. Metadata (5): concise human doc headers + semantic component annotations — but a
  //    "Generated by clone-static / render-identical" robotic header is a NEGATIVE signal (no
  //    human writes it), and shipping a per-node data-cid on every element is markup noise.
  const cleanComments = roboticComments === 0 ? 1 : clamp01(1 - roboticComments / Math.max(4, nonEntry.length));
  const lowCidNoise = 1 - clamp01(dataCidPerNode);     // ~0 data-cid/node → 1; 1/node → 0
  const metadata = 5 * (0.35 * clamp01(docHeaders / Math.max(4, nonEntry.length)) * cleanComments
    + 0.35 * clamp01(annotations / Math.max(8, totalTags * 0.1))
    + 0.3 * lowCidNoise);

  const total = componentization + naming + styling + editability + fileOrg + metadata;

  return {
    dir: root,
    total: r1(total),
    categories: {
      componentization: { score: r1(componentization), max: 25, metrics: { components: nonEntry.length, dominancePct: r1(dominance * 100), sectionComponents } },
      naming: { score: r1(naming), max: 25, metrics: { compNameSemanticPct: r1(compNameSemanticRatio * 100), classSemanticPct: r1(classSemanticRatio * 100), fieldSemanticPct: r1(fieldSemanticRatio * 100), genericNames } },
      styling: { score: r1(styling), max: 20, metrics: { classReusePct: r1(classReuse * 100), tokenRefs, perNodeRules, magicLiterals, arbPx, arbPxPerNode: r1(arbPxPerNode), arbBands, stdBreakpoints, bandSharePct: r1(bandShare * 100) } },
      editability: { score: r1(editability), max: 15, metrics: { hasContentModule, fieldSemanticPct: r1(fieldSemanticRatio * 100), propsWithDefaults } },
      fileOrg: { score: r1(fileOrg), max: 10, metrics: { orgDirs, svgFiles, hasSectionsDir, hasComponentsDir } },
      metadata: { score: r1(metadata), max: 5, metrics: { docHeaders, annotations, roboticComments, dataCidPerNode: r1(dataCidPerNode) } },
    },
    raw: {
      files: files.length, componentModules: componentModules.length, totalTags, maxFileTags,
      classTokens: classTotal, distinctClasses, opaqueClasses, cssBytes,
    },
  };
}

function fmt(rep: QualityReport): string {
  const lines: string[] = [];
  lines.push(`\n  ${rep.dir}`);
  lines.push(`  TOTAL: ${rep.total}/100`);
  for (const [k, c] of Object.entries(rep.categories)) {
    const metrics = Object.entries(c.metrics).map(([mk, mv]) => `${mk}=${mv}`).join(" ");
    lines.push(`    ${k.padEnd(16)} ${String(c.score).padStart(5)}/${c.max}   ${metrics}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const asJson = process.argv.includes("--json");
  if (dirs.length === 0) { console.error("usage: qualityScore <appDir> [<appDir2> ...] [--json]"); process.exit(1); }
  const reports = dirs.map((d) => scoreApp(d));
  if (asJson) { console.log(JSON.stringify(reports, null, 2)); return; }
  for (const rep of reports) console.log(fmt(rep));
  if (reports.length > 1) {
    console.log("\n  ── comparison ──");
    console.log("  " + "category".padEnd(16) + reports.map((_, i) => `app${i + 1}`.padStart(10)).join(""));
    for (const cat of Object.keys(reports[0]!.categories)) {
      console.log("  " + cat.padEnd(16) + reports.map((r) => String(r.categories[cat]!.score).padStart(10)).join(""));
    }
    console.log("  " + "TOTAL".padEnd(16) + reports.map((r) => String(r.total).padStart(10)).join(""));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
