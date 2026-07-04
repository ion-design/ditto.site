/**
 * Output-quality rubric — HONEST edition (deterministic, framework-agnostic).
 *
 * The fidelity gates (validate/gates.ts) measure whether the clone *looks and
 * behaves* like the source. They say nothing about whether the generated CODE is
 * good — small files, decomposed into real components, semantic and accessible,
 * free of capture artifacts, and safe at runtime. That "developer-facing quality"
 * is what a deterministic converter is judged on once fidelity is a given.
 *
 * This module statically analyzes a generated app directory (source text only —
 * `.tsx/.jsx/.ts/.astro/.css`) and scores it 0–100 across SIX dimensions, each
 * with visible subscores. The score is a weighted blend of the dimensions EXCEPT
 * that a single dimension in catastrophic territory (a multi-megabyte source file,
 * a 100KB+ single line) HARD-CAPS the overall grade into D-range no matter how
 * clean everything else is — because such a file is unopenable, un-diffable, and
 * un-editable, which is the whole point of "good code".
 *
 * The signals are deliberately general (payload bytes, LOC distribution, repeated
 * definitions, semantic-tag ratios, whitespace/capture artifacts, uncleaned
 * listeners) so the scorer is not tuned to any specific site — it measures the
 * failure *modes* a robotic converter falls into, not any one output.
 *
 * Pure + deterministic: same directory ⇒ same score.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

// ===========================================================================
// CALIBRATION CONSTANTS
// ---------------------------------------------------------------------------
// These are CALIBRATION GUIDES, expected to be tuned as the generator and our
// taste evolve — they are NOT compliance targets or contractual thresholds. A
// number here answers "where does a human reviewer start wincing?", set from
// observed good vs. bad outputs, and should be re-fit (not litigated) whenever
// calibration drifts. Every knob lives in this one block on purpose.
// ===========================================================================
const K = {
  // ---- payload discipline (a file/line so big it is not human-readable) ----
  FILE_BYTES_GOOD: 30_000, // ≤30KB source file: comfortable to open
  FILE_BYTES_BAD: 160_000, // ≥160KB: a reviewer scrolls forever; scores ~0
  LINE_CHARS_GOOD: 2_000, // a formatted line, allowing for a dense data/JSX row
  LINE_CHARS_BAD: 30_000, // a giant one-liner (minified / HTML-as-string prop)
  INLINE_BYTES_GOOD: 50_000, // total base64 / inline-HTML bytes that's forgivable
  INLINE_BYTES_BAD: 2_000_000, // 2MB+ of embedded blobs: catastrophic payload
  // Catastrophe caps: any ONE of these forces the whole app into D-range.
  CATASTROPHE_FILE_BYTES: 1_000_000, // a >1MB source file
  CATASTROPHE_LINE_CHARS: 100_000, // a >100KB single line
  CATASTROPHE_INLINE_BYTES: 5_000_000, // >5MB of embedded base64/HTML
  CAP_GRADE_D: 68, // ceiling applied when a catastrophe fires — top of the D band, so a
  //   catastrophic payload can grade no better than D+ regardless of other dimensions
  // Softer cap for "very bad but not unopenable" payloads.
  WARN_FILE_BYTES: 350_000,
  WARN_LINE_CHARS: 40_000,
  CAP_GRADE_C: 78, // ceiling for the softer warning band (top of C+)

  // ---- component decomposition (is the page a monolith?) ----
  MONOLITH_DOMINANCE_GOOD: 0.3, // biggest file ≤30% of all tags → well spread
  MONOLITH_DOMINANCE_BAD: 0.75, // one file holds ≥75% of the page → monolith
  BIG_SECTION_LINES: 600, // a "section" this long is really a whole page
  COMPONENTS_GOOD: 12, // this many real components → full decomposition credit

  // ---- duplication ----
  DUP_HELPER_RATIO_BAD: 0.4, // ≥40% of helper defs are copy-paste duplicates
  DUP_SVG_PATH_RATIO_BAD: 0.85, // ≥85% of inline <path> strings are repeats (shared
  //   icon sets legitimately repeat, so only near-total duplication is a real tell)
  NEAR_DUP_COMPONENT_BAD: 14, // this many near-identical NON-trivial component pairs → 0
  NEAR_DUP_MIN_TAGS: 8, // ignore tiny components (icons/logos) in near-dup detection

  // ---- semantics / a11y ----
  DIV_RATIO_GOOD: 0.6, // ≤60% of elements are bare div/span → healthy
  DIV_RATIO_BAD: 0.9, // ≥90% divs → div soup
  ALT_COVERAGE_GOOD: 0.9, // ≥90% of <img> carry alt=
  H1_REQUIRED: 1, // a page really should have exactly one <h1>

  // ---- hygiene ----
  // {" "} literals and sub-pixel arbitraries are a KNOWN baseline quirk of this
  // converter present in even good output — only pathological volumes should bite,
  // so these BADs sit well above what a "decent" tree emits.
  WS_LITERAL_PER_KTAG_GOOD: 100, // per 1000 tags a converter routinely emits some
  WS_LITERAL_PER_KTAG_BAD: 1200, // this many → capture-whitespace noise dominates
  SUBPIXEL_PER_KTAG_GOOD: 60, // some frozen measurements are unavoidable
  SUBPIXEL_PER_KTAG_BAD: 260, // a wall of frozen sub-pixels → machine replay
  OPAQUE_TOKEN_RATIO_BAD: 0.6, // ≥60% of CSS custom props are opaque --clr-N / hashes
  PROBE_ARTIFACTS_BAD: 8, // off-screen capture-probe text leaks

  // ---- runtime discipline ----
  LEAK_LISTENERS_GOOD: 8, // a small shared runtime bundle carries a few listeners
  LEAK_LISTENERS_BAD: 30, // this many uncleaned adds → real leak territory
} as const;

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
// Small helpers
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Linear ramp: v in [lo,hi] → [0,1]. Handles lo>hi (descending / "lower is better"). */
function ramp(v: number, lo: number, hi: number): number {
  if (lo === hi) return v >= hi ? 1 : 0;
  return clamp01((v - lo) / (hi - lo));
}
/** A value where HIGHER is worse: good at `good`, zero at `bad`. */
const penalize = (v: number, good: number, bad: number): number => 1 - ramp(v, good, bad);
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Longest single line (in chars) in a file. */
function maxLineLen(text: string): number {
  let max = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { if (i - start > max) max = i - start; start = i + 1; }
  }
  if (text.length - start > max) max = text.length - start;
  return max;
}

