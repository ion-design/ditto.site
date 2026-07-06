import type { IR, IRNode, BBox, StyleMap } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { PrimitiveType } from "./primitives.js";
import type { Section } from "./sections.js";
import { round } from "../util/canonical.js";
import { matchCatalogNode, type PatternDef, type PatternHints } from "../knowledge/patternIndex.js";

export type RecipeKind = "logo-cloud" | "feature-grid" | "card-grid" | "product-grid" | "gallery-showcase" | "cta-band";

export type RecipeRisk = "low" | "medium" | "high";

export type RecipeResponsiveRegime = {
  viewport: number;
  layout: "grid" | "flex" | "stack" | "block" | "absolute" | "mixed";
  rootBox: { x: number; y: number; width: number; height: number };
  visibleItems?: number;
  columns?: number;
  rows?: number;
  gapX?: number;
  gapY?: number;
};

export type RecipeRepeatedItem = {
  cid: string;
  tag: string;
  textSample: string;
  mediaCount: number;
  headingCount: number;
  bbox: { x: number; y: number; width: number; height: number };
};

export type RecipeCandidate = {
  id: string;
  kind: RecipeKind;
  confidence: number;
  risk: RecipeRisk;
  rootCid: string;
  rootTag: string;
  itemParentCid?: string;
  sectionId?: string;
  sectionRole?: string;
  componentName: string;
  dataModel?: string;
  itemCount?: number;
  repeatedItems?: RecipeRepeatedItem[];
  responsiveRegimes: RecipeResponsiveRegime[];
  sourceHints: string[];
  signals: string[];
  emissionStatus: "report-only";
  fallbackReason: string;
};

export type RecipeReport = {
  version: 1;
  sourceUrl: string;
  canonicalViewport: number;
  viewports: number[];
  sampledViewports: number[];
  summary: {
    totalCandidates: number;
    highConfidence: number;
    byKind: Record<string, number>;
    templateReadyKinds: RecipeKind[];
    /** page-level frozen-catalog pattern ids (from resolvePatternHints), when provided */
    catalogPatterns?: string[];
  };
  candidates: RecipeCandidate[];
};

type ParentMap = Map<string, IRNode | undefined>;
type NodeMap = Map<string, IRNode>;
type SectionMap = Map<string, Section>;

type RecipeContext = {
  ir: IR;
  cw: number;
  viewports: number[];
  sampledViewports: number[];
  nodes: IRNode[];
  byId: NodeMap;
  parentById: ParentMap;
  sectionByNodeId: SectionMap;
  primitives: Map<string, PrimitiveType>;
  /** per-node frozen-catalog matches, memoized (pattern catalog as a 4th evidence source) */
  catalogByCid: Map<string, PatternDef[]>;
  /** page-level catalog flags from resolvePatternHints (e.g. platform_shopify, ecommerce) */
  pageFlags: Set<string>;
};

type ItemStats = {
  node: IRNode;
  text: string;
  textLen: number;
  mediaCount: number;
  headingCount: number;
  buttonCount: number;
  linkCount: number;
  hasSurface: boolean;
  bbox?: BBox;
};

type RecipeDraft = Omit<RecipeCandidate, "id">;

