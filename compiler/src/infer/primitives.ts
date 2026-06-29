import type { IR, IRNode, StyleMap } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

/**
 * Typed-primitive recognition (Stage 3.5). Deterministically classifies each node
 * as a recognized UI primitive — button / link / input / select / textarea / icon /
 * image / avatar / badge / heading / nav — from tag + ARIA + a few computed-style
 * signals. The generator stamps the type onto the DOM as `data-component="…"` (an
 * attribute, so it cannot affect computed styles or structure matching — fidelity-
 * neutral by construction) and records the inventory in `components.json`.
 *
 * Conservative + bounded (an allowlist, like the Stage-4 interaction patterns): a
 * node we aren't confident about stays untyped. Behavior (open/close, tabs) is NOT
 * inferred here — that's Stage 4; this is structure/semantics only.
 */

export type PrimitiveType =
  | "button" | "link" | "input" | "select" | "textarea"
  | "icon" | "image" | "avatar" | "badge" | "heading" | "nav";

const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", "rgba(0,0,0,0)", ""]);

function px(v: string | undefined): number {
  if (!v) return 0;
  const m = /(-?\d+(?:\.\d+)?)/.exec(v);
  return m ? parseFloat(m[1]!) : 0;
}
function hasBg(cs: StyleMap): boolean {
  return !!cs.backgroundColor && !TRANSPARENT.has(cs.backgroundColor);
}
function hasBorder(cs: StyleMap): boolean {
  return (["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const).some((p) => px(cs[p]) > 0);
}
function hasPadding(cs: StyleMap): boolean {
  return (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const).some((p) => px(cs[p]) > 0);
}
function isRound(cs: StyleMap, bb: { width: number; height: number } | undefined): boolean {
  const r = cs.borderTopLeftRadius || "";
  if (r.includes("%")) return px(r) >= 40;
  if (bb) return px(r) >= Math.min(bb.width, bb.height) / 2 - 1 && px(r) > 4;
  return false;
}

function classify(n: IRNode, cw: number): PrimitiveType | null {
  const tag = n.tag;
  const a = n.attrs;
  const role = a.role;
  const cs = n.computedByVp[cw];
  const bb = n.bboxByVp[cw];
  const text = n.children.filter(isTextChild).map((c) => (c as { text: string }).text).join("").trim();

  // Form controls (tag/ARIA — unambiguous).
  if (tag === "select" || role === "listbox" || role === "combobox") return "select";
  if (tag === "textarea") return "textarea";
  if (tag === "input") {
    const ty = (a.type || "text").toLowerCase();
    return ty === "button" || ty === "submit" || ty === "reset" ? "button" : "input";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav" || role === "navigation") return "nav";
  if (tag === "button" || role === "button") return "button";

  // SVG: small = icon, larger = image/illustration.
  if (tag === "svg") return bb && bb.width <= 48 && bb.height <= 48 ? "icon" : "image";

  // Raster images: round + square = avatar.
  if (tag === "img") return cs && bb && Math.abs(bb.width - bb.height) <= 6 && isRound(cs, bb) ? "avatar" : "image";

  // Anchors: a "button-like" link (filled/outlined pill with padding, not a huge
  // block) is a button; otherwise a text link.
  if (tag === "a" && a.href !== undefined) {
    if (cs && bb && (hasBg(cs) || hasBorder(cs)) && hasPadding(cs) &&
        /inline-block|inline-flex|flex|inline-grid/.test(cs.display || "") &&
        bb.width < cw * 0.6 && bb.height <= 80 && text.length > 0 && text.length < 40) {
      return "button";
    }
    return "link";
  }

  // Badge/pill/tag: small inline-block chip with a background + rounding + short text,
  // not itself interactive.
  if (cs && bb && text && text.length <= 24 &&
      /inline-block|inline-flex/.test(cs.display || "") &&
      hasBg(cs) && px(cs.borderTopLeftRadius) > 0 &&
      bb.height > 0 && bb.height <= 32 && bb.width <= 160) {
    return "badge";
  }

  return null;
}

export function recognizePrimitives(ir: IR): Map<string, PrimitiveType> {
  const cw = ir.doc.canonicalViewport;
  const out = new Map<string, PrimitiveType>();
  const walk = (n: IRNode): void => {
    if (n.visibleByVp[cw]) {
      const t = classify(n, cw);
      if (t) out.set(n.id, t);
    }
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return out;
}

export type PrimitiveInventory = { count: number; byType: Record<string, number>; items: Array<{ cid: string; type: PrimitiveType; tag: string }> };

export function inventoryOf(ir: IR, prims: Map<string, PrimitiveType>): PrimitiveInventory {
  const byType: Record<string, number> = {};
  const items: PrimitiveInventory["items"] = [];
  const walk = (n: IRNode): void => {
    const t = prims.get(n.id);
    if (t) { byType[t] = (byType[t] ?? 0) + 1; items.push({ cid: n.id, type: t, tag: n.tag }); }
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return { count: items.length, byType, items };
}