/** Count JSX/HTML opening element tags — a framework-agnostic page-size proxy. */
function countTags(text: string): number {
  const m = text.match(/<[a-zA-Z][a-zA-Z0-9.]*(\s|\/|>)/g);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Structural classification
// ---------------------------------------------------------------------------

const CONFIG_NAME_RE = /(config|tsconfig|next-env|site-config|content\.config|\.config\.)/i;
const ROOT_NAME_RE = /(^|\/)(layout|_app|_document|root-layout)\.[jt]sx$/i;
const SECTION_WORDS = ["hero", "footer", "navbar", "nav", "header", "about", "cta", "feature", "pricing", "faq", "logo", "logocloud", "testimonial", "gallery", "stories", "spotlight", "knowledge", "news", "apply", "contact", "banner", "team", "stats", "partners", "alumni", "founder", "section"];

function isEntryFile(rel: string): boolean {
  const b = basename(rel).toLowerCase();
  if (/^(page|index|home|app)\.[jt]sx$/.test(b)) return true;
  if (rel.includes("/pages/") && b.endsWith(".astro")) return true;
  if (b === "index.astro" || b === "[...slug].astro" || b === "404.astro") return true;
  return false;
}

const GENERIC_COMP_RE = /^(Item|Card|List|ListItem|Link|LinkItem|Wrapper|Box|Div|El|Node|Group|Block|Comp|Component|Row|Col|Cell|Thing|Unit|Part|Chunk)\d*$/;
export function componentNames(text: string): string[] {
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

// ===========================================================================
// METRIC EXTRACTORS  (exported for unit tests — each is a pure text→number/obj)
// ===========================================================================

/** Bytes of embedded base64 blobs + HTML passed as string props/dangerous html. */
export function inlineBlobBytes(text: string): number {
  let bytes = 0;
  // base64 data URIs — the payload after the comma.
  for (const m of text.matchAll(/data:[^;,'"`)\s]*;base64,([A-Za-z0-9+/=]+)/g)) bytes += m[1]!.length;
  // dangerouslySetInnerHTML / html-string props: a big string literal handed to markup.
  for (const m of text.matchAll(/dangerouslySetInnerHTML/g)) void m;
  // A very long string literal that is actually markup ("<div ...</div>" as a prop).
  for (const m of text.matchAll(/"((?:[^"\\]|\\.){2000,})"/g)) {
    const s = m[1]!;
    if (/<[a-z][a-z0-9]*[\s>]/i.test(s) && (s.match(/</g)?.length ?? 0) > 20) bytes += s.length;
  }
  return bytes;
}

/** Payload facts about one file. */
export function filePayload(f: SrcFile): { bytes: number; maxLine: number; inlineBytes: number } {
  return { bytes: f.text.length, maxLine: maxLineLen(f.text), inlineBytes: inlineBlobBytes(f.text) };
}

/** {" "} / {' '} whitespace-only JSX expression literals (a capture artifact). */
export function whitespaceLiterals(text: string): number {
  return (text.match(/\{\s*["'`]\s+["'`]\s*\}/g) ?? []).length
    + (text.match(/\{["'`]\\u00a0["'`]\}/gi) ?? []).length;
}

/** Frozen sub-pixel arbitrary values: `[12.5px]`, `w-[713.938px]` where px isn't whole. */
export function subpixelArbitraries(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\[(-?[0-9]+\.?[0-9]*)(px|rem)\]/g)) {
    const px = parseFloat(m[1]!) * (m[2] === "rem" ? 16 : 1);
    if (Math.abs(px - Math.round(px)) > 0.02) n++;
  }
  return n;
}

/** CSS custom-property definitions split into opaque (--clr-7, --c12, hashes) vs named. */
export function customPropTokens(text: string): { total: number; opaque: number } {
  let total = 0, opaque = 0;
  for (const m of text.matchAll(/(^|[^\w-])(--[\w-]+)\s*:/g)) {
    const name = m[2]!.slice(2); // strip leading --
    total++;
    if (/^(clr|c|color|var|token|t|v|n|x)?-?\d+$/i.test(name) || /^[a-f0-9]{6,}$/i.test(name)) opaque++;
  }
  return { total, opaque };
}

/** Off-screen capture-probe text leaks (measurement scaffolding shipped into markup):
 *  probe data-attrs, __probe__ markers, and clip:rect(0…) off-screen clipping. */
export function probeArtifacts(text: string): number {
  return (text.match(/(?:data-(?:probe|measure|ditto-probe)|__probe__|offscreen-probe|clip:\s*["'`]?\s*rect\(\s*0)/g) ?? []).length;
}

/** addEventListener calls with no matching removeEventListener / cleanup return. */
export function uncleanedListeners(text: string): number {
  const adds = (text.match(/\.addEventListener\s*\(/g) ?? []).length;
  const removes = (text.match(/\.removeEventListener\s*\(/g) ?? []).length;
  // A cleanup return (useEffect teardown / AbortController) neutralizes some adds.
  const hasCleanupReturn = /return\s*\(\s*\)\s*=>/.test(text) || /new AbortController/.test(text) || /\{\s*signal\s*\}/.test(text);
  const covered = hasCleanupReturn ? Math.max(removes, adds) : removes;
  return Math.max(0, adds - covered);
}

/** Element-tag histogram for a whole tree of markup text. */
export function tagHistogram(text: string): Record<string, number> {
  const h: Record<string, number> = {};
  for (const m of text.matchAll(/<([a-z][a-z0-9]*)(?:\s|\/|>)/g)) {
    const t = m[1]!;
    h[t] = (h[t] ?? 0) + 1;
  }
  return h;
}

/** aria-hidden applied to a focusable/interactive element in the same tag. */
export function ariaHiddenFocusables(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/<(a|button|input|select|textarea)\b[^>]*aria-hidden\s*=\s*["'{]?\s*true/gi)) void m;
  n += (text.match(/<(?:a|button|input|select|textarea)\b[^>]*aria-hidden\s*=\s*["'{]?\s*true/gi) ?? []).length;
  return n;
}

/** Repeated helper/function definitions with identical bodies (copy-paste, not shared). */
export function duplicateHelpers(text: string): { defs: number; dups: number } {
  const bodies = new Map<string, number>();
  // named function / arrow-const helper definitions with a brace body.
  const re = /(?:function\s+\w+\s*\([^)]*\)|const\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*=>)\s*\{([\s\S]{40,600}?)\}/g;
  let m: RegExpExecArray | null;
  let defs = 0;
  while ((m = re.exec(text)) !== null) {
    defs++;
    const key = m[1]!.replace(/\s+/g, " ").trim();
    bodies.set(key, (bodies.get(key) ?? 0) + 1);
  }
  let dups = 0;
  for (const c of bodies.values()) if (c > 1) dups += c - 1;
  return { defs, dups };
}

/** Inline SVG <path d="…"> strings, and how many are exact repeats. */
export function svgPathDuplication(text: string): { total: number; repeats: number } {
  const seen = new Map<string, number>();
  let total = 0;
  for (const m of text.matchAll(/\bd\s*=\s*["']([Mm][^"']{20,})["']/g)) {
    total++;
    const key = m[1]!;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let repeats = 0;
  for (const c of seen.values()) if (c > 1) repeats += c - 1;
  return { total, repeats };
}

/** Near-identical component pairs: same tag-histogram signature across component files. */
export function nearDuplicateComponents(sigs: string[]): number {
  const counts = new Map<string, number>();
  for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
  let pairs = 0;
  for (const c of counts.values()) if (c > 1) pairs += c - 1;
  return pairs;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export type LetterGrade = "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "D-" | "F";
export function toLetter(total: number): LetterGrade {
  if (total >= 93) return "A";
  if (total >= 90) return "A-";
  if (total >= 87) return "B+";
  if (total >= 83) return "B";
  if (total >= 80) return "B-";
  if (total >= 77) return "C+";
  if (total >= 73) return "C";
  if (total >= 70) return "C-";
  if (total >= 66) return "D+";
  if (total >= 63) return "D";
  if (total >= 60) return "D-";
  return "F";
}

export type CategoryScore = { score: number; max: number; metrics: Record<string, number | string> };
export type Offender = { file: string; metric: string; value: number };
export type QualityReport = {
  dir: string;
  total: number;
  grade: LetterGrade;
  caps: string[];
  categories: Record<string, CategoryScore>;
  offenders: Offender[];
  raw: Record<string, number>;
};

/** Dimension weights (sum = 100). Guiding, not exact — see CALIBRATION note.
 *  Payload + decomposition carry the most weight because an unopenable, monolithic
 *  file is the defect a reviewer notices first; hygiene/duplication are lighter
 *  because this converter's baseline (some {" "}, shared icons) is tolerable. */
const WEIGHTS = {
  payload: 26,
  decomposition: 18,
  duplication: 12,
  semantics: 18,
  hygiene: 14,
  runtime: 12,
} as const;

export function scoreApp(root: string): QualityReport {
  const files = collectFiles(root);
  const markup = files.filter((f) => f.ext === ".tsx" || f.ext === ".jsx" || f.ext === ".astro");
  const css = files.filter((f) => f.ext === ".css");
  const runtimeFiles = files.filter((f) => f.ext === ".ts" || f.ext === ".tsx" || f.ext === ".jsx");

  const componentModules = markup.filter((f) =>
    !CONFIG_NAME_RE.test(f.rel) && !ROOT_NAME_RE.test(f.rel) && countTags(f.text) > 0);
  const nonEntry = componentModules.filter((f) => !isEntryFile(f.rel));
  const allText = files.map((f) => f.text).join("\n");
  const markupText = markup.map((f) => f.text).join("\n");

  const totalTags = componentModules.reduce((s, f) => s + countTags(f.text), 0) || 1;
  const maxFileTags = Math.max(0, ...componentModules.map((f) => countTags(f.text)));
  const kTags = totalTags / 1000;

  const offenders: Offender[] = [];
  const caps: string[] = [];

  // =========================================================================
  // 1. PAYLOAD DISCIPLINE — no file/line/blob a human cannot open.
  // =========================================================================
  let worstFileBytes = 0, worstFileRel = "";
  let worstLine = 0, worstLineRel = "";
  let totalInlineBytes = 0, worstInlineRel = "", worstInlineBytes = 0;
  for (const f of files) {
    const p = filePayload(f);
    if (p.bytes > worstFileBytes) { worstFileBytes = p.bytes; worstFileRel = f.rel; }
    if (p.maxLine > worstLine) { worstLine = p.maxLine; worstLineRel = f.rel; }
    totalInlineBytes += p.inlineBytes;
    if (p.inlineBytes > worstInlineBytes) { worstInlineBytes = p.inlineBytes; worstInlineRel = f.rel; }
  }
  if (worstFileRel) offenders.push({ file: worstFileRel, metric: "file bytes", value: worstFileBytes });
  if (worstLineRel) offenders.push({ file: worstLineRel, metric: "max line chars", value: worstLine });
  if (worstInlineBytes > 0) offenders.push({ file: worstInlineRel, metric: "inline blob bytes", value: worstInlineBytes });

  // Worst-file penalty, tempered by how WIDESPREAD oversized files are: one big section
  // in an otherwise-small tree is forgivable; many oversized files is systemic bloat.
  const oversized = files.filter((f) => f.text.length >= K.FILE_BYTES_GOOD * 2).length;
  const pFileMax = penalize(worstFileBytes, K.FILE_BYTES_GOOD, K.FILE_BYTES_BAD);
  const pFileSpread = penalize(oversized, 0, Math.max(3, files.length * 0.25));
  const pFile = 0.6 * pFileMax + 0.4 * pFileSpread;
  const pLine = penalize(worstLine, K.LINE_CHARS_GOOD, K.LINE_CHARS_BAD);
  const pInline = penalize(totalInlineBytes, K.INLINE_BYTES_GOOD, K.INLINE_BYTES_BAD);
  const payloadSub = 0.4 * pFile + 0.35 * pLine + 0.25 * pInline;

  // =========================================================================
  // 2. COMPONENT DECOMPOSITION — is the page a monolith?
  // =========================================================================
  const dominance = maxFileTags / totalTags; // 1.0 = one giant file holds the page
  const bigSections = componentModules.filter((f) => f.lines >= K.BIG_SECTION_LINES && !isEntryFile(f.rel)).length;
  for (const f of componentModules) {
    if (f.lines >= K.BIG_SECTION_LINES && !isEntryFile(f.rel)) offenders.push({ file: f.rel, metric: "section LOC", value: f.lines });
  }
  const dMono = penalize(dominance, K.MONOLITH_DOMINANCE_GOOD, K.MONOLITH_DOMINANCE_BAD);
  const dCount = ramp(nonEntry.length, 0, K.COMPONENTS_GOOD);
  const dBig = penalize(bigSections, 0, 3);
  const decompositionSub = 0.45 * dMono + 0.3 * dCount + 0.25 * dBig;

  // =========================================================================
  // 3. DUPLICATION — repeated helpers, near-identical components, repeated SVG paths.
  // =========================================================================
  let helperDefs = 0, helperDups = 0;
  for (const f of runtimeFiles) { const d = duplicateHelpers(f.text); helperDefs += d.defs; helperDups += d.dups; }
  const svgDup = svgPathDuplication(markupText);
  // Near-dup signatures over NON-trivial CONTENT components only: vectorized assets
  // (icons, logos, illustration frames) legitimately share a tag shape, so counting
  // them as "duplicates" would punish healthy asset sets rather than real copy-paste.
  const isAssetFile = (rel: string): boolean => /(^|\/)svgs?\//i.test(rel) || /(icon|illustration|logo)\d*\.[jt]sx$/i.test(basename(rel));
  const compSigs = nonEntry.filter((f) => !isAssetFile(f.rel)).map((f) => {
    const h = tagHistogram(f.text);
    const tags = Object.values(h).reduce((a, b) => a + b, 0);
    if (tags < K.NEAR_DUP_MIN_TAGS) return "";
    return Object.keys(h).sort().map((k) => `${k}:${h[k]}`).join(",");
  }).filter((s) => s.length > 0);
  const nearDup = nearDuplicateComponents(compSigs);

  const helperDupRatio = helperDefs ? helperDups / helperDefs : 0;
  const svgDupRatio = svgDup.total ? svgDup.repeats / svgDup.total : 0;
  if (helperDups > 0) offenders.push({ file: "(helpers)", metric: "duplicate helper defs", value: helperDups });
  if (svgDup.repeats > 0) offenders.push({ file: "(inline svg)", metric: "repeated <path> strings", value: svgDup.repeats });
  if (nearDup > 0) offenders.push({ file: "(components)", metric: "near-identical component pairs", value: nearDup });

  const uHelper = penalize(helperDupRatio, 0, K.DUP_HELPER_RATIO_BAD);
  const uSvg = penalize(svgDupRatio, 0, K.DUP_SVG_PATH_RATIO_BAD);
  const uNear = penalize(nearDup, 0, K.NEAR_DUP_COMPONENT_BAD);
  // Helper duplication is the strongest tell; near-dup components second; inline-SVG
  // path repeats are the weakest (shared icon sets repeat legitimately).
  const duplicationSub = 0.5 * uHelper + 0.35 * uNear + 0.15 * uSvg;

  // =========================================================================
  // 4. SEMANTICS / A11Y — real tags over div soup, one h1, alt coverage, no aria traps.
  // =========================================================================
  const hist = tagHistogram(markupText);
  const totalEls = Object.values(hist).reduce((a, b) => a + b, 0) || 1;
  const divLike = (hist["div"] ?? 0) + (hist["span"] ?? 0);
  const semanticTags = (hist["section"] ?? 0) + (hist["nav"] ?? 0) + (hist["header"] ?? 0) + (hist["footer"] ?? 0)
    + (hist["main"] ?? 0) + (hist["article"] ?? 0) + (hist["aside"] ?? 0) + (hist["button"] ?? 0)
    + (hist["h1"] ?? 0) + (hist["h2"] ?? 0) + (hist["h3"] ?? 0) + (hist["ul"] ?? 0) + (hist["nav"] ?? 0);
  const h1Count = hist["h1"] ?? 0;
  const imgCount = hist["img"] ?? 0;
  const altCount = (markupText.match(/\balt\s*=/g) ?? []).length;
  const ariaHidden = ariaHiddenFocusables(markupText);
  const divRatio = divLike / totalEls;
  const altCoverage = imgCount ? clamp01(altCount / imgCount) : 1;

  if (h1Count === 0) offenders.push({ file: "(page)", metric: "h1 count", value: 0 });
  if (ariaHidden > 0) offenders.push({ file: "(markup)", metric: "aria-hidden on focusables", value: ariaHidden });
  if (imgCount && altCoverage < K.ALT_COVERAGE_GOOD) offenders.push({ file: "(markup)", metric: "imgs missing alt", value: imgCount - altCount });

  const aDiv = penalize(divRatio, K.DIV_RATIO_GOOD, K.DIV_RATIO_BAD);
  const aSem = clamp01(semanticTags / (totalEls * 0.12)); // ~12% semantic tags → full credit
  const aH1 = h1Count === K.H1_REQUIRED ? 1 : h1Count > K.H1_REQUIRED ? 0.8 : 0.1; // missing h1 is a heavy penalty; multiple h1 a minor ding
  const aAlt = altCoverage;
  const aAria = penalize(ariaHidden, 0, 6);
  const semanticsSub = 0.3 * aDiv + 0.2 * aSem + 0.25 * aH1 + 0.15 * aAlt + 0.1 * aAria;

  // =========================================================================
  // 5. HYGIENE — whitespace literals, frozen sub-pixels, opaque tokens, probe leaks.
  // =========================================================================
  const wsLiterals = whitespaceLiterals(markupText);
  const subpixel = subpixelArbitraries(allText);
  let propTotal = 0, propOpaque = 0;
  for (const f of css) { const t = customPropTokens(f.text); propTotal += t.total; propOpaque += t.opaque; }
  const probes = probeArtifacts(allText);
  const opaqueRatio = propTotal ? propOpaque / propTotal : 0;
  const wsPerK = wsLiterals / Math.max(1, kTags);
  const subpixelPerK = subpixel / Math.max(1, kTags);

  if (wsLiterals > 0) offenders.push({ file: "(markup)", metric: "{\" \"} whitespace literals", value: wsLiterals });
  if (subpixel > 0) offenders.push({ file: "(styles)", metric: "frozen sub-pixel arbitraries", value: subpixel });
  if (propOpaque > 0) offenders.push({ file: "(css)", metric: "opaque --token defs", value: propOpaque });
  if (probes > 0) offenders.push({ file: "(markup)", metric: "capture-probe artifacts", value: probes });

  const hWs = penalize(wsPerK, K.WS_LITERAL_PER_KTAG_GOOD, K.WS_LITERAL_PER_KTAG_BAD);
  const hSub = penalize(subpixelPerK, K.SUBPIXEL_PER_KTAG_GOOD, K.SUBPIXEL_PER_KTAG_BAD);
  const hTok = penalize(opaqueRatio, 0, K.OPAQUE_TOKEN_RATIO_BAD);
  const hProbe = penalize(probes, 0, K.PROBE_ARTIFACTS_BAD);
  const hygieneSub = 0.28 * hWs + 0.28 * hSub + 0.28 * hTok + 0.16 * hProbe;

  // =========================================================================
  // 6. RUNTIME DISCIPLINE — no leaked listeners, no undeclared imports.
  // =========================================================================
  let leaks = 0;
  for (const f of runtimeFiles) leaks += uncleanedListeners(f.text);
  const undeclaredImports = countUndeclaredImports(runtimeFiles);
  if (leaks > 0) offenders.push({ file: "(runtime)", metric: "uncleaned addEventListener", value: leaks });
  if (undeclaredImports > 0) offenders.push({ file: "(runtime)", metric: "undeclared imports", value: undeclaredImports });

  const rLeak = penalize(leaks, K.LEAK_LISTENERS_GOOD, K.LEAK_LISTENERS_BAD);
  const rImp = penalize(undeclaredImports, 0, 6);
  const runtimeSub = 0.7 * rLeak + 0.3 * rImp;

  // =========================================================================
  // BLEND + HARD CAPS
  // =========================================================================
  const dims = {
    payload: payloadSub,
    decomposition: decompositionSub,
    duplication: duplicationSub,
    semantics: semanticsSub,
    hygiene: hygieneSub,
    runtime: runtimeSub,
  };
  let total = 0;
  for (const [k, sub] of Object.entries(dims)) total += WEIGHTS[k as keyof typeof WEIGHTS] * sub;

  // Catastrophe caps: any ONE unopenable payload drags the whole grade into D-range.
  if (worstFileBytes >= K.CATASTROPHE_FILE_BYTES) caps.push(`file ${worstFileRel} is ${(worstFileBytes / 1e6).toFixed(1)}MB (>1MB)`);
  if (worstLine >= K.CATASTROPHE_LINE_CHARS) caps.push(`line in ${worstLineRel} is ${(worstLine / 1000).toFixed(0)}KB (>100KB)`);
  if (totalInlineBytes >= K.CATASTROPHE_INLINE_BYTES) caps.push(`${(totalInlineBytes / 1e6).toFixed(1)}MB of embedded base64/HTML (>5MB)`);
  if (caps.length) total = Math.min(total, K.CAP_GRADE_D);
  else {
    // Softer warning band.
    if (worstFileBytes >= K.WARN_FILE_BYTES) caps.push(`file ${worstFileRel} is ${(worstFileBytes / 1000).toFixed(0)}KB (>${K.WARN_FILE_BYTES / 1000}KB)`);
    if (worstLine >= K.WARN_LINE_CHARS) caps.push(`line in ${worstLineRel} is ${(worstLine / 1000).toFixed(0)}KB (>${K.WARN_LINE_CHARS / 1000}KB)`);
    if (caps.length) total = Math.min(total, K.CAP_GRADE_C);
  }
  total = r1(Math.max(0, Math.min(100, total)));

  // Order offenders by severity so the report's "top offenders" is meaningful.
  offenders.sort((a, b) => severity(b) - severity(a));

  return {
    dir: root,
    total,
    grade: toLetter(total),
    caps,
    categories: {
      payload: { score: r1(WEIGHTS.payload * payloadSub), max: WEIGHTS.payload, metrics: { maxFileKB: r1(worstFileBytes / 1000), maxLineKB: r1(worstLine / 1000), inlineBlobKB: r1(totalInlineBytes / 1000) } },
      decomposition: { score: r1(WEIGHTS.decomposition * decompositionSub), max: WEIGHTS.decomposition, metrics: { components: nonEntry.length, dominancePct: r1(dominance * 100), bigSections } },
      duplication: { score: r1(WEIGHTS.duplication * duplicationSub), max: WEIGHTS.duplication, metrics: { helperDups, helperDupPct: r1(helperDupRatio * 100), svgPathRepeats: svgDup.repeats, nearDupPairs: nearDup } },
      semantics: { score: r1(WEIGHTS.semantics * semanticsSub), max: WEIGHTS.semantics, metrics: { h1: h1Count, divRatioPct: r1(divRatio * 100), semanticTags, altCoveragePct: r1(altCoverage * 100), ariaHiddenFocusables: ariaHidden } },
      hygiene: { score: r1(WEIGHTS.hygiene * hygieneSub), max: WEIGHTS.hygiene, metrics: { wsLiterals, subpixelArbitraries: subpixel, opaqueTokenPct: r1(opaqueRatio * 100), probeArtifacts: probes } },
      runtime: { score: r1(WEIGHTS.runtime * runtimeSub), max: WEIGHTS.runtime, metrics: { uncleanedListeners: leaks, undeclaredImports } },
    },
    offenders: offenders.slice(0, 15),
    raw: {
      files: files.length, componentModules: componentModules.length, totalTags, maxFileTags,
      worstFileBytes, worstLineChars: worstLine, inlineBytes: totalInlineBytes,
    },
  };
}

/** Undeclared imports: a bare-specifier import not present in any package.json/tsconfig
 *  alias and not a relative path — a runtime crash waiting to happen. We approximate by
 *  flagging imports of local-looking modules that resolve nowhere is expensive, so instead
 *  we flag the cheap, robust tell: an import statement whose source is an empty string or a
 *  malformed specifier. (Kept conservative to avoid false positives across frameworks.) */
function countUndeclaredImports(files: SrcFile[]): number {
  let n = 0;
  for (const f of files) {
    for (const m of f.text.matchAll(/\bimport\s+[^;]*?\bfrom\s*["'`]([^"'`]*)["'`]/g)) {
      const spec = m[1]!;
      if (spec.trim() === "" || /\s/.test(spec) || spec === "undefined" || spec === "null") n++;
    }
  }
  return n;
}

/** Relative weight of an offender for ordering the top-offenders list. */
function severity(o: Offender): number {
  switch (o.metric) {
    case "file bytes": return o.value / 1000;
    case "max line chars": return o.value / 1000;
    case "inline blob bytes": return o.value / 2000;
    case "section LOC": return o.value / 20;
    case "opaque --token defs": return o.value * 0.5;
    case "frozen sub-pixel arbitraries": return o.value * 0.3;
    case "{\" \"} whitespace literals": return o.value * 0.1;
    case "h1 count": return 300; // a missing h1 is always a headline offender
    case "uncleaned addEventListener": return o.value * 3;
    default: return o.value;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fmt(rep: QualityReport): string {
  const lines: string[] = [];
  lines.push(`\n  ${rep.dir}`);
  lines.push(`  GRADE: ${rep.grade}   (${rep.total}/100)`);
  if (rep.caps.length) lines.push(`  CAPS:  ${rep.caps.join("; ")}`);
  for (const [k, c] of Object.entries(rep.categories)) {
    const metrics = Object.entries(c.metrics).map(([mk, mv]) => `${mk}=${mv}`).join(" ");
    lines.push(`    ${k.padEnd(15)} ${String(c.score).padStart(5)}/${c.max}   ${metrics}`);
  }
  if (rep.offenders.length) {
    lines.push(`    top offenders:`);
    for (const o of rep.offenders.slice(0, 8)) lines.push(`      ${o.metric.padEnd(34)} ${String(o.value).padStart(10)}  ${o.file}`);
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
    console.log("  " + "dimension".padEnd(15) + reports.map((_, i) => `app${i + 1}`.padStart(10)).join(""));
    for (const cat of Object.keys(reports[0]!.categories)) {
      console.log("  " + cat.padEnd(15) + reports.map((r) => String(r.categories[cat]!.score).padStart(10)).join(""));
    }
    console.log("  " + "GRADE".padEnd(15) + reports.map((r) => `${r.grade}(${r.total})`.padStart(10)).join(""));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