const TEMPLATE_READY: RecipeKind[] = ["logo-cloud", "feature-grid", "card-grid", "product-grid", "cta-band"];
const TRANSPARENT = new Set(["", "transparent", "rgba(0, 0, 0, 0)", "rgba(0,0,0,0)"]);
const TRUSTED_COPY = /\b(?:trusted by|used by|loved by|teams at|customers|brands|companies|partners|sponsors|backed by|featured in)\b/i;
const FEATURE_COPY = /\b(?:feature|features|capabilities|benefits|workflow|workflows|platform|built for|designed for|prototype|collaboration|secure|iterate)\b/i;
const CARD_COPY = /\b(?:shop|products?|collections?|categories|resources?|articles?|blog|latest|popular|stories|cards?)\b/i;
const PRODUCT_COPY = /\b(?:buy|shop now|add to cart|add to bag|checkout|price|from\s+[$£€]?\d|sale|trade in|learn more\s+buy|now with|supercharged|airpods?|iphone|ipad|mac(?:book)?|apple watch)\b|[$£€]\s?\d/i;
const PRODUCT_SOURCE = /\b(?:product|products|shop|store|commerce|collection|collections|catalog|merch|promo|tile|buy|price|cart)\b/i;
const GALLERY_SOURCE = /\b(?:media-gallery|gallery|carousel|slider|swiper|splide|showcase|tabpanel|tablist|track)\b/i;
const GALLERY_COPY = /\b(?:gallery|stream now|watch now|listen now|play now|featured|entertainment|shows?|movies?|episode|season|sports?)\b/i;
const TESTIMONIAL_SOURCE = /\b(?:testimonial|testimonials|quote|quotes|customer|customers|story|stories|isHorizontal)\b/i;
const TESTIMONIAL_COPY = /[“”]|\b(?:testimonial|testimonials|trusted by builders|endorsed by|ceo|cto|founder|customer|customers|databricks|trusted enterprise)\b/i;
const CTA_COPY = /\b(?:get started|start|try|join|sign up|book|contact|shop now|learn more|download|apply|subscribe)\b/i;
const DEFERRED_INTERACTIVE_COLLECTION = /\b(?:rfm-|marquee|carousel|swiper|splide|slider|ticker)\b/i;
const RECIPE_HINT = /(?:^|[-_:])(grid|flex|gap|container|max-w|mx-auto|logo|logos|brand|brands|feature|features|card|cards|product|products|promo|commerce|collection|shop|gallery|showcase|carousel|slider|media|cta|hero|footer|nav|trusted|sponsor|partner|customer|cols?|columns?|section)(?:$|[-_:])/i;
const BREAKPOINT_HINT = /^(?:max-)?(?:sm|md|lg|xl|2xl):|^(?:min|max)-\[/;

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

function px(v: string | undefined): number {
  if (!v) return 0;
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  return m ? parseFloat(m[0]) : 0;
}

function elementChildren(n: IRNode): IRNode[] {
  return n.children.filter((c): c is IRNode => !isTextChild(c));
}

function visibleAt(n: IRNode, vp: number): boolean {
  const b = n.bboxByVp[vp];
  return !!n.visibleByVp[vp] && !!b && b.width > 1 && b.height > 1;
}

function visibleElementChildren(n: IRNode, vp: number): IRNode[] {
  return elementChildren(n).filter((c) => visibleAt(c, vp));
}

function displayOf(n: IRNode, vp: number): string {
  return n.computedByVp[vp]?.display ?? "";
}

function textContent(n: IRNode, max = 2000): string {
  let out = "";
  const walk = (x: IRNode): void => {
    if (out.length >= max) return;
    for (const c of x.children) {
      if (isTextChild(c)) out += " " + c.text;
      else walk(c);
      if (out.length >= max) return;
    }
  };
  walk(n);
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function directText(n: IRNode): string {
  return n.children
    .filter(isTextChild)
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNonTransparentBg(cs: StyleMap | undefined): boolean {
  return !!cs?.backgroundColor && !TRANSPARENT.has(cs.backgroundColor);
}

function hasBorder(cs: StyleMap | undefined): boolean {
  if (!cs) return false;
  return px(cs.borderTopWidth) > 0 || px(cs.borderRightWidth) > 0 || px(cs.borderBottomWidth) > 0 || px(cs.borderLeftWidth) > 0;
}

function hasSurface(n: IRNode, vp: number): boolean {
  const cs = n.computedByVp[vp];
  if (!cs) return false;
  const shadow = cs.boxShadow && cs.boxShadow !== "none";
  const radius = px(cs.borderTopLeftRadius) >= 4;
  return hasNonTransparentBg(cs) || hasBorder(cs) || !!shadow || radius;
}

function isMediaNode(n: IRNode, vp: number): boolean {
  if (/^(img|svg|picture|video|canvas|iframe)$/.test(n.tag)) return true;
  const bg = n.computedByVp[vp]?.backgroundImage ?? "";
  return /\burl\(/.test(bg);
}

function countMedia(n: IRNode, vp: number): number {
  let count = isMediaNode(n, vp) ? 1 : 0;
  for (const c of elementChildren(n)) count += countMedia(c, vp);
  return count;
}

function fontWeightNumber(v: string | undefined): number {
  if (!v) return 400;
  if (v === "bold") return 700;
  if (v === "normal") return 400;
  return px(v) || 400;
}

function isHeadingLike(n: IRNode, vp: number): boolean {
  if (/^h[1-6]$/.test(n.tag)) return true;
  const text = directText(n);
  if (!text || text.length > 96) return false;
  const cs = n.computedByVp[vp];
  const fs = px(cs?.fontSize);
  const fw = fontWeightNumber(cs?.fontWeight);
  return fs >= 20 || (fs >= 12 && fw >= 600);
}

function countHeadings(n: IRNode, vp: number): number {
  let count = isHeadingLike(n, vp) ? 1 : 0;
  for (const c of elementChildren(n)) count += countHeadings(c, vp);
  return count;
}

function countPrimitive(n: IRNode, primitives: Map<string, PrimitiveType>, types: Set<PrimitiveType>): number {
  let count = types.has(primitives.get(n.id) as PrimitiveType) ? 1 : 0;
  for (const c of elementChildren(n)) count += countPrimitive(c, primitives, types);
  return count;
}

function nodeStats(ctx: RecipeContext, n: IRNode): ItemStats {
  const text = textContent(n, 500);
  return {
    node: n,
    text,
    textLen: text.length,
    mediaCount: countMedia(n, ctx.cw),
    headingCount: countHeadings(n, ctx.cw),
    buttonCount: countPrimitive(n, ctx.primitives, new Set(["button"])),
    linkCount: countPrimitive(n, ctx.primitives, new Set(["link"])),
    hasSurface: hasSurface(n, ctx.cw),
    bbox: n.bboxByVp[ctx.cw],
  };
}

function buildContext(ir: IR, sections: Section[], primitives: Map<string, PrimitiveType>, patternHints?: PatternHints): RecipeContext {
  const nodes: IRNode[] = [];
  const byId: NodeMap = new Map();
  const parentById: ParentMap = new Map();
  const walk = (n: IRNode, parent: IRNode | undefined): void => {
    nodes.push(n);
    byId.set(n.id, n);
    parentById.set(n.id, parent);
    for (const c of elementChildren(n)) walk(c, n);
  };
  walk(ir.root, undefined);
  return {
    ir,
    cw: ir.doc.canonicalViewport,
    viewports: [...ir.doc.viewports].sort((a, b) => a - b),
    sampledViewports: [...(ir.doc.sampleViewports.length ? ir.doc.sampleViewports : ir.doc.viewports)].sort((a, b) => a - b),
    nodes,
    byId,
    parentById,
    sectionByNodeId: new Map(sections.map((s) => [s.nodeId, s])),
    primitives,
    catalogByCid: new Map(),
    pageFlags: new Set(patternHints?.flags ?? []),
  };
}

function catalogDefs(ctx: RecipeContext, node: IRNode): PatternDef[] {
  let defs = ctx.catalogByCid.get(node.id);
  if (!defs) {
    defs = matchCatalogNode(node);
    ctx.catalogByCid.set(node.id, defs);
  }
  return defs;
}

/** First catalog pattern in `root`'s subtree matching `pred` (pre-order; memoized
 *  per node). The frozen catalog is deterministic, so recipe evidence stays
 *  byte-stable across regenerations. */
function subtreeCatalogMatch(ctx: RecipeContext, root: IRNode, pred: (d: PatternDef) => boolean): PatternDef | null {
  for (const d of catalogDefs(ctx, root)) if (pred(d)) return d;
  for (const c of elementChildren(root)) {
    const hit = subtreeCatalogMatch(ctx, c, pred);
    if (hit) return hit;
  }
  return null;
}

function nearestSection(ctx: RecipeContext, n: IRNode): Section | undefined {
  let cur: IRNode | undefined = n;
  while (cur) {
    const section = ctx.sectionByNodeId.get(cur.id);
    if (section) return section;
    cur = ctx.parentById.get(cur.id);
  }
  return undefined;
}

function recipeRoot(ctx: RecipeContext, itemParent: IRNode): { root: IRNode; section?: Section } {
  const section = nearestSection(ctx, itemParent);
  if (!section || section.nodeId === ctx.ir.root.id) return { root: itemParent };
  const root = ctx.byId.get(section.nodeId);
  return root ? { root, section } : { root: itemParent };
}

function collectSourceHints(root: IRNode): string[] {
  const hints = new Set<string>();
  const walk = (n: IRNode): void => {
    if (hints.size >= 18) return;
    const cls = n.srcClass;
    if (cls) {
      for (const tok of cls.split(/\s+/)) {
        if (!tok) continue;
        if (RECIPE_HINT.test(tok) || BREAKPOINT_HINT.test(tok)) hints.add(tok);
        if (hints.size >= 18) break;
      }
    }
    for (const c of elementChildren(n)) walk(c);
  };
  walk(root);
  return [...hints].sort();
}

function subtreeSourceClassMatches(root: IRNode, re: RegExp): boolean {
  if (root.srcClass && re.test(root.srcClass)) return true;
  for (const c of elementChildren(root)) if (subtreeSourceClassMatches(c, re)) return true;
  return false;
}

function subtreeAttrOrSourceMatches(root: IRNode, re: RegExp): boolean {
  if (root.srcClass && re.test(root.srcClass)) return true;
  for (const value of Object.values(root.attrs)) if (re.test(value)) return true;
  for (const c of elementChildren(root)) if (subtreeAttrOrSourceMatches(c, re)) return true;
  return false;
}

function textSample(s: string, max = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

function repeatedItems(ctx: RecipeContext, stats: ItemStats[]): RecipeRepeatedItem[] {
  return stats.map((s) => {
    const b = s.bbox ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      cid: s.node.id,
      tag: s.node.tag,
      textSample: textSample(s.text),
      mediaCount: s.mediaCount,
      headingCount: s.headingCount,
      bbox: { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) },
    };
  });
}

function median(values: number[]): number | undefined {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const mid = Math.floor(xs.length / 2);
  const val = xs.length % 2 ? xs[mid] : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
  return val === undefined ? undefined : round(val);
}

function groupRows(items: Array<{ node: IRNode; box: BBox }>): Array<Array<{ node: IRNode; box: BBox }>> {
  const sorted = items.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: Array<Array<{ node: IRNode; box: BBox }>> = [];
  for (const item of sorted) {
    const tol = Math.max(8, Math.min(32, item.box.height * 0.28));
    const row = rows.find((r) => Math.abs((r[0]?.box.y ?? item.box.y) - item.box.y) <= tol);
    if (row) row.push(item);
    else rows.push([item]);
  }
  for (const row of rows) row.sort((a, b) => a.box.x - b.box.x);
  return rows;
}

function gapsFor(rows: Array<Array<{ node: IRNode; box: BBox }>>): { gapX?: number; gapY?: number } {
  const gapXs: number[] = [];
  for (const row of rows) {
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1]!;
      const cur = row[i]!;
      gapXs.push(cur.box.x - (prev.box.x + prev.box.width));
    }
  }
  const rowYs = rows.map((r) => {
    const y = Math.min(...r.map((i) => i.box.y));
    const bottom = Math.max(...r.map((i) => i.box.y + i.box.height));
    return { y, bottom };
  }).sort((a, b) => a.y - b.y);
  const gapYs: number[] = [];
  for (let i = 1; i < rowYs.length; i++) {
    const prev = rowYs[i - 1]!;
    const cur = rowYs[i]!;
    gapYs.push(cur.y - prev.bottom);
  }
  return { gapX: median(gapXs), gapY: median(gapYs) };
}

function regimeAt(ctx: RecipeContext, root: IRNode, itemNodes: IRNode[] | undefined, vp: number): RecipeResponsiveRegime | undefined {
  const rootBox = root.bboxByVp[vp];
  if (!rootBox || !visibleAt(root, vp)) return undefined;
  const display = displayOf(root, vp);
  const itemBoxes = (itemNodes ?? [])
    .map((node) => ({ node, box: node.bboxByVp[vp] }))
    .filter((x): x is { node: IRNode; box: BBox } => !!x.box && visibleAt(x.node, vp));
  const rows = itemBoxes.length ? groupRows(itemBoxes) : [];
  const columns = rows.length ? Math.max(...rows.map((r) => r.length)) : undefined;
  const rowCount = rows.length || undefined;
  const gaps = rows.length ? gapsFor(rows) : {};
  const layout = display.includes("grid")
    ? "grid"
    : display.includes("flex")
      ? "flex"
      : display.includes("absolute")
        ? "absolute"
        : columns === 1 && (rowCount ?? 0) > 1
          ? "stack"
          : display.includes("block")
            ? "block"
            : "mixed";
  return {
    viewport: vp,
    layout,
    rootBox: { x: round(rootBox.x), y: round(rootBox.y), width: round(rootBox.width), height: round(rootBox.height) },
    ...(itemNodes ? { visibleItems: itemBoxes.length, columns, rows: rowCount, ...gaps } : {}),
  };
}

function responsiveRegimes(ctx: RecipeContext, root: IRNode, items?: IRNode[]): RecipeResponsiveRegime[] {
  const out: RecipeResponsiveRegime[] = [];
  let prevSig = "";
  for (const vp of ctx.sampledViewports) {
    const r = regimeAt(ctx, root, items, vp);
    if (!r) continue;
    const sig = [r.layout, r.visibleItems ?? "-", r.columns ?? "-", r.rows ?? "-"].join(":");
    if (sig !== prevSig || ctx.viewports.includes(vp)) {
      out.push(r);
      prevSig = sig;
    }
  }
  return out;
}

function isLayoutish(ctx: RecipeContext, parent: IRNode, items: IRNode[]): boolean {
  const display = displayOf(parent, ctx.cw);
  if (display.includes("grid") || display.includes("flex")) return true;
  const regime = regimeAt(ctx, parent, items, ctx.cw);
  return (regime?.columns ?? 0) >= 2 || (regime?.rows ?? 0) >= 2;
}

function hasGridBehavior(ctx: RecipeContext, parent: IRNode, items: IRNode[]): boolean {
  let maxColumns = 0;
  for (const vp of ctx.sampledViewports) {
    const regime = regimeAt(ctx, parent, items, vp);
    maxColumns = Math.max(maxColumns, regime?.columns ?? 0);
  }
  return maxColumns >= 2;
}

function itemAreaOk(stat: ItemStats, minW: number, minH: number): boolean {
  const b = stat.bbox;
  return !!b && b.width >= minW && b.height >= minH;
}

function isLikelyLogoItem(stat: ItemStats): boolean {
  const b = stat.bbox;
  if (!b || stat.mediaCount < 1 || stat.headingCount > 0 || stat.buttonCount > 0) return false;
  if (stat.textLen > 40) return false;
  return b.width <= 360 && b.height <= 180;
}

function isLikelyFeatureItem(stat: ItemStats): boolean {
  if (!itemAreaOk(stat, 120, 80)) return false;
  if (stat.textLen < 18 || stat.textLen > 650) return false;
  if (stat.headingCount < 1) return false;
  return stat.mediaCount > 0 || stat.hasSurface || stat.buttonCount > 0;
}

function isLikelyCardItem(stat: ItemStats): boolean {
  if (!itemAreaOk(stat, 140, 120)) return false;
  if (stat.mediaCount < 1) return false;
  if (stat.textLen > 900) return false;
  return stat.textLen >= 8 || stat.buttonCount > 0 || stat.linkCount > 0 || stat.hasSurface;
}

function isLikelyProductItem(stat: ItemStats): boolean {
  if (!itemAreaOk(stat, 120, 110)) return false;
  if (stat.mediaCount < 1 || stat.textLen > 700) return false;
  if (PRODUCT_COPY.test(stat.text)) return true;
  return stat.headingCount > 0 && (stat.buttonCount > 0 || stat.linkCount > 0);
}

function componentNameFor(kind: RecipeKind): string {
  switch (kind) {
    case "logo-cloud": return "LogoCloudSection";
    case "feature-grid": return "FeatureGridSection";
    case "card-grid": return "CardGridSection";
    case "product-grid": return "ProductGridSection";
    case "gallery-showcase": return "GalleryShowcaseSection";
    case "cta-band": return "CtaBandSection";
  }
}

function dataModelFor(kind: RecipeKind): string | undefined {
  switch (kind) {
    case "logo-cloud": return "logos";
    case "feature-grid": return "features";
    case "card-grid": return "cards";
    case "product-grid": return "products";
    case "gallery-showcase": return undefined;
    case "cta-band": return undefined;
  }
}

function itemSetKey(kind: RecipeKind, stats: ItemStats[]): string {
  return kind + ":" + stats.map((s) => s.node.id).join(",");
}

function overlapRatio(a: RecipeDraft, b: RecipeDraft): number {
  const aa = new Set((a.repeatedItems ?? []).map((i) => i.cid));
  const bb = new Set((b.repeatedItems ?? []).map((i) => i.cid));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const id of aa) if (bb.has(id)) hit++;
  return hit / Math.min(aa.size, bb.size);
}

