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

/** Parse the numeric args of a `fn(a b c / d)` / `fn(a,b,c,d)` color into [a,b,c,alpha].
 *  Percentages resolve against `pctBase` (255 for rgb channels, 1 for lab/lch/oklab/oklch
 *  L and the c/ab axes where the caller passes their own scale). `none` → 0. */
function parseColorArgs(inner: string): { nums: number[]; alpha: number } | null {
  const parts = inner.split("/");
  const main = parts[0]!.trim().split(/[\s,]+/).filter(Boolean);
  const nums = main.map((s) => (s === "none" ? 0 : parseFloat(s)));
  if (nums.length < 3 || nums.slice(0, 3).some(Number.isNaN)) return null;
  let alpha = 1;
  const alphaTok = parts.length > 1 ? parts[1]!.trim() : main[3];
  if (alphaTok !== undefined && alphaTok !== "none") {
    const a = alphaTok.endsWith("%") ? parseFloat(alphaTok) / 100 : parseFloat(alphaTok);
    if (!Number.isNaN(a)) alpha = a;
  }
  return { nums, alpha };
}

function pctOr(tok: string, base: number): number {
  return tok.endsWith("%") ? (parseFloat(tok) / 100) * base : parseFloat(tok);
}

/** Linear-light sRGB channel → gamma-encoded 0–255. */
function lin2srgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** OKLab → sRGB (CSS Color 4 reference matrices). Returns gamma-encoded 0–255. */
function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [lin2srgb(r), lin2srgb(g), lin2srgb(bl)];
}

/** CIE Lab (D50) → sRGB, gamma-encoded 0–255. */
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const d = 6 / 29;
  const inv = (t: number): number => (t > d ? t ** 3 : 3 * d * d * (t - 4 / 29));
  // D50 white point.
  const X = 0.9642956 * inv(fx), Y = 1.0 * inv(fy), Z = 0.8251046 * inv(fz);
  // XYZ(D50) → linear sRGB (Bradford-adapted D50→D65 folded in).
  const r = +3.1341359 * X - 1.6172206 * Y - 0.4906860 * Z;
  const g = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
  const bl = +0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  return [lin2srgb(r), lin2srgb(g), lin2srgb(bl)];
}

/** Parse any CSS color value (`rgb`/`rgba`/`hsl`/`hsla`/`oklab`/`oklch`/`lab`/`lch`/hex/
 *  named-ish) into rounded sRGB `[r,g,b,alpha]`, else null. The literal value is kept
 *  verbatim in emitted CSS; this RGB is used ONLY for clustering (grader works in sRGB
 *  ±2), so oklab/lch colours cluster + earn semantic roles instead of falling to --clr-N. */
function parseColor(v: string): RGBA | null {
  const s = v.trim().toLowerCase();
  if (s === "white") return [255, 255, 255, 1];
  if (s === "black") return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const fn = /^(rgba?|hsla?|oklab|oklch|lab|lch)\(([^)]*)\)$/i.exec(s);
  if (!fn) return null;
  const kind = fn[1]!, parsed = parseColorArgs(fn[2]!);
  if (!parsed) return null;
  const { nums, alpha } = parsed;
  const raw = fn[2]!.split("/")[0]!.trim().split(/[\s,]+/).filter(Boolean);
  if (kind.startsWith("rgb")) {
    return [Math.round(pctOr(raw[0]!, 255)), Math.round(pctOr(raw[1]!, 255)), Math.round(pctOr(raw[2]!, 255)), alpha];
  }
  if (kind.startsWith("hsl")) {
    const H = ((nums[0]! % 360) + 360) % 360, S = pctOr(raw[1]!, 1), Lh = pctOr(raw[2]!, 1);
    const c = (1 - Math.abs(2 * Lh - 1)) * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = Lh - c / 2;
    const [r1, g1, b1] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255), alpha];
  }
  if (kind === "oklab") { const [r, g, b] = oklabToRgb(pctOr(raw[0]!, 1), nums[1]!, nums[2]!); return [r, g, b, alpha]; }
  if (kind === "oklch") {
    const L = pctOr(raw[0]!, 1), C = nums[1]!, h = (nums[2]! * Math.PI) / 180;
    const [r, g, b] = oklabToRgb(L, C * Math.cos(h), C * Math.sin(h)); return [r, g, b, alpha];
  }
  if (kind === "lab") { const [r, g, b] = labToRgb(pctOr(raw[0]!, 100), nums[1]!, nums[2]!); return [r, g, b, alpha]; }
  if (kind === "lch") {
    const L = pctOr(raw[0]!, 100), C = nums[1]!, h = (nums[2]! * Math.PI) / 180;
    const [r, g, b] = labToRgb(L, C * Math.cos(h), C * Math.sin(h)); return [r, g, b, alpha];
  }
  return null;
}

