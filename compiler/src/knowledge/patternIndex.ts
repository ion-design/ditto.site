/**
 * Pattern index: O(1) signature lookup over the frozen pattern catalog
 * (data/pattern-catalog.json). Matches known widget/platform/animation
 * signatures against the IR's diagnostic evidence (srcClass, tags, attrs)
 * and produces deterministic PatternHints consumed as a generation artifact
 * (patterns.json) and by service-layer fast-path decisions.
 *
 * Determinism contract: the catalog is FROZEN data pinned by sha256
 * (data/pattern-catalog.lock). Same catalog + same IR ⇒ byte-identical hints.
 * There is no learning layer here — hints are catalog-only by construction.
 * CATALOG_ONLY_HINTS=true (CI) turns a lock mismatch into a hard error so CI
 * can never run against an unpinned catalog.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IR, IRNode, IRChild } from "../normalize/ir.js";

export type PatternMatchSpec = {
  /** exact class-token equality (lowercase) */
  classTokens?: string[];
  /** class-token prefix, e.g. "elementor-", "wp-block-" */
  classPrefixes?: string[];
  /** element tag names, e.g. custom elements like "lottie-player" */
  tags?: string[];
  /** attribute presence, e.g. "data-aos" */
  attrNames?: string[];
  /** id-attribute prefix, e.g. "shopify-section" */
  idPrefixes?: string[];
};

export type PatternDef = {
  id: string;
  kind: string;
  flags: string[];
  match: PatternMatchSpec;
};

export type PatternCatalog = {
  version: number;
  description?: string;
  patterns: PatternDef[];
};

export type PatternMatch = {
  id: string;
  kind: string;
  flags: string[];
  /** how many IR nodes matched at least one signature of this pattern */
  count: number;
  /** first few matching node ids, pre-order (bounded sample for diagnostics) */
  cids: string[];
};

export type PatternHints = {
  catalogVersion: number;
  catalogHash: string;
  /** matched patterns, sorted by id for determinism */
  matches: PatternMatch[];
  /** union of flags across matches, sorted */
  flags: string[];
  /** platform_* flags with the prefix stripped, sorted (e.g. ["elementor","wordpress"]) */
  platforms: string[];
  /** no deferred-interactive / motion-lib / counter / nav-toggle signatures and a small tree —
   *  callers may skip optional capture/inference stages for such pages */
  simpleStatic: boolean;
  warnings: string[];
};

const CATALOG_PATH = fileURLToPath(new URL("../../data/pattern-catalog.json", import.meta.url));
const LOCK_PATH = fileURLToPath(new URL("../../data/pattern-catalog.lock", import.meta.url));
const SAMPLE_CIDS = 5;
/** simpleStatic requires the whole tree under this node count (matches "small landing page"). */
const SIMPLE_STATIC_MAX_NODES = 1500;
const SIMPLE_STATIC_BLOCKERS = ["deferred_interactive", "motion_lib", "counter", "nav_toggle"];

type CompiledIndex = {
  catalog: PatternCatalog;
  hash: string;
  byClassToken: Map<string, PatternDef[]>;
  classPrefixes: Array<[string, PatternDef]>;
  byTag: Map<string, PatternDef[]>;
  byAttrName: Map<string, PatternDef[]>;
  idPrefixes: Array<[string, PatternDef]>;
};

let cached: CompiledIndex | null = null;

export function catalogOnlyHints(): boolean {
  // No graph/learning layer exists in this fork, so hints are always catalog-only;
  // the env var's remaining job is turning lock mismatches into hard CI errors.
  return process.env.CATALOG_ONLY_HINTS === "true";
}

function addTo<K>(map: Map<K, PatternDef[]>, key: K, def: PatternDef): void {
  const list = map.get(key);
  if (list) list.push(def);
  else map.set(key, [def]);
}