function isAncestorOrSelf(ctx: RecipeContext, ancestorCid: string, childCid: string): boolean {
  let cur = ctx.byId.get(childCid);
  while (cur) {
    if (cur.id === ancestorCid) return true;
    cur = ctx.parentById.get(cur.id);
  }
  return false;
}

function baseDraft(ctx: RecipeContext, kind: RecipeKind, parent: IRNode, stats: ItemStats[], confidence: number, signals: string[]): RecipeDraft {
  const { root, section } = recipeRoot(ctx, parent);
  const rootText = textContent(root, 1000);
  return {
    kind,
    confidence: round(clamp(confidence), 2),
    risk: confidence >= 0.86 ? "low" : confidence >= 0.74 ? "medium" : "high",
    rootCid: root.id,
    rootTag: root.tag,
    itemParentCid: parent.id,
    ...(section ? { sectionId: section.id, sectionRole: section.role } : {}),
    componentName: componentNameFor(kind),
    dataModel: dataModelFor(kind),
    itemCount: stats.length,
    repeatedItems: repeatedItems(ctx, stats),
    responsiveRegimes: responsiveRegimes(ctx, root, stats.map((s) => s.node)),
    sourceHints: collectSourceHints(root),
    signals: [...signals, rootText && TRUSTED_COPY.test(rootText) ? "section copy contains social-proof language" : ""].filter(Boolean),
    emissionStatus: "report-only",
    fallbackReason: "inventory-only pass; current generator still emits the measured subtree",
  };
}

