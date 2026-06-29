/**
 * Shared-layout detection (Stage 3, M4). Finds the chrome (header/nav at the top,
 * footer at the bottom) that is structurally common to the captured routes so it
 * can be hoisted into layout.tsx and emitted ONCE instead of duplicated in every
 * route page (DoD: "shared chrome … emitted once, not duplicated per page").
 *
 * Detection is conservative — a leading/trailing run of body children is chrome
 * only when its subtree signature is IDENTICAL across every route (so the clone's
 * fidelity is unaffected; on any divergence we hoist nothing and fall back to the
 * per-route pages, the validated M2 behavior).
 *
 * cid alignment: body children are numbered in pre-order, so an identical leading
 * run gets the SAME cids (c1..cK) on every route — header hoisting needs no remap.
 * Trailing chrome (footer) sits at route-dependent cids, so the validator remaps a
 * route's footer subtree onto the canonical (entry) footer cids before grading.
 */
import type { IR, IRNode, IRChild } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { sha1_12 } from "../util/canonical.js";

/** Recursive tag-skeleton signature of a subtree (ignores text/attrs/class). */
export function subtreeSignature(node: IRNode): string {
  const kids = node.children.filter((c): c is IRNode => !isTextChild(c));
  if (kids.length === 0) return node.tag;
  return `${node.tag}(${kids.map(subtreeSignature).join(",")})`;
}

function elementChildren(node: IRNode): IRNode[] {
  return node.children.filter((c): c is IRNode => !isTextChild(c));
}

export type ChromePlan = {
  headerCount: number; // leading body children hoisted to layout (before {children})
  footerCount: number; // trailing body children hoisted to layout (after {children})
};

/**
 * Detect the shared chrome across a set of route IRs. Returns how many leading and
 * trailing body children are structurally identical across ALL routes.
 */
export function detectSharedChrome(routeIRs: IR[], opts?: { minChromeNodes?: number }): ChromePlan {
  const minChromeNodes = opts?.minChromeNodes ?? 4;
  if (routeIRs.length < 2) return { headerCount: 0, footerCount: 0 };

  const childrenByRoute = routeIRs.map((ir) => elementChildren(ir.root));
  const sigsByRoute = childrenByRoute.map((kids) => kids.map(subtreeSignature));
  const minLen = Math.min(...childrenByRoute.map((k) => k.length));
  if (minLen < 2) return { headerCount: 0, footerCount: 0 };

  const sameAt = (idxFromStart: number): boolean => {
    const ref = sigsByRoute[0]![idxFromStart];
    return ref !== undefined && sigsByRoute.every((s) => s[idxFromStart] === ref);
  };
  const sameAtEnd = (idxFromEnd: number): boolean => {
    const ref = sigsByRoute[0]![sigsByRoute[0]!.length - 1 - idxFromEnd];
    return ref !== undefined && sigsByRoute.every((s) => s[s.length - 1 - idxFromEnd] === ref);
  };

  let header = 0;
  while (header < minLen && sameAt(header)) header++;
  let footer = 0;
  while (footer < minLen - header && sameAtEnd(footer)) footer++;

  // Leave at least one middle child per route (route-unique content).
  while (header + footer >= minLen && (header > 0 || footer > 0)) {
    if (footer >= header && footer > 0) footer--;
    else if (header > 0) header--;
    else break;
  }

  // Require the hoisted chrome to be non-trivial (avoid hoisting a bare wrapper).
  const nodeCount = (n: IRNode): number => 1 + elementChildren(n).reduce((s, c) => s + nodeCount(c), 0);
  const entryKids = childrenByRoute[0]!;
  const headerNodes = entryKids.slice(0, header).reduce((s, n) => s + nodeCount(n), 0);
  const footerNodes = entryKids.slice(entryKids.length - footer).reduce((s, n) => s + nodeCount(n), 0);
  if (header > 0 && headerNodes < minChromeNodes) header = 0;
  if (footer > 0 && footerNodes < minChromeNodes) footer = 0;

  return { headerCount: header, footerCount: footer };
}

function collectIds(node: IRNode, into: Set<string>): void {
  into.add(node.id);
  for (const c of elementChildren(node)) collectIds(c, into);
}

