/**
 * Stage 4.5 — component extraction (repeated subtrees).
 *
 * Detects runs of ≥3 contiguous sibling subtrees that share a structural signature
 * and are strictly shape-aligned (same tags + same element/text child sequence,
 * recursively). Such a run is promoted to one component rendered over a per-instance
 * data array; the generator (`generate/app.ts`) emits the skeleton, baking values
 * that are identical across instances and turning values that vary (text, hrefs,
 * cids, …) into data fields.
 *
 * Fidelity first (the contract): each instance keeps its ORIGINAL cid in the rendered
 * DOM (carried in the data), so the output is render-identical to inlining — gates
 * 3/4/5 align by `data-cid` with no remap. Anything that isn't strictly alignable, or
 * whose between-instance separators aren't insignificant whitespace, is left inline.
 */
import type { IR, IRNode, IRChild } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { subtreeSignature } from "../site/sharedLayout.js";
import type { RecipeKind, RecipeReport } from "./recipes.js";

const MIN_INSTANCES = 3;

export type ComponentCluster = {
  baseName: string; // role label (Card, NavItem, ListItem, …); emission adds a dedup suffix
  parentCid: string; // the node whose child run was promoted
  rootCids: string[]; // instance roots in document order (a contiguous sibling run)
  insideInteractive: boolean; // is the run nested in an <a>/<button> (affects retagging)
  recipeKind?: RecipeKind; // high-level layout recipe that owns this repeated run
  dataModel?: string; // semantic collection prop name from the recipe layer (logos/cards/…)
  looseRecipe?: "logo-cloud-item" | "variant-card-item"; // recipe-specific emitters for safe mixed-shape runs
};

export type ComponentPlan = {
  clusters: ComponentCluster[];
  rootToCluster: Map<string, ComponentCluster>; // every instance root cid → its cluster
  firstRoot: Set<string>; // cids that are the FIRST instance of a cluster
};

const elementChildren = (n: IRNode): IRNode[] => n.children.filter((c): c is IRNode => !isTextChild(c));
const isWsText = (c: IRChild): boolean => isTextChild(c) && c.text.trim() === "";

/** A subtree worth extracting carries real content — text or media — so we never
 *  promote runs of empty spacer/wrapper boxes (no readability or fidelity gain). */
function hasContent(n: IRNode): boolean {
  if (/^(img|svg|video)$/.test(n.tag)) return true;
  for (const c of n.children) {
    if (isTextChild(c)) { if (c.text.trim()) return true; }
    else if (hasContent(c)) return true;
  }
  return false;
}

// A bare single element is a meaningful component only when it's a link / control /
// list item / media — otherwise it's likely a text-effect fragment (e.g. a word split
// into per-letter <span>s) rather than a reusable unit.
const MEANINGFUL_LEAF = new Set(["a", "button", "li", "option", "img", "svg", "picture", "video", "tr"]);

function elementNodeCount(n: IRNode): number {
  let c = 1;
  for (const k of elementChildren(n)) c += elementNodeCount(k);
  return c;
}

/** A run is component-worthy only if each instance is a substantial unit: ≥2 element
 *  nodes, or a semantically meaningful single element. Rejects per-letter/word span
 *  runs (staggered-text effects) and other trivial leaf repetition that would extract
 *  to nonsense like `<Item d={{ f0: "s" }} />`. (Instances are shape-aligned, so the
 *  representative decides for all.) */
function meaningful(root: IRNode): boolean {
  return MEANINGFUL_LEAF.has(root.tag) || elementNodeCount(root) >= 2;
}

/** Strict shape alignment: same tag, same child count, same element/text kind at
 *  every position, recursively. Text CONTENT and attribute VALUES may differ (that's
 *  the per-instance data) — only the SHAPE must be identical so one skeleton renders
 *  every instance faithfully. (subtreeSignature ignores text nodes, so this adds the
 *  text-position check it lacks.) */
function alignable(nodes: IRNode[]): boolean {
  const tag = nodes[0]!.tag;
  if (!nodes.every((n) => n.tag === tag)) return false;
  const len = nodes[0]!.children.length;
  if (!nodes.every((n) => n.children.length === len)) return false;
  for (let i = 0; i < len; i++) {
    const isText = isTextChild(nodes[0]!.children[i]!);
    if (!nodes.every((n) => isTextChild(n.children[i]!) === isText)) return false;
    if (!isText && !alignable(nodes.map((n) => n.children[i] as IRNode))) return false;
  }
  return true;
}