function detectLogoClouds(ctx: RecipeContext): RecipeDraft[] {
  const out: RecipeDraft[] = [];
  const seen = new Set<string>();
  for (const parent of ctx.nodes) {
    const kids = visibleElementChildren(parent, ctx.cw);
    if (kids.length < 3 || kids.length > 40) continue;
    const stats = kids.map((k) => nodeStats(ctx, k));
    const logos = stats.filter(isLikelyLogoItem);
    if (logos.length < 3 || logos.length / kids.length < 0.55) continue;
    const key = itemSetKey("logo-cloud", logos);
    if (seen.has(key)) continue;
    seen.add(key);
    const { root } = recipeRoot(ctx, parent);
    const rootText = textContent(root, 1200);
    const layout = isLayoutish(ctx, parent, logos.map((s) => s.node));
    const avgHeight = logos.reduce((sum, s) => sum + (s.bbox?.height ?? 0), 0) / logos.length;
    // Logo strips often ride marquee libraries (react-fast-marquee, ticker) —
    // a catalog marquee hit is strong logo-cloud evidence.
    const catalogMarquee = subtreeCatalogMatch(ctx, parent, (d) => d.kind === "marquee");
    const signals = [
      `${logos.length} repeated media-light children`,
      layout ? "item parent behaves like grid/flex/wrapped row" : "item parent has repeated logo geometry",
      TRUSTED_COPY.test(rootText) ? "nearby copy matches trusted-by/brand language" : "",
      avgHeight <= 96 ? "logo item boxes stay small" : "",
      catalogMarquee ? `pattern catalog identifies a ${catalogMarquee.id} strip` : "",
    ].filter(Boolean);
    const confidence = 0.58
      + Math.min(0.18, logos.length * 0.025)
      + (logos.length / kids.length) * 0.12
      + (layout ? 0.08 : 0)
      + (TRUSTED_COPY.test(rootText) ? 0.10 : 0)
      + (avgHeight <= 96 ? 0.04 : 0)
      + (catalogMarquee ? 0.04 : 0);
    out.push(baseDraft(ctx, "logo-cloud", parent, logos, confidence, signals));
  }
  return out;
}