export function loadPatternIndex(): CompiledIndex {
  if (cached) return cached;
  const raw = readFileSync(CATALOG_PATH, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const catalog = JSON.parse(raw) as PatternCatalog;
  if (!Array.isArray(catalog.patterns)) throw new Error("pattern catalog: missing patterns[]");
  const idx: CompiledIndex = {
    catalog,
    hash,
    byClassToken: new Map(),
    classPrefixes: [],
    byTag: new Map(),
    byAttrName: new Map(),
    idPrefixes: [],
  };
  for (const p of catalog.patterns) {
    for (const t of p.match.classTokens ?? []) addTo(idx.byClassToken, t.toLowerCase(), p);
    for (const pre of p.match.classPrefixes ?? []) idx.classPrefixes.push([pre.toLowerCase(), p]);
    for (const t of p.match.tags ?? []) addTo(idx.byTag, t.toLowerCase(), p);
    for (const a of p.match.attrNames ?? []) addTo(idx.byAttrName, a.toLowerCase(), p);
    for (const pre of p.match.idPrefixes ?? []) idx.idPrefixes.push([pre, p]);
  }
  cached = idx;
  return idx;
}

/** Enforce the frozen-catalog pin. Throws on mismatch when strict (CI default via
 *  CATALOG_ONLY_HINTS=true); otherwise returns a warning string for the hints artifact. */
export function assertPinnedCatalog(opts?: { strict?: boolean }): string | null {
  const idx = loadPatternIndex();
  if (!existsSync(LOCK_PATH)) {
    const msg = "pattern catalog lock missing (data/pattern-catalog.lock)";
    if (opts?.strict ?? catalogOnlyHints()) throw new Error(msg);
    return msg;
  }
  const pinned = readFileSync(LOCK_PATH, "utf8").trim();
  if (pinned !== idx.hash) {
    const msg = `pattern catalog hash mismatch: pinned ${pinned.slice(0, 12)}… actual ${idx.hash.slice(0, 12)}…`;
    if (opts?.strict ?? catalogOnlyHints()) throw new Error(msg);
    return msg;
  }
  return null;
}

function isElement(c: IRChild): c is IRNode {
  return (c as IRNode).id !== undefined;
}

/** Match ONE node's own evidence (srcClass tokens, tag, attr names, id prefix)
 *  against the catalog. Shared by the page-level hint scan and per-candidate
 *  recipe scoring. Returns matched defs, deduped, in catalog order. */
export function matchCatalogNode(node: Pick<IRNode, "tag" | "attrs" | "srcClass">): PatternDef[] {
  const idx = loadPatternIndex();
  const hits = new Set<PatternDef>();
  if (node.srcClass) {
    for (const tok of node.srcClass.toLowerCase().split(/\s+/)) {
      if (!tok) continue;
      for (const def of idx.byClassToken.get(tok) ?? []) hits.add(def);
      for (const [pre, def] of idx.classPrefixes) if (tok.startsWith(pre)) hits.add(def);
    }
  }
  for (const def of idx.byTag.get(node.tag.toLowerCase()) ?? []) hits.add(def);
  for (const attr of Object.keys(node.attrs)) {
    for (const def of idx.byAttrName.get(attr.toLowerCase()) ?? []) hits.add(def);
  }
  const id = node.attrs.id;
  if (id) for (const [pre, def] of idx.idPrefixes) if (id.startsWith(pre)) hits.add(def);
  return idx.catalog.patterns.filter((p) => hits.has(p));
}

/** Single deterministic pre-order walk of the IR: tokenize srcClass, check tag /
 *  attr / id signatures, accumulate per-pattern counts + a bounded cid sample. */
export function resolvePatternHints(ir: IR): PatternHints {
  const idx = loadPatternIndex();
  const warnings: string[] = [];
  const pinWarning = assertPinnedCatalog({ strict: catalogOnlyHints() });
  if (pinWarning) warnings.push(pinWarning);

  const counts = new Map<string, { def: PatternDef; count: number; cids: string[] }>();
  const hit = (def: PatternDef, cid: string, seen: Set<string>) => {
    if (seen.has(def.id)) return; // one hit per node per pattern
    seen.add(def.id);
    let e = counts.get(def.id);
    if (!e) { e = { def, count: 0, cids: [] }; counts.set(def.id, e); }
    e.count++;
    if (e.cids.length < SAMPLE_CIDS) e.cids.push(cid);
  };

  const visit = (node: IRNode) => {
    const seen = new Set<string>();
    for (const def of matchCatalogNode(node)) hit(def, node.id, seen);
    for (const c of node.children) if (isElement(c)) visit(c);
  };
  visit(ir.root);

  const matches: PatternMatch[] = [...counts.values()]
    .map((e) => ({ id: e.def.id, kind: e.def.kind, flags: e.def.flags, count: e.count, cids: e.cids }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const flags = [...new Set(matches.flatMap((m) => m.flags))].sort();
  const platforms = flags
    .filter((f) => f.startsWith("platform_"))
    .map((f) => f.slice("platform_".length))
    .sort();
  const simpleStatic =
    ir.doc.nodeCount < SIMPLE_STATIC_MAX_NODES && !flags.some((f) => SIMPLE_STATIC_BLOCKERS.includes(f));

  return { catalogVersion: idx.catalog.version, catalogHash: idx.hash, matches, flags, platforms, simpleStatic, warnings };
}

// `--write-lock` maintenance entry: refresh the pin after a deliberate catalog edit.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv.includes("--write-lock")) {
  const idx = loadPatternIndex();
  writeFileSync(LOCK_PATH, idx.hash + "\n");
  console.log("pinned pattern catalog:", idx.hash);
}