/** Whitespace between block-level instances (or under a flex/grid parent) is not
 *  rendered, so dropping it when collapsing the run to a `.map()` is render-safe.
 *  Inline-level instances with whitespace between them DO show a space → not safe. */
function separatorsInsignificant(parent: IRNode, instances: IRNode[]): boolean {
  const pdisp = dispOf(parent);
  if (/(flex|grid)/.test(pdisp)) return true;
  return instances.every((n) => /^(block|list-item|table|flow-root|flex|grid)/.test(dispOf(n)));
}

function dispOf(n: IRNode): string {
  return (n.computedByVp[1280] ?? Object.values(n.computedByVp)[0])?.display ?? "";
}

function hasHeading(n: IRNode): boolean {
  for (const c of n.children) {
    if (isTextChild(c)) continue;
    if (/^h[1-6]$/.test(c.tag)) return true;
    if (hasHeading(c)) return true;
  }
  return false;
}
function subtreeHasTag(n: IRNode, re: RegExp): boolean {
  for (const c of n.children) {
    if (isTextChild(c)) continue;
    if (re.test(c.tag)) return true;
    if (subtreeHasTag(c, re)) return true;
  }
  return false;
}
function subtreeHasAvatar(n: IRNode, prims?: Map<string, string>): boolean {
  if (!prims) return false;
  const walk = (x: IRNode): boolean => {
    if (prims.get(x.id) === "avatar") return true;
    for (const c of x.children) if (!isTextChild(c) && walk(c)) return true;
    return false;
  };
  return walk(n);
}
function directText(n: IRNode): string {
  let s = "";
  const walk = (x: IRNode): void => { for (const c of x.children) { if (isTextChild(c)) s += c.text; else walk(c); } };
  walk(n);
  return s.trim();
}

/** A readable, deterministic, SEMANTIC component name from the run's role/content —
 *  deliberately avoiding the generic vocabulary (Item/Card/List/Link…). Repeated links
 *  become NavLink/TextLink, repeated cards FeatureCard/MediaCard/ProfileCard by what
 *  they contain, repeated logos Logo, etc. */
function baseName(parentTag: string, root: IRNode, prims?: Map<string, string>): string {
  const prim = prims?.get(root.id);
  const hasH = hasHeading(root);
  const hasImg = subtreeHasTag(root, /^(img|svg|picture|video)$/);
  const hasAvatar = subtreeHasAvatar(root, prims);
  const text = directText(root);
  const inNav = parentTag === "nav" || parentTag === "header";

  // Anchor / button runs → link-ish names.
  if (root.tag === "a" || prim === "link" || prim === "button") {
    if (inNav) return "NavLink";
    if (hasImg && hasH) return "CardLink";
    if (hasImg && !text) return "Logo";
    if (hasImg) return "MediaLink";
    return "TextLink";
  }
  // Card-ish subtrees (have a heading) → name by media content.
  if (hasH) {
    if (hasAvatar) return "ProfileCard";
    if (hasImg) return "MediaCard";
    return "FeatureCard";
  }
  // Media-only repeats: logos vs media tiles.
  if (hasImg && !text) return "Logo";
  if (hasImg) return "MediaTile";
  // List rows / generic content tiles (still semantic, not "Item").
  if (root.tag === "li") return inNav ? "NavLink" : "ListRow";
  if (parentTag === "ul" || parentTag === "ol") return "ListRow";
  return "Tile";
}

type RecipeComponentHint = {
  kind: RecipeKind;
  dataModel?: string;
  confidence: number;
  itemRootByCid: Map<string, string>;
};

function nodeIndex(ir: IR): Map<string, IRNode> {
  const byId = new Map<string, IRNode>();
  const index = (n: IRNode): void => {
    byId.set(n.id, n);
    for (const c of elementChildren(n)) index(c);
  };
  index(ir.root);
  return byId;
}

function collectIds(n: IRNode, out = new Set<string>()): Set<string> {
  out.add(n.id);
  for (const c of elementChildren(n)) collectIds(c, out);
  return out;
}

function recipeComponentHints(recipes: RecipeReport | undefined, byId: Map<string, IRNode>): RecipeComponentHint[] {
  if (!recipes) return [];
  const hints: RecipeComponentHint[] = [];
  for (const c of recipes.candidates) {
    if (c.kind === "cta-band" || !c.repeatedItems?.length || !c.dataModel) continue;
    if (c.confidence < 0.82) continue;
    const itemRootByCid = new Map<string, string>();
    for (const item of c.repeatedItems) {
      const node = byId.get(item.cid);
      if (!node) continue;
      for (const id of collectIds(node)) itemRootByCid.set(id, item.cid);
    }
    if (itemRootByCid.size) hints.push({ kind: c.kind, dataModel: c.dataModel, confidence: c.confidence, itemRootByCid });
  }
  return hints.sort((a, b) => b.confidence - a.confidence);
}