function detectGrids(ctx: RecipeContext): RecipeDraft[] {
  const out: RecipeDraft[] = [];
  const seen = new Set<string>();
  for (const parent of ctx.nodes) {
    if (parent.id === ctx.ir.root.id) continue;
    if (subtreeSourceClassMatches(parent, DEFERRED_INTERACTIVE_COLLECTION)) continue;
    // Catalog-known carousel/marquee libraries the regex misses (embla, flickity,
    // keen-slider, glide, tns, …) are the same deferred-interactive class: their
    // children are slides, not a static grid.
    if (subtreeCatalogMatch(ctx, parent, (d) => d.kind === "carousel" || d.kind === "marquee")) continue;
    const kids = visibleElementChildren(parent, ctx.cw);
    if (kids.length < 2 || kids.length > 36) continue;
    const stats = kids.map((k) => nodeStats(ctx, k));
    const logoRatio = stats.filter(isLikelyLogoItem).length / kids.length;
    if (logoRatio > 0.65) continue;
    const layout = hasGridBehavior(ctx, parent, kids);
    if (!layout) continue;
    const rootInfo = recipeRoot(ctx, parent);
    const pageH = ctx.ir.doc.perViewport[ctx.cw]?.scrollHeight ?? 0;
    const rootBox = rootInfo.root.bboxByVp[ctx.cw];
    const rootTooBroad = rootInfo.root.id === ctx.ir.root.id || (!!pageH && !!rootBox && rootBox.height > pageH * 0.55);
    const localText = textContent(parent, 1200);
    const parentText = rootTooBroad ? localText : textContent(rootInfo.root, 1600);
    // Lightbox libraries (fancybox, photoswipe, lightGallery, …) mark a thumbnail
    // grid as a gallery even when no gallery-ish class names are present.
    const catalogLightbox = subtreeCatalogMatch(ctx, parent, (d) => d.kind === "lightbox");
    const galleryContext = subtreeAttrOrSourceMatches(parent, GALLERY_SOURCE) || (!rootTooBroad && subtreeAttrOrSourceMatches(rootInfo.root, GALLERY_SOURCE)) || !!catalogLightbox;
    const testimonialContext = subtreeAttrOrSourceMatches(parent, TESTIMONIAL_SOURCE) || TESTIMONIAL_COPY.test(localText);
    const featureItems = stats.filter(isLikelyFeatureItem);
    const cardItems = stats.filter(isLikelyCardItem);
    const cardLikeItems = stats.filter((s) => isLikelyFeatureItem(s) || isLikelyCardItem(s));
    if ((galleryContext || testimonialContext) && cardLikeItems.length >= 3 && cardLikeItems.length / kids.length >= 0.45) {
      const key = itemSetKey("gallery-showcase", cardLikeItems);
      if (!seen.has(key)) {
        seen.add(key);
        const oneRowRegimes = responsiveRegimes(ctx, recipeRoot(ctx, parent).root, cardLikeItems.map((s) => s.node))
          .filter((r) => (r.visibleItems ?? 0) >= 3 && (r.rows ?? 0) <= 1).length;
        const mediaRatio = cardLikeItems.filter((s) => s.mediaCount > 0).length / cardLikeItems.length;
        const galleryCopy = GALLERY_COPY.test(parentText);
        const testimonialCopy = TESTIMONIAL_COPY.test(localText);
        const signals = [
          `${cardLikeItems.length} repeated ${testimonialContext ? "testimonial/gallery" : "media/gallery"} items`,
          galleryContext ? "source attributes/classes identify a gallery or carousel track" : "",
          catalogLightbox ? `pattern catalog identifies a ${catalogLightbox.id} lightbox gallery` : "",
          testimonialContext ? "source text/classes identify a testimonial or horizontal story strip" : "",
          oneRowRegimes >= 2 ? "items remain in a horizontal gallery row across sampled widths" : "",
          mediaRatio >= 0.6 ? "most gallery items include media" : "",
          galleryCopy ? "copy matches media/entertainment gallery language" : "",
          testimonialCopy ? "copy matches testimonial/social-proof language" : "",
        ].filter(Boolean);
        const confidence = 0.62
          + Math.min(0.15, cardLikeItems.length * 0.018)
          + (layout ? 0.08 : 0)
          + (oneRowRegimes >= 2 ? 0.08 : 0)
          + (mediaRatio >= 0.6 ? 0.04 : 0)
          + (galleryCopy ? 0.04 : 0)
          + (testimonialCopy ? 0.05 : 0);
        out.push(baseDraft(ctx, "gallery-showcase", parent, cardLikeItems, confidence, signals));
      }
      continue;
    }

    const productItems = stats.filter(isLikelyProductItem);
    const forbiddenProductContext = subtreeAttrOrSourceMatches(parent, /\b(?:footer|directory|nav|menu)\b/i)
      || (!rootTooBroad && subtreeAttrOrSourceMatches(rootInfo.root, /\b(?:footer|directory|nav|menu)\b/i));
    // Page-level catalog prior: a Shopify/WooCommerce page makes repeated card
    // grids product grids even when per-node class names carry no commerce words.
    const catalogCommerce = ctx.pageFlags.has("ecommerce") || ctx.pageFlags.has("platform_shopify");
    const productContext = !forbiddenProductContext &&
      (PRODUCT_COPY.test(localText) || subtreeAttrOrSourceMatches(parent, PRODUCT_SOURCE)
        || (!rootTooBroad && (PRODUCT_COPY.test(parentText) || subtreeAttrOrSourceMatches(rootInfo.root, PRODUCT_SOURCE)))
        || catalogCommerce);
    const productStats = productItems.length >= 2 ? productItems : (productContext ? cardLikeItems : []);
    if (productStats.length >= 2 && productStats.length / kids.length >= 0.45 && productContext) {
      const key = itemSetKey("product-grid", productStats);
      if (!seen.has(key)) {
        seen.add(key);
        const ctaRatio = productStats.filter((s) => s.buttonCount > 0 || s.linkCount > 0).length / productStats.length;
        const productCopyRatio = productStats.filter((s) => PRODUCT_COPY.test(s.text)).length / productStats.length;
        const signals = [
          `${productStats.length} repeated product/promo cards`,
          layout ? "children form a grid/flex responsive layout" : "children form repeated product geometry",
          productCopyRatio >= 0.5 ? "most items contain commerce/product copy" : "",
          ctaRatio >= 0.5 ? "most products include link/button affordances" : "",
          (subtreeAttrOrSourceMatches(parent, PRODUCT_SOURCE) || (!rootTooBroad && subtreeAttrOrSourceMatches(rootInfo.root, PRODUCT_SOURCE))) ? "source context is product/promo/commerce-like" : "",
          catalogCommerce ? "pattern catalog identifies an e-commerce platform page" : "",
        ].filter(Boolean);
        const confidence = 0.58
          + Math.min(0.14, productStats.length * 0.025)
          + (productStats.length / kids.length) * 0.10
          + (layout ? 0.10 : 0)
          + (productCopyRatio >= 0.5 ? 0.07 : 0)
          + (ctaRatio >= 0.5 ? 0.05 : 0)
          + ((subtreeAttrOrSourceMatches(parent, PRODUCT_SOURCE) || (!rootTooBroad && subtreeAttrOrSourceMatches(rootInfo.root, PRODUCT_SOURCE))) ? 0.06 : 0)
          + (catalogCommerce ? 0.05 : 0);
        out.push(baseDraft(ctx, "product-grid", parent, productStats, confidence, signals));
      }
      continue;
    }

    if (featureItems.length >= 3 && featureItems.length / kids.length >= 0.5) {
      const key = itemSetKey("feature-grid", featureItems);
      if (!seen.has(key)) {
        seen.add(key);
        const mediaRatio = featureItems.filter((s) => s.mediaCount > 0).length / featureItems.length;
        const surfaceRatio = featureItems.filter((s) => s.hasSurface).length / featureItems.length;
        const signals = [
          `${featureItems.length} repeated title/body cards`,
          layout ? "children form a grid/flex responsive layout" : "children form repeated card geometry",
          mediaRatio >= 0.5 ? "most feature cards include media/icon content" : "",
          surfaceRatio >= 0.5 ? "most feature cards have card surfaces" : "",
          FEATURE_COPY.test(parentText) ? "section copy/source context is feature-like" : "",
        ].filter(Boolean);
        const confidence = 0.55
          + Math.min(0.16, featureItems.length * 0.025)
          + (featureItems.length / kids.length) * 0.10
          + (layout ? 0.10 : 0)
          + (mediaRatio >= 0.5 ? 0.06 : 0)
          + (surfaceRatio >= 0.5 ? 0.04 : 0)
          + (FEATURE_COPY.test(parentText) ? 0.06 : 0);
        out.push(baseDraft(ctx, "feature-grid", parent, featureItems, confidence, signals));
      }
    }
    if (cardItems.length >= 2 && cardItems.length / kids.length >= 0.5) {
      const key = itemSetKey("card-grid", cardItems);
      if (seen.has(key)) continue;
      seen.add(key);
      const ctaRatio = cardItems.filter((s) => s.buttonCount > 0 || s.linkCount > 0).length / cardItems.length;
      const headingRatio = cardItems.filter((s) => s.headingCount > 0).length / cardItems.length;
      const signals = [
        `${cardItems.length} repeated media cards`,
        layout ? "children form a grid/flex responsive layout" : "children form repeated card geometry",
        ctaRatio >= 0.5 ? "most cards include link/button affordances" : "",
        headingRatio >= 0.5 ? "most cards include title-like text" : "",
        CARD_COPY.test(parentText) ? "section copy/source context is card/product-like" : "",
      ].filter(Boolean);
      const confidence = 0.50
        + Math.min(0.16, cardItems.length * 0.035)
        + (cardItems.length / kids.length) * 0.10
        + (layout ? 0.11 : 0)
        + (ctaRatio >= 0.5 ? 0.05 : 0)
        + (headingRatio >= 0.5 ? 0.04 : 0)
        + (CARD_COPY.test(parentText) ? 0.06 : 0);
      out.push(baseDraft(ctx, "card-grid", parent, cardItems, confidence, signals));
    }
  }
  return out;
}

