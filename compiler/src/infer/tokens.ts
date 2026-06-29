import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

/**
 * Usage-based deterministic design-token extraction. Builds computed-style
 * histograms over the canonical viewport and promotes values used >= 3 times
 * (page background, primary text color, and primary font family are always
 * promoted). Tokens are stable and explainable rather than clever.
 */

export type Tokens = {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  fontSizes: Record<string, string>;
  fontWeights: Record<string, string>;
  lineHeights: Record<string, string>;
  spacing: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
  zIndices: Record<string, string>;
  breakpoints: Record<string, string>;
};

const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", "rgba(0,0,0,0)"]);

function hist(): Map<string, number> { return new Map(); }
function bump(m: Map<string, number>, v: string | undefined): void {
  if (!v) return;
  m.set(v, (m.get(v) ?? 0) + 1);
}
function topSorted(m: Map<string, number>, min = 3): Array<[string, number]> {
  return [...m.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function num(v: string | undefined): number {
  if (!v) return NaN;
  const m = /(-?\d+(\.\d+)?)/.exec(v);
  return m ? parseFloat(m[1]!) : NaN;
}

export function extractTokens(ir: IR): Tokens {
  const cw = ir.doc.canonicalViewport;
  const colors = hist();
  const fonts = hist();
  const fontSizes = hist();
  const fontWeights = hist();
  const lineHeights = hist();
  const spacing = hist();
  const radii = hist();
  const shadows = hist();
  const zIndices = hist();

  const visit = (node: IRNode): void => {
    const cs = node.computedByVp[cw];
    if (cs && node.visibleByVp[cw]) {
      if (cs.color && !TRANSPARENT.has(cs.color)) bump(colors, cs.color);
      if (cs.backgroundColor && !TRANSPARENT.has(cs.backgroundColor)) bump(colors, cs.backgroundColor);
      bump(fonts, cs.fontFamily);
      bump(fontSizes, cs.fontSize);
      bump(fontWeights, cs.fontWeight);
      if (cs.lineHeight && cs.lineHeight !== "normal") bump(lineHeights, cs.lineHeight);
      for (const p of ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "marginTop", "marginBottom", "gap"] as const) {
        const v = cs[p];
        if (v && v !== "0px" && /px$/.test(v)) bump(spacing, v);
      }
      for (const p of ["borderTopLeftRadius", "borderTopRightRadius"] as const) {
        const v = cs[p];
        if (v && v !== "0px") bump(radii, v);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") bump(shadows, cs.boxShadow);
      if (cs.zIndex && cs.zIndex !== "auto") bump(zIndices, cs.zIndex);
    }
    for (const c of node.children) if (!isTextChild(c)) visit(c);
  };
  visit(ir.root);

  const pv = ir.doc.perViewport[cw];

  // Colors: always promote page bg + primary text; then the rest by frequency.
  const colorTokens: Record<string, string> = {};
  const pageBg = pv?.bodyBg && !TRANSPARENT.has(pv.bodyBg) ? pv.bodyBg : "rgb(255, 255, 255)";
  colorTokens["--color-bg-page"] = pageBg;
  const colorRanked = topSorted(colors, 1).map(([v]) => v);
  const primaryText = pv?.bodyColor && !TRANSPARENT.has(pv.bodyColor) ? pv.bodyColor : colorRanked[0];
  if (primaryText) colorTokens["--color-text-primary"] = primaryText;
  let ci = 1;
  const usedColors = new Set([pageBg, primaryText]);
  for (const [v] of topSorted(colors, 3)) {
    if (usedColors.has(v)) continue;
    usedColors.add(v);
    colorTokens[`--color-${String(ci++).padStart(3, "0")}`] = v;
  }

  const fontTokens: Record<string, string> = {};
  const fontRanked = topSorted(fonts, 1).map(([v]) => v);
  if (fontRanked[0]) fontTokens["--font-body"] = fontRanked[0];
  let fi = 1;
  for (const [v] of topSorted(fonts, 3)) {
    if (v === fontRanked[0]) continue;
    fontTokens[`--font-${String(fi++).padStart(3, "0")}`] = v;
  }

  const numberedByValue = (m: Map<string, number>, prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const promoted = topSorted(m, 3).map(([v]) => v).sort((a, b) => num(a) - num(b));
    promoted.forEach((v, i) => { out[`${prefix}-${String(i + 1).padStart(3, "0")}`] = v; });
    return out;
  };
  const numberedByFreq = (m: Map<string, number>, prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    topSorted(m, 3).forEach(([v], i) => { out[`${prefix}-${String(i + 1).padStart(3, "0")}`] = v; });
    return out;
  };

  const breakpoints: Record<string, string> = {};
  ir.doc.viewports.forEach((vp) => { breakpoints[`--bp-${vp}`] = `${vp}px`; });

  return {
    colors: colorTokens,
    fonts: fontTokens,
    fontSizes: numberedByValue(fontSizes, "--font-size"),
    fontWeights: numberedByValue(fontWeights, "--font-weight"),
    lineHeights: numberedByFreq(lineHeights, "--line-height"),
    spacing: numberedByValue(spacing, "--space"),
    radii: numberedByValue(radii, "--radius"),
    shadows: numberedByFreq(shadows, "--shadow"),
    zIndices: numberedByValue(zIndices, "--z"),
    breakpoints,
  };
}

/** Resolve a (kebab CSS prop, value) to its `var(--token)` reference, or null. Exact
 *  match only — typography/spacing/radius/shadow/z tokens hold the literal computed value,
 *  so referencing them is byte-exact (fidelity-neutral). Colors are handled separately by
 *  the semantic palette (semanticTokens), so they are intentionally NOT resolved here. */
export type TokenResolver = (prop: string, value: string) => string | null;
export function buildTokenResolver(tokens: Tokens): TokenResolver {
  const inv = (group: Record<string, string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [name, val] of Object.entries(group)) if (!m.has(val)) m.set(val, name);
    return m;
  };
  const fonts = inv(tokens.fonts), fontSizes = inv(tokens.fontSizes), fontWeights = inv(tokens.fontWeights),
    lineHeights = inv(tokens.lineHeights), spacing = inv(tokens.spacing), radii = inv(tokens.radii),
    shadows = inv(tokens.shadows), zIndices = inv(tokens.zIndices);
  return (prop, value) => {
    let m: Map<string, string> | null = null;
    if (prop === "font-family") m = fonts;
    else if (prop === "font-size") m = fontSizes;
    else if (prop === "font-weight") m = fontWeights;
    else if (prop === "line-height") m = lineHeights;
    else if (/^(padding|margin)-(top|right|bottom|left)$/.test(prop) || prop === "gap" || prop === "row-gap" || prop === "column-gap") m = spacing;
    else if (/^border-(top|bottom)-(left|right)-radius$/.test(prop)) m = radii;
    else if (prop === "box-shadow") m = shadows;
    else if (prop === "z-index") m = zIndices;
    if (!m) return null;
    const name = m.get(value);
    return name ? `var(${name})` : null;
  };
}

export function tokensToCss(tokens: Tokens, skipColors = false): string {
  const lines: string[] = [":root {"];
  const groups: Array<[string, Record<string, string>]> = [
    ...(skipColors ? [] : [["colors", tokens.colors] as [string, Record<string, string>]]),
    ["fonts", tokens.fonts], ["fontSizes", tokens.fontSizes],
    ["fontWeights", tokens.fontWeights], ["lineHeights", tokens.lineHeights],
    ["spacing", tokens.spacing], ["radii", tokens.radii], ["shadows", tokens.shadows],
    ["zIndices", tokens.zIndices], ["breakpoints", tokens.breakpoints],
  ];
  for (const [label, group] of groups) {
    const keys = Object.keys(group);
    if (keys.length === 0) continue;
    lines.push(`  /* ${label} */`);
    for (const k of keys) lines.push(`  ${k}: ${group[k]};`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}