function simpleLogoCloudItem(n: IRNode): boolean {
  if (n.tag !== "div") return false;
  const kids = elementChildren(n);
  if (kids.length !== 1) return false;
  const only = kids[0]!;
  if (only.tag === "img") return true;
  if (only.tag !== "a") return false;
  const linkKids = elementChildren(only);
  if (linkKids.length !== 1 || linkKids[0]!.tag !== "div") return false;
  const innerKids = elementChildren(linkKids[0]!);
  const images = innerKids.filter((c) => c.tag === "img");
  if (images.length !== 1) return false;
  const extras = innerKids.filter((c) => c.tag !== "img");
  return extras.length <= 1 && extras.every((c) => c.tag === "div");
}

function contiguousChildRun(parent: IRNode, itemCids: string[]): boolean {
  const childIds = elementChildren(parent).map((c) => c.id);
  const indexes = itemCids.map((id) => childIds.indexOf(id));
  if (indexes.some((i) => i < 0)) return false;
  for (let i = 1; i < indexes.length; i++) if (indexes[i]! <= indexes[i - 1]!) return false;
  return indexes[indexes.length - 1]! - indexes[0]! + 1 === indexes.length;
}

function looseLogoCloudClusters(recipes: RecipeReport | undefined, byId: Map<string, IRNode>): Map<string, ComponentCluster[]> {
  const out = new Map<string, ComponentCluster[]>();
  if (!recipes) return out;
  for (const c of recipes.candidates) {
    if (c.kind !== "logo-cloud" || c.confidence < 0.86 || !c.itemParentCid || !c.repeatedItems?.length) continue;
    const parent = byId.get(c.itemParentCid);
    const itemCids = c.repeatedItems.map((i) => i.cid);
    const nodes = itemCids.map((cid) => byId.get(cid));
    if (!parent || nodes.some((n) => !n)) continue;
    const items = nodes as IRNode[];
    if (!contiguousChildRun(parent, itemCids) || !items.every(simpleLogoCloudItem)) continue;
    const cluster: ComponentCluster = {
      baseName: "LogoCloudItem",
      parentCid: parent.id,
      rootCids: itemCids,
      insideInteractive: false,
      recipeKind: "logo-cloud",
      dataModel: c.dataModel ?? "logos",
      looseRecipe: "logo-cloud-item",
    };
    const prev = out.get(parent.id) ?? [];
    prev.push(cluster);
    out.set(parent.id, prev);
  }
  return out;
}

function looseVariantCardClusters(recipes: RecipeReport | undefined, byId: Map<string, IRNode>): Map<string, ComponentCluster[]> {
  const out = new Map<string, ComponentCluster[]>();
  if (!recipes) return out;
  for (const c of recipes.candidates) {
    if ((c.kind !== "feature-grid" && c.kind !== "card-grid" && c.kind !== "product-grid") || c.confidence < 0.9 || !c.itemParentCid || !c.repeatedItems?.length) continue;
    const itemCids = c.repeatedItems.map((i) => i.cid);
    if (itemCids.length < MIN_INSTANCES || itemCids.length > 12) continue;
    const parent = byId.get(c.itemParentCid);
    const nodes = itemCids.map((cid) => byId.get(cid));
    if (!parent || nodes.some((n) => !n)) continue;
    const items = nodes as IRNode[];
    if (!contiguousChildRun(parent, itemCids)) continue;
    if (alignable(items)) continue; // strict extraction produces cleaner code when it can.
    if (!items.every((n) => meaningful(n) && hasContent(n))) continue;
    if (!separatorsInsignificant(parent, items)) continue;
    const cluster: ComponentCluster = {
      baseName: c.kind === "feature-grid" ? "FeatureGridItem" : c.kind === "product-grid" ? "ProductCard" : "CardGridItem",
      parentCid: parent.id,
      rootCids: itemCids,
      insideInteractive: false,
      recipeKind: c.kind,
      dataModel: c.dataModel ?? (c.kind === "feature-grid" ? "features" : c.kind === "product-grid" ? "products" : "cards"),
      looseRecipe: "variant-card-item",
    };
    const prev = out.get(parent.id) ?? [];
    prev.push(cluster);
    out.set(parent.id, prev);
  }
  return out;
}

