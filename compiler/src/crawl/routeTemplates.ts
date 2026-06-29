/**
 * Route-template induction + the multi-route reproduction policy. Given the
 * discovered same-origin route paths, group them into URL templates by *segment cardinality*
 * (a position is dynamic when many siblings sharing its templated prefix vary at
 * it), then classify each template:
 *
 *   - singleton (1 instance)          -> reproduce it
 *   - pair (2 instances)              -> reproduce both (too few to collapse)
 *   - collection (>=3 instances)      -> reproduce the listing + ONE representative,
 *                                        record the full instance list (CMS handoff)
 *
 * Pure + deterministic: a function of the sorted path list only. Structural
 * confirmation (capture a sibling, compare DOM) happens later in the orchestrator
 * and can *explode* a collection back to singletons via applyConfirmation().
 */
import { segmentsOf } from "./url.js";

// >= this many instances under a shared container segment => a collection.
export const COLLECTION_MIN = 3;
// Root-level (flat, no container) collections need stronger evidence: top-level routes are
// almost always *distinct pages* (about/pricing/cashew/coffee), not a collection — only a
// large, overwhelmingly machine-id-like set (a flat numeric/date archive) qualifies.
export const ROOT_COLLECTION_MIN = 8;
// Default ceiling on routes we actually clone (distinct templates, not instances).
export const DEFAULT_MAX_ROUTES = 12;

const NUMERIC_RE = /^\d+$/;
const HASH_RE = /^[0-9a-f]{8,}$/i;
const DATEPART_RE = /^\d{1,4}$/; // year / month / day / numeric id

function isIdLike(seg: string): boolean {
  return NUMERIC_RE.test(seg) || HASH_RE.test(seg) || DATEPART_RE.test(seg);
}

export type RouteTemplate = {
  template: string; // "/blog/:id", "/docs/:id/:id", "/about", "/"
  instances: string[]; // sorted real paths matching this template
  dynamicPositions: number[];
  kind: "singleton" | "pair" | "collection";
  /** Literal path before the first dynamic segment (the listing/index), if any. */
  containerPath: string | null;
};

function decideDynamic(pos: number, values: string[], count: number): boolean {
  if (pos === 0) {
    // Root-level pages are almost always DISTINCT site pages (about / pricing / cashew /
    // coffee), even when their URLs are descriptive slugs — collapsing them discards real
    // content, and shared chrome makes them look structurally similar so confirmation can't
    // un-collapse them either. Only collapse a root set that is overwhelmingly machine-id-like
    // (a true flat numeric / hash / date list, e.g. /12345), NEVER a descriptive-slug set.
    if (values.length < ROOT_COLLECTION_MIN) return false;
    return values.filter(isIdLike).length >= Math.ceil(values.length * 0.9);
  }
  if (values.length >= COLLECTION_MIN) return true;
  // Date/numeric/hash segments are dynamic even in small numbers (sparse date
  // blogs like /blog/2025/10/16/slug), as long as there's more than one.
  if (count >= 2 && values.every(isIdLike)) return true;
  return false;
}

