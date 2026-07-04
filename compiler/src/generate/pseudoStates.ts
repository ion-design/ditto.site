/** Fast-path hover/focus CSS: turn capture-time PseudoStateRule records (source
 *  stylesheet rules matched against the live DOM, keyed by data-cid-cap) into
 *  `[data-cid="…"]:hover { … }` rules for ditto.css. Only used when Stage 4
 *  interaction capture is OFF — Stage 4's live-driven deltas are richer and the
 *  Tailwind builder folds them into `hover:` variant utilities instead.
 *
 *  Deterministic: rules are frozen in capture-result.json; the capId→cid map is
 *  a single IR walk; emission preserves capture order (source cascade order). */
import type { IR, IRNode, IRChild } from "../normalize/ir.js";
import type { PseudoStateRule } from "../capture/capture.js";

function isElement(c: IRChild): c is IRNode {
  return (c as IRNode).id !== undefined;
}

export function generatePseudoStateCss(ir: IR, rules: PseudoStateRule[] | undefined): string {
  if (!rules?.length) return "";
  const capToCid = new Map<string, string>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap && !capToCid.has(cap)) capToCid.set(cap, n.id);
    for (const c of n.children) if (isElement(c)) walk(c);
  };
  walk(ir.root);

  const lines: string[] = [];
  for (const r of rules) {
    const cid = capToCid.get(r.capId);
    if (!cid) continue; // element pruned from the IR (invisible) — nothing to style
    const decls = Object.entries(r.decls)
      .map(([prop, value]) => `${prop}: ${value};`)
      .join(" ");
    const rule = `[data-cid="${cid}"]:${r.pseudo} { ${decls} }`;
    lines.push(r.media ? `@media ${r.media} { ${rule} }` : rule);
  }
  if (!lines.length) return "";
  return (
    "\n/* Fast-path hover/focus states recovered from the source stylesheets (capture.pseudoStates). */\n" +
    lines.join("\n") +
    "\n"
  );
}