function mergeLooseClusters(...maps: Array<Map<string, ComponentCluster[]>>): Map<string, ComponentCluster[]> {
  const out = new Map<string, ComponentCluster[]>();
  for (const map of maps) {
    for (const [parent, clusters] of map) {
      const prev = out.get(parent) ?? [];
      prev.push(...clusters);
      out.set(parent, prev);
    }
  }
  return out;
}

function recipeHintForRun(hints: RecipeComponentHint[], run: IRNode[]): RecipeComponentHint | undefined {
  for (const hint of hints) {
    const itemRoots = run.map((n) => hint.itemRootByCid.get(n.id));
    if (itemRoots.some((id) => !id)) continue;
    if (new Set(itemRoots).size !== run.length) continue;
    return hint;
  }
  return undefined;
}

function recipeBaseName(kind: RecipeKind, parentTag: string, root: IRNode, prims?: Map<string, string>): string {
  if (kind === "logo-cloud") return "Logo";
  if (kind === "feature-grid") return "FeatureCard";
  if (kind === "product-grid") return "ProductCard";
  if (kind === "card-grid") {
    const inferred = baseName(parentTag, root, prims);
    return /^(MediaCard|ProfileCard|CardLink)$/.test(inferred) ? inferred : "Card";
  }
  return baseName(parentTag, root, prims);
}

export function detectComponents(ir: IR, prims?: Map<string, string>, recipes?: RecipeReport): ComponentPlan {
  const clusters: ComponentCluster[] = [];
  const byId = nodeIndex(ir);
  const recipeHints = recipeComponentHints(recipes, byId);
  const looseByParent = mergeLooseClusters(looseLogoCloudClusters(recipes, byId), looseVariantCardClusters(recipes, byId));
  const consumed = new Set<string>(); // cids inside an already-chosen cluster instance
  const markConsumed = (n: IRNode): void => {
    consumed.add(n.id);
    for (const k of elementChildren(n)) markConsumed(k);
  };

  const walk = (node: IRNode, insideInteractive: boolean): void => {
    for (const loose of looseByParent.get(node.id) ?? []) {
      if (loose.rootCids.some((cid) => consumed.has(cid))) continue;
      clusters.push(loose);
      for (const cid of loose.rootCids) {
        const root = byId.get(cid);
        if (root) markConsumed(root);
      }
    }
    const kids = node.children;
    let i = 0;
    while (i < kids.length) {
      const c = kids[i]!;
      if (isTextChild(c)) { i++; continue; }
      if (consumed.has(c.id)) { i++; continue; }
      // Greedily grow a run of same-signature element siblings (only whitespace text
      // allowed between them).
      const sig = subtreeSignature(c);
      const run: IRNode[] = [c];
      let j = i + 1;
      while (j < kids.length) {
        const d = kids[j]!;
        if (isTextChild(d)) { if (isWsText(d)) { j++; continue; } else break; }
        if (subtreeSignature(d) === sig) { run.push(d); j++; } else break;
      }
      if (
        run.length >= MIN_INSTANCES &&
        alignable(run) &&
        meaningful(run[0]!) &&
        run.every(hasContent) &&
        separatorsInsignificant(node, run)
      ) {
        const recipeHint = recipeHintForRun(recipeHints, run);
        clusters.push({
          baseName: recipeHint ? recipeBaseName(recipeHint.kind, node.tag, c, prims) : baseName(node.tag, c, prims),
          parentCid: node.id,
          rootCids: run.map((r) => r.id),
          insideInteractive,
          ...(recipeHint ? { recipeKind: recipeHint.kind, ...(recipeHint.dataModel ? { dataModel: recipeHint.dataModel } : {}) } : {}),
        });
        for (const r of run) markConsumed(r);
        i = j;
        continue;
      }
      i++;
    }
    const childInteractive = insideInteractive || node.tag === "a" || node.tag === "button";
    for (const k of elementChildren(node)) {
      if (consumed.has(k.id)) continue; // don't extract within a chosen instance (no nesting)
      walk(k, childInteractive);
    }
  };
  walk(ir.root, false);

  const rootToCluster = new Map<string, ComponentCluster>();
  const firstRoot = new Set<string>();
  for (const cl of clusters) {
    firstRoot.add(cl.rootCids[0]!);
    for (const r of cl.rootCids) rootToCluster.set(r, cl);
  }
  return { clusters, rootToCluster, firstRoot };
}