/** Back-compat alias: the palette parses every colour space now, not just rgb(). */
function parseRgb(v: string): RGBA | null {
  return parseColor(v);
}

/** A stable clustering key for a color literal: its rounded sRGB (+ alpha), so two literals
 *  that render the same colour (`oklab(0.988242 …)` and `oklab(0.988371 …)` → rgb(251,251,251))
 *  collapse to ONE minted token instead of a wall of near-identical --clr-N. Null when the
 *  value can't be parsed (keeps the raw literal as its own key). Alpha bucketed to ±0.02. */
export function colorClusterKey(v: string): string | null {
  const c = parseColor(v);
  if (!c) return null;
  return `${c[0]},${c[1]},${c[2]},${Math.round(c[3] * 50)}`;
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

  // Luminance (0–1) for deterministic tiebreaks (Rec.709). Ties in every ranking below
  // break by count, then luminance (dark→light), then the literal value — so the palette
  // is byte-stable for a given capture (determinism gate 6).
  const lum = (c: Usage): number => (0.2126 * c.rgba[0] + 0.7152 * c.rgba[1] + 0.0722 * c.rgba[2]) / 255;
  const unnamed = (c: { canon: Usage; members: string[] }): boolean => !c.members.some((m) => valueToName.has(m));
  const byCount = (score: (c: Usage) => number) => (a: { canon: Usage }, b: { canon: Usage }): number =>
    score(b.canon) - score(a.canon) || b.canon.count - a.canon.count || lum(a.canon) - lum(b.canon) || a.canon.value.localeCompare(b.canon.value);

  // 2) Brand + accent: the most-used chromatic colours, weighted toward interactive usage
  //    (buttons/links). `--primary` (a.k.a. brand) is the strongest; `--accent` the next.
  //    A colour is "chromatic" only with real hue: HSL saturation ≥ 0.25 AND an absolute
  //    channel spread ≥ 24, so near-neutral off-whites/creams (max−min ≈ 10) that merely
  //    tip over the ratio threshold stay neutrals → --surface, not a fake --accent.
  const chroma = (c: RGBA): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const remaining = clusters.filter(unnamed);
  const chromatic = remaining
    .filter((c) => satLight(c.canon.rgba).s >= 0.25 && chroma(c.canon.rgba) >= 24)
    .sort(byCount((c) => c.interactive * 3 + c.count));
  if (chromatic[0]) assign("--primary", chromatic[0]);
  if (chromatic[1]) assign("--accent", chromatic[1]);

  // 3) Border: most-used colour that appears predominantly as a border.
  const borderC = remaining
    .filter((c) => unnamed(c) && c.canon.border > 0)
    .sort(byCount((c) => c.border))[0];
  if (borderC && borderC.canon.border >= Math.max(2, minCount - 1)) assign("--border", borderC);

  // 4) Neutrals, ranked so the most-used earns the cleanest name. Light neutrals used as
  //    backgrounds → --surface, --surface-2, … (section/card/footer alt backgrounds);
  //    mid/dark neutrals used as text → --muted-foreground then --muted. "Neutral" is the
  //    complement of "chromatic" above (no strong hue: low saturation OR tiny channel spread),
  //    so no colour falls through the gap between the two thresholds.
  const neutrals = remaining
    .filter((c) => unnamed(c) && c.canon.count >= minCount && (satLight(c.canon.rgba).s < 0.25 || chroma(c.canon.rgba) < 24))
    .sort(byCount((c) => c.count));
  let surfaceN = 0;
  for (const c of neutrals) {
    if (!unnamed(c)) continue;
    const { l } = satLight(c.canon.rgba);
    if (c.canon.bg >= c.canon.text && l > 0.85) {
      assign(surfaceN === 0 ? "--surface" : `--surface-${surfaceN + 1}`, c);
      surfaceN++;
    } else if (c.canon.text >= c.canon.bg && l > 0.2 && l < 0.7) {
      assign(!taken.has("--muted-foreground") ? "--muted-foreground" : "--muted", c);
    }
  }

  // 5) Everything else used >= minCount → numbered, in a deterministic order.
  let ci = 1;
  for (const c of [...remaining].sort(byCount(() => 0))) {
    if (!unnamed(c)) continue;
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
