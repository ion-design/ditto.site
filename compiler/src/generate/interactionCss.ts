import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { InteractionCapture, StyleDelta } from "../capture/interactions.js";

/**
 * Stage 4 (M1) — emit pure-CSS `:hover` / `:focus` rules from the captured pseudo-
 * state deltas. The deltas are keyed by `data-cid-cap`; we map them to the IR's
 * `c{id}` selectors. Deterministic: capture-ids are emitted in numeric order. The
 * values are the captured computed deltas, so the rendered hover/focus state matches
 * the source (verified by the interaction gate, which re-drives and compares).
 */

function kebab(prop: string): string {
  if (prop.startsWith("webkit")) return "-webkit-" + kebab(prop[6]!.toLowerCase() + prop.slice(7));
  return prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}
function rule(sel: string, d: StyleDelta): string {
  const body = Object.keys(d).sort().map((k) => `${kebab(k)}:${d[k]}`).join(";");
  return `${sel}{${body}}`;
}

/** Map every IR node's capture-id → its cid, and cid → node. */
function capToCid(ir: IR): { capCid: Map<string, string>; cidNode: Map<string, IRNode> } {
  const capCid = new Map<string, string>();
  const cidNode = new Map<string, IRNode>();
  const walk = (n: IRNode): void => {
    cidNode.set(n.id, n);
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) capCid.set(cap, n.id);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return { capCid, cidNode };
}

/** The captured `transition` shorthand, but only when it actually animates (some segment
 *  has a positive duration). Pure state styling — `transition: all 0s` / `none` — returns
 *  null. This is what makes a captured `:hover`/`:focus` change EASE like the source
 *  instead of snapping; `transition` is not a graded property (gate 4) and the validator
 *  screenshots with animations disabled, so emitting it is gate-neutral. */
function animatedTransition(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t || t === "none" || t === "all") return null;
  const animates = t.split(",").some((seg) => {
    const m = seg.trim().match(/(\d*\.?\d+)(ms|s)\b/); // first time token in a segment = its duration
    return m ? parseFloat(m[1]!) * (m[2] === "ms" ? 0.001 : 1) > 0 : false;
  });
  return animates ? t : null;
}

/**
 * Emit `:hover`/`:focus` CSS for the given IR + capture.
 *  - `include`: only emit for cids passing this predicate (route-body vs. chrome split).
 *  - `prefix`: prepend to the cid in the selector — hoisted chrome is rendered with
 *    namespaced `L`-prefixed cids, so its interaction rules must match (`.cLn15:hover`).
 */
export function generateInteractionCss(
  ir: IR,
  interaction: InteractionCapture | undefined,
  opts?: { include?: (cid: string) => boolean; prefix?: string; selector?: (cid: string) => string },
): string {
  if (!interaction) return "";
  const { capCid: map, cidNode } = capToCid(ir);
  const prefix = opts?.prefix ?? "";
  // How a cid maps to a CSS selector: default is the per-node `.c<id>` class (legacy CSS
  // mode); Tailwind mode passes `[data-cid="<id>"]` since nodes carry no `c<id>` class.
  const sel = opts?.selector ?? ((cid: string) => `.c${prefix}${cid}`);
  const canon = ir.doc.canonicalViewport;
  const lines: string[] = [];
  const transition = new Map<string, string>();
  const emit = (deltas: Record<string, StyleDelta>, pseudo: string): void => {
    for (const cap of Object.keys(deltas).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
      const cid = map.get(cap);
      const d = deltas[cap]!;
      if (!cid || !Object.keys(d).length) continue;
      if (opts?.include && !opts.include(cid)) continue;
      lines.push(rule(`${sel(cid)}${pseudo}`, d));
      if (!transition.has(cid)) {
        const node = cidNode.get(cid);
        const t = node && animatedTransition(node.computedByVp[canon]?.transition ?? node.computedByVp[ir.doc.viewports[0]!]?.transition);
        if (t) transition.set(cid, t);
      }
    }
  };
  emit(interaction.hover, ":hover");
  emit(interaction.focus, ":focus");
  // Descendant reveals: a hidden child overlay/CTA shown when the parent is hovered
  // (framer's "Read story" card hover). Emit `parent:hover child { delta }` + the child's own
  // transition on its base rule so the reveal eases. The child's hidden base (opacity:0)
  // already lives in the styling output, so it stays hidden at rest and appears on parent hover.
  // Uses sel() for both ends so it works in legacy-CSS (.c<id>) and Tailwind ([data-cid]) modes.
  for (const parentCap of Object.keys(interaction.hoverDesc ?? {}).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const pcid = map.get(parentCap); if (!pcid || (opts?.include && !opts.include(pcid))) continue;
    const descs = interaction.hoverDesc![parentCap]!;
    for (const childCap of Object.keys(descs).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
      const ccid = map.get(childCap); const d = descs[childCap]!;
      if (!ccid || !Object.keys(d).length) continue;
      lines.push(rule(`${sel(pcid)}:hover ${sel(ccid)}`, d));
      if (!transition.has(ccid)) {
        const node = cidNode.get(ccid);
        const t = node && animatedTransition(node.computedByVp[canon]?.transition ?? node.computedByVp[ir.doc.viewports[0]!]?.transition);
        if (t) transition.set(ccid, t);
      }
    }
  }
  const transLines = [...transition.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cid, t]) => `${sel(cid)}{transition:${t}}`);
  const all = [...transLines, ...lines];
  return all.length ? "\n/* Stage 4 — interaction states (hover/focus + eased transitions) */\n" + all.join("\n") + "\n" : "";
}