function detectCtaBands(ctx: RecipeContext): RecipeDraft[] {
  const out: RecipeDraft[] = [];
  const sectionNodes = [...ctx.sectionByNodeId.values()]
    .map((s) => ctx.byId.get(s.nodeId))
    .filter((n): n is IRNode => !!n && n.id !== ctx.ir.root.id);
  const seenNodes = new Set<string>();
  const nodes = [...sectionNodes, ...ctx.nodes.filter((n) => n.id !== ctx.ir.root.id)]
    .filter((n) => {
      if (seenNodes.has(n.id)) return false;
      seenNodes.add(n.id);
      return true;
    });
  for (const node of nodes) {
    if (!visibleAt(node, ctx.cw)) continue;
    if (/^(header|nav|footer)$/.test(node.tag)) continue;
    const b = node.bboxByVp[ctx.cw];
    if (!b || b.width < ctx.cw * 0.45 || b.height < 72 || b.height > 900) continue;
    const text = textContent(node, 1200);
    if (text.length < 12 || text.length > 900) continue;
    const headings = countHeadings(node, ctx.cw);
    const buttons = countPrimitive(node, ctx.primitives, new Set(["button"]));
    if (headings < 1 || headings > 2 || buttons < 1 || buttons > 3) continue;
    const directKids = visibleElementChildren(node, ctx.cw);
    const repeatedCardKids = directKids.map((k) => nodeStats(ctx, k)).filter((s) => isLikelyFeatureItem(s) || isLikelyCardItem(s));
    if (repeatedCardKids.length >= 3) continue;
    const cs = node.computedByVp[ctx.cw];
    const centered = cs?.textAlign === "center";
    const ctaCopy = CTA_COPY.test(text);
    const ctaHint = subtreeSourceClassMatches(node, /\b(?:cta|call-to-action)\b/i);
    if (!ctaCopy && !ctaHint) continue;
    const signals = [
      `${headings} heading-like node(s) and ${buttons} button-like CTA(s)`,
      centered ? "section text is centered" : "",
      ctaCopy ? "copy contains CTA language" : "",
      ctaHint ? "source hints contain CTA naming" : "",
      hasSurface(node, ctx.cw) ? "bounded visual surface/background" : "",
    ].filter(Boolean);
    const section = ctx.sectionByNodeId.get(node.id);
    const confidence = 0.52
      + Math.min(0.10, headings * 0.04)
      + Math.min(0.12, buttons * 0.04)
      + (centered ? 0.06 : 0)
      + (ctaCopy ? 0.10 : 0)
      + (hasSurface(node, ctx.cw) ? 0.05 : 0);
    out.push({
      kind: "cta-band",
      confidence: round(clamp(confidence), 2),
      risk: confidence >= 0.86 ? "low" : confidence >= 0.74 ? "medium" : "high",
      rootCid: node.id,
      rootTag: node.tag,
      ...(section ? { sectionId: section.id, sectionRole: section.role } : {}),
      componentName: "CtaBandSection",
      responsiveRegimes: responsiveRegimes(ctx, node),
      sourceHints: collectSourceHints(node),
      signals,
      emissionStatus: "report-only",
      fallbackReason: "inventory-only pass; current generator still emits the measured subtree",
    });
  }
  return out;
}

