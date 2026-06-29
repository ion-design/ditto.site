import type { IR, IRNode, StyleMap } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

/**
 * Semantic color tokens (Stage 3.5). Collects every used color with its *usage
 * context* (text / background / border / on an interactive element / the page
 * body), clusters near-identical values within the grader's ±2-per-channel color
 * tolerance (so tokenizing is fidelity-neutral by construction), and assigns
 * deterministic *semantic* names by role — `--background`, `--foreground`,
 * `--primary`/`--accent` (the brand color, by chromatic saturation + interactive
 * usage), `--border`, `--surface`, `--muted-foreground` — falling back to numbered
 * `--color-NNN` for the rest.
 *
 * The names are opinionated; the *values* are exact, so even a "wrong" role label
 * cannot hurt fidelity. The fidelity engine rewrites `color`/`background-color`/
 * `border-*-color` to `var(--token)` via `varForColor`; everything else stays literal.
 */

export type ColorToken = { name: string; value: string };
export type ColorPalette = {
  tokens: ColorToken[]; // ordered for :root emission
  /** A computed color value → `var(--name)`, or null when it isn't tokenized. */
  varForColor: (value: string) => string | null;
  css: string; // ":root { --background: …; … }"
};

const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", "rgba(0,0,0,0)", ""]);