/** Induce URL templates from a set of route paths (recursive segment trie). */
export function induceTemplates(paths: string[]): RouteTemplate[] {
  const uniq = [...new Set(paths)].sort();
  const segs = new Map<string, string[]>();
  for (const p of uniq) segs.set(p, segmentsOf(p));

  type Acc = { instances: string[]; dyn: number[] };
  const byTemplate = new Map<string, Acc>();
  const record = (tpl: string, path: string, dyn: number[]): void => {
    const a = byTemplate.get(tpl) ?? { instances: [], dyn };
    a.instances.push(path);
    byTemplate.set(tpl, a);
  };

  // `group` shares the same templated prefix (tokens). Decide position `pos`.
  const recurse = (group: string[], pos: number, tokens: string[], dyn: number[]): void => {
    const ending = group.filter((p) => segs.get(p)!.length === pos);
    if (ending.length) {
      const tpl = "/" + tokens.join("/");
      for (const p of ending) record(tpl === "/" ? "/" : tpl, p, dyn.slice());
    }
    const cont = group.filter((p) => segs.get(p)!.length > pos);
    if (cont.length === 0) return;

    const valueSet = new Set<string>();
    for (const p of cont) valueSet.add(segs.get(p)![pos]!);
    const values = [...valueSet].sort();
    const dynamic = decideDynamic(pos, values, cont.length);

    if (dynamic) {
      recurse(cont, pos + 1, [...tokens, ":id"], [...dyn, pos]);
    } else {
      const buckets = new Map<string, string[]>();
      for (const p of cont) {
        const v = segs.get(p)![pos]!;
        (buckets.get(v) ?? buckets.set(v, []).get(v)!).push(p);
      }
      for (const v of [...buckets.keys()].sort()) {
        recurse(buckets.get(v)!, pos + 1, [...tokens, v], dyn);
      }
    }
  };
  recurse(uniq, 0, [], []);

  const templates: RouteTemplate[] = [];
  for (const [template, acc] of byTemplate) {
    const instances = [...new Set(acc.instances)].sort();
    const kind = instances.length >= COLLECTION_MIN ? "collection" : instances.length === 2 ? "pair" : "singleton";
    let containerPath: string | null = null;
    if (acc.dyn.length) {
      const firstDyn = Math.min(...acc.dyn);
      const lit = template.split("/").filter(Boolean).slice(0, firstDyn);
      containerPath = "/" + lit.join("/");
      if (containerPath === "/" && firstDyn === 0) containerPath = "/";
    }
    templates.push({ template, instances, dynamicPositions: acc.dyn.slice().sort((a, b) => a - b), kind, containerPath });
  }
  templates.sort((a, b) => b.instances.length - a.instances.length || a.template.localeCompare(b.template));
  return templates;
}

export type SelectedRoute = {
  path: string;
  role: "entry" | "page" | "listing" | "representative";
  template: string;
  depth: number;
};

export type CollapsedCollection = {
  template: string;
  listing: string | null; // listing/index path, if it exists in the route set
  representative: string; // the single detail page we reproduce
  siblingProbe: string | null; // a second instance, captured only to confirm the template
  instanceCount: number;
  instances: string[]; // the full map (the CMS-handoff boundary)
  confirmed: boolean; // set by applyConfirmation() after structural comparison
};

export type RoutePlan = {
  entry: string;
  maxRoutes: number;
  selected: SelectedRoute[];
  collections: CollapsedCollection[];
  templates: RouteTemplate[];
  skipped: Array<{ path: string; reason: string }>;
};

function depth(path: string): number {
  return segmentsOf(path).length;
}
const ROLE_PRIORITY: Record<SelectedRoute["role"], number> = { entry: 0, listing: 1, representative: 2, page: 3 };

/**
 * Build the route plan from discovered paths: collapse collections to listing + one
 * representative, keep singletons/pairs, always include the entry, and cap the total
 * at maxRoutes (spent on distinct templates, not instances).
 */