function recipeRank(d: RecipeDraft): number {
  const kindBoost =
    d.kind === "gallery-showcase" ? 0.08 :
    d.kind === "product-grid" ? 0.07 :
    d.kind === "feature-grid" ? 0.03 :
    d.kind === "card-grid" ? 0.01 :
    0;
  return d.confidence + kindBoost + (d.kind === "cta-band" && d.rootTag === "section" ? 0.03 : 0);
}

function nestedItemOverlap(ctx: RecipeContext, a: RecipeDraft, b: RecipeDraft): number {
  const aa = a.repeatedItems ?? [];
  const bb = b.repeatedItems ?? [];
  if (!aa.length || !bb.length) return 0;
  let hit = 0;
  for (const itemA of aa) {
    if (bb.some((itemB) => isAncestorOrSelf(ctx, itemA.cid, itemB.cid) || isAncestorOrSelf(ctx, itemB.cid, itemA.cid))) hit++;
  }
  return hit / Math.min(aa.length, bb.length);
}

function suppressDuplicates(ctx: RecipeContext, drafts: RecipeDraft[]): RecipeDraft[] {
  const gridItemRoots = new Set<string>();
  for (const d of drafts) {
    if (d.kind !== "feature-grid" && d.kind !== "card-grid") continue;
    for (const item of d.repeatedItems ?? []) gridItemRoots.add(item.cid);
  }
  drafts = drafts.filter((d) => {
    if (d.kind !== "cta-band") return true;
    for (const itemCid of gridItemRoots) {
      if (isAncestorOrSelf(ctx, itemCid, d.rootCid)) return false;
    }
    return true;
  });

  const keyed = new Map<string, RecipeDraft>();
  for (const d of drafts) {
    const key = d.repeatedItems?.length
      ? `${d.kind}:${d.repeatedItems.map((i) => i.cid).join(",")}`
      : `${d.kind}:${d.rootCid}`;
    const prev = keyed.get(key);
    if (!prev || recipeRank(d) > recipeRank(prev)) keyed.set(key, d);
  }
  const sorted = [...keyed.values()].sort((a, b) => recipeRank(b) - recipeRank(a));
  const kept: RecipeDraft[] = [];
  for (const d of sorted) {
    const duplicate = kept.some((k) => {
      if (d.kind === "cta-band" && k.kind === "cta-band") {
        return isAncestorOrSelf(ctx, d.rootCid, k.rootCid) || isAncestorOrSelf(ctx, k.rootCid, d.rootCid);
      }
      const overlap = Math.max(overlapRatio(d, k), nestedItemOverlap(ctx, d, k));
      if (overlap < 0.8) return false;
      if (d.kind === k.kind) return true;
      if ((d.kind === "gallery-showcase" || k.kind === "gallery-showcase") &&
        (d.kind === "feature-grid" || d.kind === "card-grid" || d.kind === "product-grid" || k.kind === "feature-grid" || k.kind === "card-grid" || k.kind === "product-grid")) return true;
      if ((d.kind === "product-grid" || k.kind === "product-grid") &&
        (d.kind === "feature-grid" || d.kind === "card-grid" || k.kind === "feature-grid" || k.kind === "card-grid")) return true;
      return (d.kind === "feature-grid" && k.kind === "card-grid") || (d.kind === "card-grid" && k.kind === "feature-grid");
    });
    if (!duplicate) kept.push(d);
  }
  return kept;
}