type RGBA = [number, number, number, number];
function parseRgb(v: string): RGBA | null {
  const m = v.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1]!.split(/[,\/]/).map((s) => parseFloat(s.trim()));
  if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
  return [Math.round(p[0]!), Math.round(p[1]!), Math.round(p[2]!), p.length >= 4 && !Number.isNaN(p[3]!) ? p[3]! : 1];
}
function within2(a: RGBA, b: RGBA): boolean {
  return Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2 && Math.abs(a[3] - b[3]) <= 0.04;
}
/** Saturation + lightness (0–1) from RGB, for neutral-vs-chromatic classification. */
function satLight(c: RGBA): { s: number; l: number } {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

type Usage = { value: string; rgba: RGBA; count: number; text: number; bg: number; border: number; interactive: number };

function collectUsage(ir: IR): Map<string, Usage> {
  const cw = ir.doc.canonicalViewport;
  const usage = new Map<string, Usage>();
  const bump = (v: string | undefined, kind: "text" | "bg" | "border", interactive: boolean): void => {
    if (!v || TRANSPARENT.has(v)) return;
    const rgba = parseRgb(v);
    if (!rgba || rgba[3] === 0) return;
    let u = usage.get(v);
    if (!u) { u = { value: v, rgba, count: 0, text: 0, bg: 0, border: 0, interactive: 0 }; usage.set(v, u); }
    u.count++; u[kind]++; if (interactive) u.interactive++;
  };
  const walk = (n: IRNode): void => {
    const cs = n.computedByVp[cw];
    if (cs && n.visibleByVp[cw]) {
      const interactive = n.tag === "a" || n.tag === "button" || n.attrs.role === "button";
      bump(cs.color, "text", interactive);
      bump(cs.backgroundColor, "bg", interactive);
      for (const side of ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"] as const) {
        const w = cs[side.replace("Color", "Width") as keyof StyleMap];
        if (w && parseFloat(w) > 0) bump(cs[side], "border", interactive);
      }
    }
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return usage;
}

/** Greedy cluster: each color joins an existing canonical within ±2, else starts one.
 *  Canonicals are the most-frequent member, so every member is ≤±2 from it. */
function cluster(usages: Usage[]): Array<{ canon: Usage; members: string[] }> {
  const sorted = [...usages].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const clusters: Array<{ canon: Usage; members: string[]; agg: Usage }> = [];
  for (const u of sorted) {
    const hit = clusters.find((c) => within2(c.canon.rgba, u.rgba));
    if (hit) {
      hit.members.push(u.value);
      hit.agg.count += u.count; hit.agg.text += u.text; hit.agg.bg += u.bg; hit.agg.border += u.border; hit.agg.interactive += u.interactive;
    } else {
      clusters.push({ canon: u, members: [u.value], agg: { ...u } });
    }
  }
  return clusters.map((c) => ({ canon: { ...c.agg, value: c.canon.value, rgba: c.canon.rgba }, members: c.members }));
}

/** Single-page palette. */
export function buildColorPalette(ir: IR, opts?: { minCount?: number }): ColorPalette {
  return paletteFrom(collectUsage(ir), ir, opts?.minCount ?? 3);
}

/** Site-wide palette: union color usage across all routes so the whole site shares
 *  one `--primary`/`--foreground`/… ; `roleIr` (the entry) supplies the body bg/fg. */
export function buildSiteColorPalette(irs: IR[], roleIr: IR, opts?: { minCount?: number }): ColorPalette {
  const merged = new Map<string, Usage>();
  for (const ir of irs) {
    for (const [k, u] of collectUsage(ir)) {
      const e = merged.get(k);
      if (!e) merged.set(k, { ...u });
      else { e.count += u.count; e.text += u.text; e.bg += u.bg; e.border += u.border; e.interactive += u.interactive; }
    }
  }
  return paletteFrom(merged, roleIr, opts?.minCount ?? 3);
}

function paletteFrom(usage: Map<string, Usage>, roleIr: IR, minCount: number): ColorPalette {
  const cw = roleIr.doc.canonicalViewport;
  const pv = roleIr.doc.perViewport[cw];
  const clusters = cluster([...usage.values()]);

  const valueToName = new Map<string, string>(); // every member value → token name
  const tokens: ColorToken[] = [];
  const taken = new Set<string>();
  const assign = (name: string, c: { canon: Usage; members: string[] }): void => {
    if (taken.has(name)) return;
    taken.add(name);
    tokens.push({ name, value: c.canon.value });
    for (const m of c.members) valueToName.set(m, name);
  };
  const findCluster = (val: string | undefined): { canon: Usage; members: string[] } | undefined => {
    if (!val) return undefined;
    const rgba = parseRgb(val);
    if (!rgba) return undefined;
    return clusters.find((c) => within2(c.canon.rgba, rgba));
  };

  // 1) Always-named roles: page background + primary foreground.
  const bgCluster = findCluster(pv?.bodyBg && !TRANSPARENT.has(pv.bodyBg) ? pv.bodyBg : "rgb(255, 255, 255)");
  if (bgCluster) assign("--background", bgCluster);
  const fgCluster = findCluster(pv?.bodyColor);
  if (fgCluster) assign("--foreground", fgCluster);

  // 2) Primary/accent: most-used chromatic color, weighted toward interactive usage.
  const remaining = clusters.filter((c) => !c.members.some((m) => valueToName.has(m)));
  const chromatic = remaining
    .filter((c) => { const { s } = satLight(c.canon.rgba); return s >= 0.25; })
    .sort((a, b) => (b.canon.interactive * 3 + b.canon.count) - (a.canon.interactive * 3 + a.canon.count));
  if (chromatic[0]) assign("--primary", chromatic[0]);
  if (chromatic[1]) assign("--accent", chromatic[1]);

  // 3) Border: most-used color that appears predominantly as a border.
  const borderC = remaining
    .filter((c) => !c.members.some((m) => valueToName.has(m)) && c.canon.border > 0)
    .sort((a, b) => b.canon.border - a.canon.border)[0];
  if (borderC && borderC.canon.border >= Math.max(2, minCount - 1)) assign("--border", borderC);

  // 4) Neutrals: a light neutral used as a background → surface; a mid neutral text → muted.
  for (const c of remaining) {
    if (c.members.some((m) => valueToName.has(m))) continue;
    if (c.canon.count < minCount) continue;
    const { s, l } = satLight(c.canon.rgba);
    if (s < 0.15 && c.canon.bg >= c.canon.text && l > 0.85 && !taken.has("--surface")) assign("--surface", c);
    else if (s < 0.2 && c.canon.text >= c.canon.bg && l > 0.35 && l < 0.7 && !taken.has("--muted-foreground")) assign("--muted-foreground", c);
  }

  // 5) Everything else used >= minCount → numbered.
  let ci = 1;
  for (const c of remaining) {
    if (c.members.some((m) => valueToName.has(m))) continue;
    if (c.canon.count < minCount) continue;
    assign(`--color-${String(ci++).padStart(3, "0")}`, c);
  }

  const varForColor = (value: string): string | null => {
    const name = valueToName.get(value);
    if (name) return `var(${name})`;
    const c = findCluster(value); // tolerate values within ±2 of a tokenized canonical
    const m = c?.members.find((x) => valueToName.has(x));
    return m ? `var(${valueToName.get(m)!})` : null;
  };

  const css = tokens.length
    ? ":root {\n" + tokens.map((t) => `  ${t.name}: ${t.value};`).join("\n") + "\n}\n"
    : "";

  return { tokens, varForColor, css };
}