export function selectRoutes(opts: {
  entryPath: string;
  paths: string[];
  maxRoutes?: number;
  /** Cap on a collection's instance count for its LISTING page to be reproduced.
   *  A directory listing of a very large collection (e.g. 11ty's 882-instance authors
   *  index) is a single page that renders one card — often with one image — per
   *  instance; capturing/grading it is intractable inside the dev time budget. Above
   *  this cap the listing is left as a CMS-handoff (links to it absolutize to the
   *  source origin) while the representative detail page is still reproduced. Opt-in
   *  (undefined ⇒ no cap), so normal sites are unaffected. */
  maxCollectionInstances?: number;
}): RoutePlan {
  const maxRoutes = opts.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const maxColl = opts.maxCollectionInstances ?? Infinity;
  const entry = opts.entryPath || "/";
  const allPaths = [...new Set([entry, ...opts.paths])];
  const templates = induceTemplates(allPaths);
  const pathSet = new Set(allPaths);

  const selected: SelectedRoute[] = [];
  const collections: CollapsedCollection[] = [];
  const preSkipped: RoutePlan["skipped"] = [];
  const seen = new Set<string>();
  const add = (path: string, role: SelectedRoute["role"], template: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    selected.push({ path, role: path === entry ? "entry" : role, template, depth: depth(path) });
  };

  for (const t of templates) {
    if (t.kind === "collection") {
      const representative = t.instances[0]!;
      let listing = t.containerPath && pathSet.has(t.containerPath) && t.containerPath !== representative ? t.containerPath : null;
      const siblingProbe = t.instances.find((p) => p !== representative) ?? null;
      // Oversized directory: drop the listing from reproduction (keep the detail
      // representative). `listing: null` makes link-rewriting absolutize links to it
      // to the source origin, so link-integrity still holds (no dangling clone route).
      if (listing && t.instances.length > maxColl) {
        preSkipped.push({ path: listing, reason: `oversized_collection_listing (${t.instances.length} > ${maxColl})` });
        listing = null;
      }
      collections.push({
        template: t.template,
        listing,
        representative,
        siblingProbe,
        instanceCount: t.instances.length,
        instances: t.instances,
        confirmed: false,
      });
      if (listing) add(listing, "listing", t.template);
      add(representative, "representative", t.template);
    } else {
      for (const p of t.instances) add(p, "page", t.template);
    }
  }
  // Entry always present.
  if (!seen.has(entry)) add(entry, "entry", "/");

  // An oversized listing path is also induced as its own singleton template (the
  // directory index is a real page), so it was added as a "page" above — drop it
  // too, so the heavy directory is genuinely not reproduced (the entry is never
  // dropped, even in the unlikely case it is a container).
  const droppedPaths = new Set(preSkipped.map((s) => s.path));
  const candidates = droppedPaths.size
    ? selected.filter((r) => r.role === "entry" || !droppedPaths.has(r.path))
    : selected;

  // Deterministic priority order, then cap. Entry first, then SHALLOWEST routes — a site's
  // top-level nav pages (/about, /pricing, /cashew) are its primary content and should be
  // reproduced before deep collection representatives (a single /blog/:id or /2026/02/26
  // archive). At equal depth prefer listing > representative > page, then alphabetical.
  candidates.sort((a, b) =>
    (a.role === "entry" ? 0 : 1) - (b.role === "entry" ? 0 : 1)
    || a.depth - b.depth
    || ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]
    || a.path.localeCompare(b.path),
  );
  const kept = candidates.slice(0, maxRoutes);
  const keptPaths = new Set(kept.map((r) => r.path));
  const skipped: RoutePlan["skipped"] = [...preSkipped];
  for (const r of candidates.slice(maxRoutes)) skipped.push({ path: r.path, reason: "route_cap" });
  // Drop collections whose representative got capped out (keep the plan consistent).
  const keptCollections = collections.filter((c) => keptPaths.has(c.representative));

  return { entry, maxRoutes, selected: kept, collections: keptCollections, templates, skipped };
}

/**
 * After capturing each collection's representative + siblingProbe and comparing
 * their page structural signatures, apply the verdicts: a confirmed collection stays
 * collapsed; an unconfirmed one (the URL grouping was wrong — distinct pages sharing
 * a prefix) is exploded back into individual page routes, subject to the cap.
 */
export function applyConfirmation(
  plan: RoutePlan,
  verdicts: Map<string, boolean>, // template -> similar?
): RoutePlan {
  const confirmed: CollapsedCollection[] = [];
  const exploded: string[] = [];
  for (const c of plan.collections) {
    const ok = verdicts.get(c.template);
    if (ok === false) exploded.push(...c.instances);
    else confirmed.push({ ...c, confirmed: ok === true });
  }
  if (exploded.length === 0) return { ...plan, collections: confirmed };

  // Rebuild selected: drop representatives/listings of exploded collections, add
  // exploded instances as pages, keep everything else, re-cap.
  const explodedTemplates = new Set(plan.collections.filter((c) => verdicts.get(c.template) === false).map((c) => c.template));
  const keep = plan.selected.filter((r) => !(explodedTemplates.has(r.template) && r.role !== "entry"));
  const seen = new Set(keep.map((r) => r.path));
  for (const p of [...new Set(exploded)].sort()) {
    if (seen.has(p)) continue;
    seen.add(p);
    keep.push({ path: p, role: p === plan.entry ? "entry" : "page", template: "(exploded)", depth: depth(p) });
  }
  keep.sort((a, b) =>
    (a.role === "entry" ? 0 : 1) - (b.role === "entry" ? 0 : 1)
    || a.depth - b.depth
    || ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]
    || a.path.localeCompare(b.path));
  const kept = keep.slice(0, plan.maxRoutes);
  const skipped = [...plan.skipped, ...keep.slice(plan.maxRoutes).map((r) => ({ path: r.path, reason: "route_cap" }))];
  return { ...plan, selected: kept, collections: confirmed, skipped };
}