function candidateSort(ctx: RecipeContext, a: RecipeDraft, b: RecipeDraft): number {
  const ab = ctx.byId.get(a.rootCid)?.bboxByVp[ctx.cw];
  const bb = ctx.byId.get(b.rootCid)?.bboxByVp[ctx.cw];
  return (ab?.y ?? 0) - (bb?.y ?? 0)
    || (ab?.x ?? 0) - (bb?.x ?? 0)
    || a.kind.localeCompare(b.kind)
    || b.confidence - a.confidence;
}

export function buildRecipeReport(ir: IR, sections: Section[], primitives: Map<string, PrimitiveType>, patternHints?: PatternHints): RecipeReport {
  const ctx = buildContext(ir, sections, primitives, patternHints);
  const drafts = suppressDuplicates(ctx, [
    ...detectLogoClouds(ctx),
    ...detectGrids(ctx),
    ...detectCtaBands(ctx),
  ]).sort((a, b) => candidateSort(ctx, a, b));
  const candidates = drafts.map((d, index) => ({ id: `recipe-${String(index + 1).padStart(3, "0")}`, ...d }));
  const byKind: Record<string, number> = {};
  for (const c of candidates) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  return {
    version: 1,
    sourceUrl: ir.doc.sourceUrl,
    canonicalViewport: ir.doc.canonicalViewport,
    viewports: ctx.viewports,
    sampledViewports: ctx.sampledViewports,
    summary: {
      totalCandidates: candidates.length,
      highConfidence: candidates.filter((c) => c.confidence >= 0.82).length,
      byKind,
      templateReadyKinds: TEMPLATE_READY,
      ...(patternHints ? { catalogPatterns: patternHints.matches.map((m) => m.id) } : {}),
    },
    candidates,
  };
}

function regimesSummary(regimes: RecipeResponsiveRegime[]): string {
  if (!regimes.length) return "no visible regimes";
  return regimes.map((r) => {
    const grid = r.columns ? `${r.columns}c/${r.rows ?? 1}r` : r.layout;
    const items = r.visibleItems !== undefined ? `, ${r.visibleItems} items` : "";
    return `${r.viewport}: ${grid}${items}`;
  }).join("; ");
}

export function recipeReportToMarkdown(report: RecipeReport): string {
  const lines: string[] = [];
  lines.push("# Layout Recipe Report");
  lines.push("");
  lines.push(`Source: ${report.sourceUrl}`);
  lines.push(`Canonical viewport: ${report.canonicalViewport}`);
  lines.push(`Captured viewports: ${report.viewports.join(", ")}`);
  lines.push(`Sampled responsive widths: ${report.sampledViewports.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Candidates: ${report.summary.totalCandidates}`);
  lines.push(`- High confidence: ${report.summary.highConfidence}`);
  if (report.summary.catalogPatterns?.length) lines.push(`- Catalog patterns on page: ${report.summary.catalogPatterns.join(", ")}`);
  lines.push(`- By kind: ${Object.entries(report.summary.byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Candidates");
  lines.push("");
  if (!report.candidates.length) {
    lines.push("No layout recipe candidates were detected.");
  }
  for (const c of report.candidates) {
    lines.push(`### ${c.id}: ${c.kind}`);
    lines.push("");
    lines.push(`- Confidence: ${c.confidence} (${c.risk} risk)`);
    lines.push(`- Root: ${c.rootTag} \`${c.rootCid}\`${c.sectionId ? `, ${c.sectionId} (${c.sectionRole ?? "section"})` : ""}`);
    if (c.itemParentCid) lines.push(`- Item parent: \`${c.itemParentCid}\``);
    lines.push(`- Component target: ${c.componentName}${c.dataModel ? ` with \`${c.dataModel}\`` : ""}`);
    if (c.itemCount !== undefined) lines.push(`- Items: ${c.itemCount}`);
    lines.push(`- Responsive regimes: ${regimesSummary(c.responsiveRegimes)}`);
    if (c.signals.length) lines.push(`- Signals: ${c.signals.join("; ")}`);
    if (c.sourceHints.length) lines.push(`- Source hints: ${c.sourceHints.slice(0, 12).map((h) => `\`${h}\``).join(", ")}`);
    lines.push(`- Emission: ${c.emissionStatus}; ${c.fallbackReason}`);
    if (c.repeatedItems?.length) {
      const sample = c.repeatedItems.slice(0, 5).map((i) => `\`${i.cid}\`${i.textSample ? ` "${i.textSample}"` : ""}`).join(", ");
      lines.push(`- Item sample: ${sample}${c.repeatedItems.length > 5 ? ", ..." : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