/** Header / footer element children of a body, per the plan. */
export function chromeChildren(ir: IR, plan: ChromePlan): { header: IRNode[]; footer: IRNode[] } {
  const kids = elementChildren(ir.root);
  return {
    header: kids.slice(0, plan.headerCount),
    footer: plan.footerCount ? kids.slice(kids.length - plan.footerCount) : [],
  };
}

/** Middle (route-unique) element children of a body, per the plan. */
export function middleChildren(ir: IR, plan: ChromePlan): IRNode[] {
  const kids = elementChildren(ir.root);
  return kids.slice(plan.headerCount, kids.length - plan.footerCount);
}

// Hoisted chrome cids are namespaced (prefixed) so they can never collide with a
// route's pre-order integer cids: chrome CSS is global (loaded on every route),
// while route middle CSS is route-scoped and uses bare c<int> ids.
export const CHROME_PREFIX = "L";

function deepCloneRelabel(node: IRNode, prefix: string): IRNode {
  return {
    ...node,
    id: prefix + node.id,
    children: node.children.map((c) => (isTextChild(c) ? { text: c.text } : deepCloneRelabel(c, prefix))),
  };
}

/** The canonical (namespaced) chrome nodes hoisted into the shared layout, taken
 *  from the entry route. Returns the header/footer node arrays + their id set. */
export function buildCanonicalChrome(entry: IR, plan: ChromePlan): { header: IRNode[]; footer: IRNode[]; ids: Set<string> } {
  const { header, footer } = chromeChildren(entry, plan);
  const ch = header.map((n) => deepCloneRelabel(n, CHROME_PREFIX));
  const cf = footer.map((n) => deepCloneRelabel(n, CHROME_PREFIX));
  const ids = new Set<string>();
  for (const n of [...ch, ...cf]) collectIds(n, ids);
  return { header: ch, footer: cf, ids };
}

/** A synthetic IR (chrome children under the entry body) for generating the shared
 *  chrome CSS, so chrome nodes inherit from the entry body just as they do live. */
export function chromeCssIr(entry: IR, canonical: { header: IRNode[]; footer: IRNode[] }): IR {
  return { doc: entry.doc, root: { ...entry.root, children: [...canonical.header, ...canonical.footer] } };
}

/** CSS node filter for a route's page (body c0 + middle children only). */
export function middleIncludeFilter(ir: IR, plan: ChromePlan): (id: string) => boolean {
  const ids = new Set<string>([ir.root.id]); // body c0 stays per-route
  for (const n of middleChildren(ir, plan)) collectIds(n, ids);
  return (id) => ids.has(id);
}

/**
 * Relabel a route's header+footer chrome subtrees onto the canonical namespaced
 * chrome cids (parallel pre-order; structures are identical by construction), so the
 * route's validation IR matches the rendered DOM, whose chrome is the hoisted layout.
 */
export function remapChromeCids(routeIr: IR, entryIr: IR, plan: ChromePlan, prefix = CHROME_PREFIX): void {
  const r = chromeChildren(routeIr, plan);
  const e = chromeChildren(entryIr, plan);
  const relabel = (a: IRNode, b: IRNode): void => {
    a.id = prefix + b.id;
    const ak = elementChildren(a), bk = elementChildren(b);
    const n = Math.min(ak.length, bk.length);
    for (let i = 0; i < n; i++) relabel(ak[i]!, bk[i]!);
  };
  for (let i = 0; i < Math.min(r.header.length, e.header.length); i++) relabel(r.header[i]!, e.header[i]!);
  for (let i = 0; i < Math.min(r.footer.length, e.footer.length); i++) relabel(r.footer[i]!, e.footer[i]!);
}

/** A short stable id for a chrome plan (for logging/manifest). */
export function chromeSignatureId(entry: IR, plan: ChromePlan): string {
  const kids = elementChildren(entry.root);
  const head = kids.slice(0, plan.headerCount).map(subtreeSignature).join("|");
  const foot = kids.slice(kids.length - plan.footerCount).map(subtreeSignature).join("|");
  return sha1_12(head + "##" + foot);
}

export { elementChildren };
export type { IRChild };
