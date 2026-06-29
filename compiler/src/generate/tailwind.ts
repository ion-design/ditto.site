/**
 * Tailwind v4 emitter (output-quality, fidelity-neutral).
 *
 * Instead of hand-named semantic CSS classes (classMap.ts), translate each node's exact
 * computed declarations into Tailwind utility classes. The fidelity guarantee rests on
 * Tailwind's ARBITRARY VALUES: `w-[610px]` compiles to exactly `width:610px`, so our
 * per-node truth (collectNodeRules) maps 1:1 to utilities — same rendered CSS, just
 * expressed as utilities a reader (or an LLM) can read alongside the node.
 *
 * Strategy: keyword props → the canonical utility (flex/items-center/…); colors →
 * named theme tokens (bg-primary, via @theme bindings — avoids raw rgb in markup);
 * lengths/numbers → arbitrary-value utilities (w-[610px], pt-[15px], text-[16px]);
 * anything else → the arbitrary-property escape `[prop:value]`. Per-viewport band deltas
 * become arbitrary responsive variants (`max-[571px]:`, `min-[572px]:max-[1024px]:`) that
 * compile to exactly our band media queries. Pseudo-elements + interaction CSS target
 * `[data-cid="…"]` (no class needed).
 */
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { collectNodeRules, computeBands, keyframesCss, type NodeRule } from "./css.js";
import type { InteractionCapture, StyleDelta } from "../capture/interactions.js";

// ---- arbitrary-value escaping ----
/** Escape a CSS value for use inside a Tailwind arbitrary `[…]`: double quotes → single
 *  (valid CSS, and avoids breaking the double-quoted JS className string / React attr —
 *  e.g. font-family `"Source Serif 4"` → `'Source Serif 4'`), literal `_` → `\_`, then
 *  spaces → `_` (so `0px 4px rgba(0, 0, 0, .1)` → `0px_4px_rgba(0,_0,_0,_.1)`). */
function arb(v: string): string {
  return v.replace(/"/g, "'").replace(/_/g, "\\_").replace(/ /g, "_");
}
function arbList(v: string): string {
  return arb(v).replace(/,_/g, ",");
}
function arbAspect(v: string): string {
  return arbList(v).replace(/_?\/_?/g, "/");
}

// ---- keyword props → canonical utility ----
const KW: Record<string, Record<string, string>> = {
  display: { flex: "flex", block: "block", "inline-block": "inline-block", inline: "inline", grid: "grid", none: "hidden", "inline-flex": "inline-flex", "inline-grid": "inline-grid", "flow-root": "flow-root", table: "table", "table-cell": "table-cell", "table-row": "table-row", "table-row-group": "table-row-group", "table-header-group": "table-header-group", "list-item": "list-item", contents: "contents" },
  position: { relative: "relative", absolute: "absolute", fixed: "fixed", sticky: "sticky", static: "static" },
  "box-sizing": { "border-box": "box-border", "content-box": "box-content" },
  "flex-direction": { row: "flex-row", column: "flex-col", "column-reverse": "flex-col-reverse", "row-reverse": "flex-row-reverse" },
  "flex-wrap": { wrap: "flex-wrap", "wrap-reverse": "flex-wrap-reverse", nowrap: "flex-nowrap" },
  "justify-content": { center: "justify-center", "flex-start": "justify-start", start: "justify-start", "flex-end": "justify-end", end: "justify-end", "space-between": "justify-between", "space-around": "justify-around", "space-evenly": "justify-evenly", stretch: "justify-stretch", normal: "justify-normal" },
  "justify-items": { center: "justify-items-center", start: "justify-items-start", end: "justify-items-end", stretch: "justify-items-stretch" },
  "align-items": { center: "items-center", "flex-start": "items-start", start: "items-start", "flex-end": "items-end", end: "items-end", stretch: "items-stretch", baseline: "items-baseline" },
  "align-content": { center: "content-center", "flex-start": "content-start", "flex-end": "content-end", "space-between": "content-between", "space-around": "content-around", "space-evenly": "content-evenly", stretch: "content-stretch", normal: "content-normal" },
  "align-self": { auto: "self-auto", center: "self-center", "flex-start": "self-start", "flex-end": "self-end", stretch: "self-stretch", baseline: "self-baseline" },
  "text-align": { center: "text-center", left: "text-left", right: "text-right", justify: "text-justify", start: "text-start", end: "text-end" },
  "text-transform": { uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize", none: "normal-case" },
  "font-style": { italic: "italic", normal: "not-italic" },
  "font-weight": { "100": "font-thin", "200": "font-extralight", "300": "font-light", "400": "font-normal", "500": "font-medium", "600": "font-semibold", "700": "font-bold", "800": "font-extrabold", "900": "font-black" },
  "text-decoration-line": { underline: "underline", "line-through": "line-through", overline: "overline", none: "no-underline" },
  "white-space": { nowrap: "whitespace-nowrap", normal: "whitespace-normal", pre: "whitespace-pre", "pre-line": "whitespace-pre-line", "pre-wrap": "whitespace-pre-wrap", "break-spaces": "whitespace-break-spaces" },
  "overflow-x": { hidden: "overflow-x-hidden", auto: "overflow-x-auto", scroll: "overflow-x-scroll", visible: "overflow-x-visible", clip: "overflow-x-clip" },
  "overflow-y": { hidden: "overflow-y-hidden", auto: "overflow-y-auto", scroll: "overflow-y-scroll", visible: "overflow-y-visible", clip: "overflow-y-clip" },
  "object-fit": { contain: "object-contain", cover: "object-cover", fill: "object-fill", none: "object-none", "scale-down": "object-scale-down" },
  "vertical-align": { middle: "align-middle", top: "align-top", bottom: "align-bottom", baseline: "align-baseline", sub: "align-sub", super: "align-super", "text-top": "align-text-top", "text-bottom": "align-text-bottom" },
  "background-repeat": { "no-repeat": "bg-no-repeat", repeat: "bg-repeat", "repeat-x": "bg-repeat-x", "repeat-y": "bg-repeat-y", round: "bg-repeat-round", space: "bg-repeat-space" },
  "background-size": { cover: "bg-cover", contain: "bg-contain", auto: "bg-auto" },
  visibility: { hidden: "invisible", visible: "visible", collapse: "collapse" },
  "list-style-position": { inside: "list-inside", outside: "list-outside" },
  "pointer-events": { none: "pointer-events-none", auto: "pointer-events-auto" },
  cursor: { pointer: "cursor-pointer", default: "cursor-default", auto: "cursor-auto", text: "cursor-text", move: "cursor-move", wait: "cursor-wait", help: "cursor-help", "not-allowed": "cursor-not-allowed", grab: "cursor-grab", grabbing: "cursor-grabbing" },
  float: { left: "float-left", right: "float-right", none: "float-none" },
  clear: { left: "clear-left", right: "clear-right", both: "clear-both", none: "clear-none" },
  isolation: { isolate: "isolate", auto: "isolation-auto" },
};

// ---- length / number props → arbitrary-value utility prefix ----
const ARB: Record<string, string> = {
  width: "w", height: "h", "min-width": "min-w", "max-width": "max-w", "min-height": "min-h", "max-height": "max-h",
  "padding-top": "pt", "padding-right": "pr", "padding-bottom": "pb", "padding-left": "pl",
  "margin-top": "mt", "margin-right": "mr", "margin-bottom": "mb", "margin-left": "ml",
  gap: "gap", "row-gap": "gap-y", "column-gap": "gap-x",
  "font-size": "text", "line-height": "leading", "letter-spacing": "tracking", "text-indent": "indent",
  top: "top", right: "right", bottom: "bottom", left: "left", "z-index": "z", opacity: "opacity", order: "order",
  "flex-grow": "grow", "flex-shrink": "shrink", "flex-basis": "basis",
  "border-top-left-radius": "rounded-tl", "border-top-right-radius": "rounded-tr",
  "border-bottom-right-radius": "rounded-br", "border-bottom-left-radius": "rounded-bl",
  "aspect-ratio": "aspect", "grid-template-columns": "grid-cols", "grid-template-rows": "grid-rows", "object-position": "object",
};
// `auto` has named utilities for these; arbitrary `[auto]` is unreliable.
const AUTO_NAMED: Record<string, string> = {
  width: "w-auto", height: "h-auto", "margin-top": "mt-auto", "margin-right": "mr-auto",
  "margin-bottom": "mb-auto", "margin-left": "ml-auto", "flex-basis": "basis-auto", top: "top-auto",
  right: "right-auto", bottom: "bottom-auto", left: "left-auto",
};

// Props whose numeric Tailwind utility resolves to `calc(var(--spacing) * N)` (--spacing = 0.25rem).
// For these a clean length maps onto the scale (`w-[28.125rem]` → `w-112.5`) — same rendered px,
// idiomatic class. NOT font-size/letter-spacing/radius/etc., whose numeric scales differ.
const SPACE_SCALE = new Set<string>([
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap", "top", "right", "bottom", "left", "text-indent", "line-height",
]);
// Props that take 100% → the `-full` named utility (exact: w-full ≡ width:100%).
const PCT_FULL = new Set<string>(["width", "height", "min-width", "max-width", "min-height", "max-height"]);
const ORIGIN_NAMED: Record<string, string> = {
  center: "origin-center", top: "origin-top", "top right": "origin-top-right", right: "origin-right",
  "bottom right": "origin-bottom-right", bottom: "origin-bottom", "bottom left": "origin-bottom-left",
  left: "origin-left", "top left": "origin-top-left",
};

/** A px/rem length as a multiple of the 0.25rem spacing unit, when it lands on a clean integer or
 *  half step (`2.375rem`→9.5, `450px`→112.5); else null so the value stays an exact arbitrary
 *  `[…]`. Half is the tightest step Tailwind's own scale uses, so odd sub-px stays literal. */
function spacingSteps(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(value);
  if (!m) return null;
  const num = parseFloat(m[1]!);
  const steps = (m[2] === "px" ? num / 16 : num) / 0.25; // px→rem at 16px root, then /--spacing
  return Math.abs(steps * 2 - Math.round(steps * 2)) < 1e-9 ? steps : null;
}

/** A color token reference `var(--name)` → the bare token name (else null). */
function tokenName(v: string): string | null {
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  return m ? m[1]! : null;
}
function pf(v: string | undefined): number {
  const n = parseFloat(v || "0");
  return Number.isFinite(n) ? n : 0;
}

/** A pure-translate `matrix(1,0,0,1,e,f)` (or `translate(...)`) → its translate offsets, else null
 *  (it carries scale/rotate/skew and must stay an exact arbitrary transform). */
function translateOffsets(v: string): { x: number; y: number } | null {
  const m = /^matrix\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)$/.exec(v);
  if (m) { const [a, b, c, d, e, f] = m.slice(1).map(parseFloat) as number[]; return a === 1 && b === 0 && c === 0 && d === 1 ? { x: e!, y: f! } : null; }
  const t = /^translate(X|Y)?\(\s*(-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\s*\)$/.exec(v);
  if (t) { const n = parseFloat(t[2]!); return t[1] === "X" ? { x: n, y: 0 } : t[1] === "Y" ? { x: 0, y: n } : { x: n, y: t[3] ? parseFloat(t[3]) : 0 }; }
  return null;
}
/** True when `transform` does something `transform-origin` matters for (rotate/scale/skew) —
 *  i.e. NOT a pure translate or `none`. Used to drop the pile of baked `origin-[Npx_Npx]`. */
function transformNeedsOrigin(v: string | undefined): boolean {
  return !!v && v !== "none" && translateOffsets(v) === null;
}

/** Translate ONE computed declaration into a Tailwind utility (no responsive prefix). */
function declToUtil(prop: string, value: string): string {
  // Colors → named theme tokens when tokenized (bg-primary), else arbitrary value.
  if (prop === "color") { const n = tokenName(value); return n ? `text-${n}` : `text-[color:${arb(value)}]`; }
  if (prop === "background-color") { const n = tokenName(value); return n ? `bg-${n}` : `bg-[${arb(value)}]`; }
  // Per-side border color/style → idiomatic sided utilities (`border-b-<token>`, `border-solid`)
  // instead of the arbitrary-property longhand. Single-side borders (the common non-uniform case
  // css.ts leaves sided) then read like hand-written Tailwind rather than `[border-bottom-color:…]`.
  if (/^border-(top|right|bottom|left)-color$/.test(prop)) {
    const side = prop.split("-")[1]![0]!; const n = tokenName(value);
    return n ? `border-${side}-${n}` : `border-${side}-[${arb(value)}]`;
  }
  if (/^border-(top|right|bottom|left)-style$/.test(prop)) return `border-${value}`;
  // Uniform border shorthand (css.ts collapses equal 4-side borders) → idiomatic utilities:
  //   border-color → named token (border-border) or arbitrary; border-style → border-<style>
  //   (our reset already defaults to solid, but emitting it reads like hand-written Tailwind);
  //   border-width → `border` (1px), the named steps (border-2/4/8), else arbitrary.
  if (prop === "border-color") { const n = tokenName(value); return n ? `border-${n}` : `border-[${arb(value)}]`; }
  if (prop === "border-style") return `border-${value}`;
  if (prop === "border-width") {
    const px = /^(\d*\.?\d+)px$/.exec(value);
    if (px) { const n = +px[1]!; if (n === 1) return "border"; if (n === 0) return "border-0"; if (n === 2 || n === 4 || n === 8) return `border-${n}`; }
    return `border-[${arb(value)}]`;
  }
  // Outline: color → token utility (outline-clr-N ≡ outline-color:var(--clr-N) via @theme), width
  // → the named steps. Mirrors border so focus rings read idiomatically.
  if (prop === "outline-color") { const n = tokenName(value); return n ? `outline-${n}` : `outline-[${arb(value)}]`; }
  if (prop === "outline-width") {
    const px = /^(\d*\.?\d+)px$/.exec(value);
    if (px) { const n = +px[1]!; if (n === 0) return "outline-0"; if (n === 1 || n === 2 || n === 4 || n === 8) return `outline-${n}`; }
    return `outline-[${arb(value)}]`;
  }
  if (prop === "transform-origin") return ORIGIN_NAMED[value] ?? `origin-[${arb(value)}]`;
  // An identity matrix(1,0,0,1,0,0) is the browser's noisy report of "no transform" → drop it. A real
  // transform stays an EXACT arbitrary `[transform:…]`: Tailwind's `translate-x-*` utilities resolve
  // through `--tw-translate-*` custom properties whose @property initial-values our no-preflight harness
  // omits, so `translate: var(--tw-translate-x) var(--tw-translate-y)` would render invalid — the
  // arbitrary transform has no such dependency and reproduces the matrix verbatim.
  if (prop === "transform") {
    const o = translateOffsets(value);
    if (o && o.x === 0 && o.y === 0) return "";
    return `transform-[${arbList(value)}]`;
  }
  // Individual transform properties (translate/rotate/scale, CSS Transforms L2). Emit the RAW
  // property `[translate:…]` so it sets `translate`/`rotate`/`scale` DIRECTLY — Tailwind's
  // `translate-*`/`scale-*`/`rotate-*` utilities resolve through `--tw-*` custom properties whose
  // @property initial-values our no-preflight harness omits, so they'd render invalid (the same trap
  // as `transform`). A no-op value (`0px`, `1`, `0deg`, `none`) is dropped — it's the browser's noise.
  if (prop === "translate" || prop === "rotate" || prop === "scale") {
    if (/^(none|0px|0px 0px|0%|0% 0%|0deg|1|1 1|1 1 1)$/.test(value.trim())) return "";
    return `[${prop}:${arb(value)}]`;
  }
  // `-webkit-line-clamp:N` → the named utility (which also sets display:-webkit-box,
  // -webkit-box-orient:vertical, overflow:hidden — the generator suppresses those companions).
  if (prop === "-webkit-line-clamp") return /^\d+$/.test(value) ? `line-clamp-${value}` : `[${prop}:${arb(value)}]`;
  // `text-` is Tailwind's shared prefix for BOTH color and font-size. A length value
  // (text-[21px]) is unambiguously font-size, but a keyword/var (inherit, initial,
  // var(--x)) inside text-[…] is parsed as a COLOR — silently changing the wrong property
  // (seen on responsive `font-size:inherit` bands). Route non-length font-sizes to the
  // explicit arbitrary-property form so they always compile to font-size.
  if (prop === "font-size" && !/^(-?[\d.]|calc\(|clamp\(|min\(|max\()/.test(value)) return `[font-size:${arb(value)}]`;
  // Keyword props.
  if (KW[prop] && KW[prop]![value]) return KW[prop]![value]!;
  // Subgrid / none grid templates → the named v4 utility (the `[] [] []` line-name placeholders
  // carry no names, so they drop): `grid-template-rows: subgrid …` → `grid-rows-subgrid`.
  if (prop === "grid-template-columns" || prop === "grid-template-rows") {
    if (/^subgrid\b/.test(value)) return `${ARB[prop]}-subgrid`;
    if (value === "none") return `${ARB[prop]}-none`;
  }
  // Length / number props.
  if (ARB[prop]) {
    if (value === "auto" && AUTO_NAMED[prop]) return AUTO_NAMED[prop]!;
    if (value === "100%" && PCT_FULL.has(prop)) return `${ARB[prop]}-full`;
    if (value === "100vh") {
      if (prop === "height") return "h-screen";
      if (prop === "min-height") return "min-h-screen";
    }
    if (value === "none" && (prop === "max-width" || prop === "max-height")) return `${ARB[prop]}-none`;
    if (prop === "aspect-ratio") return value === "auto" ? "aspect-auto" : `aspect-[${arbAspect(value)}]`;
    if (prop === "z-index") {
      if (value === "auto") return "z-auto";
      if (/^-?\d+$/.test(value)) return Number(value) < 0 ? `-z-${Math.abs(Number(value))}` : `z-${value}`;
    }
    if (prop === "opacity") { const o = parseFloat(value); if (!Number.isNaN(o) && Math.abs(o * 100 - Math.round(o * 100)) < 1e-6) return `opacity-${Math.round(o * 100)}`; }
    if (SPACE_SCALE.has(prop)) {
      const n = spacingSteps(value);
      if (n !== null) return n < 0 ? `-${ARB[prop]}-${-n}` : `${ARB[prop]}-${n}`;
    }
    if (value === "0" || value === "0px" || value === "0rem") return `${ARB[prop]}-0`; // bare/unitless zero
    return `${ARB[prop]}-[${arb(value)}]`;
  }
  if (/^border-(top|right|bottom|left)-width$/.test(prop)) {
    const side = prop.split("-")[1]![0]!; // t/r/b/l
    const px = /^(\d*\.?\d+)px$/.exec(value);
    if (px) { const n = +px[1]!; if (n === 1) return `border-${side}`; if (n === 0) return `border-${side}-0`; if (n === 2 || n === 4 || n === 8) return `border-${side}-${n}`; }
    return `border-${side}-[${arb(value)}]`;
  }
  // Grid line placement → named spans. `1 / -1` is the full track (`col-span-full`/`row-span-full`);
  // a plain integer start/end is `col-start-N`/`row-end-N`. Replaces `[grid-column-start:1]` longhand.
  if (prop === "grid-column-start" || prop === "grid-row-start") {
    const ax = prop[5] === "c" ? "col" : "row";
    const span = /^span\s+(.+)$/.exec(value);
    if (span) return `${ax}-start-[span_${arbList(span[1]!)}]`;
    return /^\d+$/.test(value) ? `${ax}-start-${value}` : `[${prop}:${arb(value)}]`;
  }
  if (prop === "grid-column-end" || prop === "grid-row-end") {
    const ax = prop[5] === "c" ? "col" : "row";
    const span = /^span\s+(.+)$/.exec(value);
    if (span) return `${ax}-end-[span_${arbList(span[1]!)}]`;
    if (value === "-1") return `${ax}-end-[-1]`;
    return /^\d+$/.test(value) ? `${ax}-end-${value}` : `[${prop}:${arb(value)}]`;
  }
  if (prop === "background-image") return `bg-[${arb(value)}]`;
  if (prop === "box-shadow") return `shadow-[${arbList(value)}]`;
  // Everything else → the arbitrary-property escape: exact by construction.
  return `[${prop}:${arb(value)}]`;
}

/** Responsive variant prefix for a band's media query. For the standard capture ladder
 *  (375/768/1280/1920, canonical 1280) the per-viewport bands are the midpoints 571/1024/1600,
 *  which we map to the CONVENTIONAL Tailwind breakpoints a human would author — `max-md:`
 *  (mobile, <768), `md:max-lg:` (tablet, 768–1023), `2xl:` (wide, ≥1536) — leaving 1280 as the
 *  unprefixed base. Each reproduces the captured width EXACTLY (the style gate measures only at
 *  375/768/1280/1920), while between-width behaviour follows the standard breakpoints instead of
 *  arbitrary midpoint pixels. Non-standard viewport sets fall back to the exact arbitrary band. */
function prefixFor(media: string): string {
  const min = /min-width:\s*(\d+)px/.exec(media);
  const max = /max-width:\s*(\d+)px/.exec(media);
  const lo = min ? +min[1]! : 0;
  const hi = max ? +max[1]! : Infinity;
  if (!min && hi === 571) return "max-md:";            // 375 sample → below md (768)
  if (lo === 572 && hi === 1024) return "md:max-lg:";  // 768 sample → md … below lg (1024)
  if (lo === 1601 && !max) return "2xl:";              // 1920 sample → at/above 2xl (1536)
  let p = "";
  if (min) p += `min-[${lo}px]:`;
  if (max) p += `max-[${hi}px]:`;
  return p;
}

function fmtRule(sel: string, decls: Map<string, string>): string {
  return `${sel}{${[...decls].map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

// ---- shorthand collapse (readability; fidelity-identical) ----
// Collapse redundant longhand utilities to shorthand WITHIN each responsive band when all
// members carry equal values. Tailwind shorthand expands to the same per-side declarations,
// so the computed style is unchanged — but the class string is far shorter/cleaner:
//   pt/pr/pb/pl-[16px] → p-[16px]   ·   pl+pr equal → px-…   ·   pt+pb equal → py-…
//   top/right/bottom/left-[0px] → inset-[0px]   ·   4 corners equal → rounded-[…]
//   gap-x == gap-y → gap-[…]   ·   overflow-x/y-<kw> → overflow-<kw>
// A leading run of responsive variant tokens: standard breakpoints (`md:`, `max-lg:`,
// `2xl:`, stacked `md:max-lg:`) OR the legacy arbitrary bands (`max-[571px]:`). Captured so
// collapse + prettify operate on the bare base and re-attach the prefix unchanged.
const VARIANT_PREFIX = /^((?:(?:max-)?(?:sm|md|lg|xl|2xl):|m(?:in|ax)-\[\d+px\]:|(?:group-|peer-)?(?:hover|focus|focus-visible|focus-within|active|disabled|visited|checked):)*)([\s\S]*)$/;
const QUADS: Array<{ sides: [string, string, string, string]; all: string; x: string; y: string }> = [
  { sides: ["pt", "pr", "pb", "pl"], all: "p", x: "px", y: "py" },
  { sides: ["mt", "mr", "mb", "ml"], all: "m", x: "mx", y: "my" },
  { sides: ["top", "right", "bottom", "left"], all: "inset", x: "inset-x", y: "inset-y" },
  { sides: ["rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"], all: "rounded", x: "", y: "" },
];
// Heads we fold to shorthand, LONGEST first so `gap-x` matches before `gap`, `rounded-tl`
// before any short head. A side base is `[-]<head>-<suffix>` where suffix is a named scale
// step (`4`, `1.5`, `0`, `px`, `auto`), a fraction (`1/2`), or an arbitrary `[…]`. Folding on
// the suffix (not just the arbitrary inner) means NAMED forms collapse too — `pt-4 pb-4`→`py-4`,
// `top-0 right-0 bottom-0 left-0`→`inset-0` — which declToUtil emits directly for spacing-scale
// props and the old arbitrary-only collapse missed.
const COLLAPSE_HEADS = [
  "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl", "gap-x", "gap-y", "gap",
  "pt", "pr", "pb", "pl", "mt", "mr", "mb", "ml", "top", "right", "bottom", "left",
];
type SidePart = { neg: boolean; head: string; suf: string };
function parseSide(b: string): SidePart | null {
  const neg = b.startsWith("-");
  const body = neg ? b.slice(1) : b;
  for (const h of COLLAPSE_HEADS) if (body.startsWith(h + "-")) return { neg, head: h, suf: body.slice(h.length + 1) };
  return null;
}
function collapseBases(bases: string[]): string[] {
  const byHead = new Map<string, SidePart>(); // head → its parsed part (sides are unique within a group)
  for (const b of bases) { const p = parseSide(b); if (p) byHead.set(p.head, p); }
  const origOf = new Map<string, string>(); // head → original base string (to drop/replace by identity)
  for (const b of bases) { const p = parseSide(b); if (p) origOf.set(p.head, b); }
  const replace = new Map<string, string>(); // first member's original base → shorthand
  const drop = new Set<string>();
  const sig = (h: string): string | null => { const p = byHead.get(h); return p ? (p.neg ? "-" : "+") + p.suf : null; };
  const eqv = (...heads: string[]): boolean => { const s0 = sig(heads[0]!); return s0 != null && heads.every((h) => sig(h) === s0); };
  const render = (short: string, fromHead: string): string => { const p = byHead.get(fromHead)!; return `${p.neg ? "-" : ""}${short}-${p.suf}`; };
  const fold = (sides: string[], short: string): boolean => {
    if (!short || !eqv(...sides)) return false;
    sides.forEach((s, i) => { const b = origOf.get(s)!; if (i === 0) replace.set(b, render(short, s)); else drop.add(b); });
    return true;
  };
  for (const q of QUADS) {
    if (fold(q.sides, q.all)) continue;            // all four equal → one shorthand
    fold([q.sides[0], q.sides[2]], q.y);           // top + bottom → y-axis
    fold([q.sides[3], q.sides[1]], q.x);           // left + right → x-axis
  }
  // row/column gap fully define `gap` — a standalone `gap` alongside both axes is redundant; drop
  // it, then fold equal axes to one `gap`. (getComputedStyle reports gap + row-gap + column-gap.)
  if (byHead.has("gap-x") && byHead.has("gap-y")) {
    if (byHead.has("gap")) drop.add(origOf.get("gap")!);
    if (eqv("gap-x", "gap-y")) { replace.set(origOf.get("gap-x")!, render("gap", "gap-x")); drop.add(origOf.get("gap-y")!); }
  }
  for (const s of ["clip", "hidden", "auto", "scroll", "visible"]) {
    if (bases.includes(`overflow-x-${s}`) && bases.includes(`overflow-y-${s}`)) {
      replace.set(`overflow-x-${s}`, `overflow-${s}`); drop.add(`overflow-y-${s}`);
    }
  }
  // grid line placement: a `1 / -1` start+end pair spans the whole track → `<axis>-span-full`.
  for (const ax of ["col", "row"]) {
    if (bases.includes(`${ax}-start-1`) && bases.includes(`${ax}-end-[-1]`)) {
      replace.set(`${ax}-start-1`, `${ax}-span-full`); drop.add(`${ax}-end-[-1]`);
    }
  }
  // 4 equal per-side borders → the un-sided form. css.ts collapses uniform borders at base, but
  // interaction/band deltas reach here as four sided utilities (`border-b-clr-20`×4 → `border-clr-20`).
  // Width suffix is numeric/px/empty; color suffix is a token name or non-px bracket — classified apart
  // since a side can carry BOTH a width and a color util.
  const bwSuf = new Map<string, string>(), bcSuf = new Map<string, string>();
  for (const b of bases) {
    const m = /^border-([trbl])(?:-(.+))?$/.exec(b);
    if (!m) continue;
    const side = m[1]!, suf = m[2];
    if (suf === undefined || suf === "0" || /^\d+$/.test(suf) || /^\[-?[\d.]+px\]$/.test(suf)) bwSuf.set(side, suf ?? "");
    else bcSuf.set(side, suf);
  }
  const allEqSide = (map: Map<string, string>): string | null => {
    if (!["t", "r", "b", "l"].every((s) => map.has(s))) return null;
    const v0 = map.get("t")!; return ["r", "b", "l"].every((s) => map.get(s) === v0) ? v0 : null;
  };
  const wv = allEqSide(bwSuf);
  if (wv !== null) { const sfx = wv ? `-${wv}` : ""; replace.set(`border-t${sfx}`, `border${sfx}`); for (const s of ["r", "b", "l"]) drop.add(`border-${s}${sfx}`); }
  const cv = allEqSide(bcSuf);
  if (cv !== null) { replace.set(`border-t-${cv}`, `border-${cv}`); for (const s of ["r", "b", "l"]) drop.add(`border-${s}-${cv}`); }
  const out: string[] = [];
  for (const b of bases) { if (drop.has(b)) continue; out.push(replace.get(b) ?? b); }
  return out;
}

// Zero insets (`top-0 right-0 bottom-0 left-0`, `inset-0`) only do anything on an out-of-flow box
// (absolute/fixed) or a sticky one. On a `relative` or `static` element a 0 offset is a no-op — the
// browser reports `top:0px` as the resolved value of `auto`, which we faithfully but pointlessly bake.
// Drop those zero insets when the node is never absolutely/fixed/sticky-positioned (any band). Non-zero
// relative offsets and all positioned insets are untouched. Render-identical; kills a pure-noise tell.
function dropNoopInsets(utils: string[]): string[] {
  const positioned = utils.some((u) => /(?:^|:)(?:absolute|fixed|sticky)$/.test(u));
  if (positioned) return utils;
  return utils.filter((u) => !/(?:^|:)(?:inset-x|inset-y|inset|top|right|bottom|left)-0$/.test(u));
}
// ---- scale / unit prettify (readability; fidelity-identical at a 16px root) ----
// A px arbitrary value carries no design meaning — it's the browser's *measurement*.
// Rewrite it to the idiomatic Tailwind a human would have authored: a named scale step
// when the value lands on one (gap-[8px]→gap-2, w-[40px]→w-10, rounded-[6px]→rounded-md,
// leading-[20px]→leading-5), else a clean rem (max-w-[600px]→max-w-[37.5rem]), else leave
// the px (a genuine one-off). Spacing/sizing resolve via --spacing (0.25rem = 4px) and rem
// against the 16px root, so every rewrite computes to the IDENTICAL px at the captured
// widths — fidelity-neutral by construction (guarded to 16px roots by the caller). Only
// length-scale prefixes are touched; colors/shadows/gradients/arbitrary-properties pass through.
const NAMED_K = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]);
const SCALE_PREFIXES = new Set([
  "p", "px", "py", "pt", "pr", "pb", "pl", "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap", "gap-x", "gap-y", "w", "h", "min-w", "max-w", "min-h", "max-h",
  "inset", "inset-x", "inset-y", "top", "right", "bottom", "left", "leading",
]);
// Tailwind v4 radius scale (verified against the harness theme.css): xs .125rem(2px),
// sm .25rem(4px), md .375rem(6px), lg .5rem(8px), xl .75rem(12px), 2xl 1rem(16px),
// 3xl 1.5rem(24px), 4xl 2rem(32px). (v4 shifted every name up one vs v3 — no bare `rounded`.)
const RADIUS_SUFFIX: Record<number, string> = { 2: "-xs", 4: "-sm", 6: "-md", 8: "-lg", 12: "-xl", 16: "-2xl", 24: "-3xl", 32: "-4xl" };
// Tailwind width/height/basis/inset fractions, as [percent, suffix]. A captured % within 0.4 of
// one of these maps to the named fraction (33.3333% → 1/3) — sub-pixel-equal, gate-neutral.
const FRACTIONS: Array<[number, string]> = [
  [0, "0"], [100, "full"], [50, "1/2"], [33.333, "1/3"], [66.667, "2/3"], [25, "1/4"], [75, "3/4"],
  [20, "1/5"], [40, "2/5"], [60, "3/5"], [80, "4/5"], [16.667, "1/6"], [83.333, "5/6"],
];
/** A px length → its clean rem string (px/16), or null when not clean (>4 fractional digits). */
function pxToRem(n: number): string | null {
  const s = (Math.round((n / 16) * 100000) / 100000).toString();
  const dot = s.indexOf(".");
  if (dot >= 0 && s.length - dot - 1 > 4) return null;
  return s + "rem";
}
/** Rewrite ONE collapsed base utility to the standard scale / rem when it is a px length on
 *  a known scale; unchanged otherwise (so non-length utilities and odd one-offs are safe). */
export function prettifyBase(base: string): string {
  // A saturating corner radius — a huge px or scientific notation (`3.35544e+07px`, the browser's
  // resolved value for a pill `border-radius:9999px`) — IS `rounded-full`. Caught before the strict
  // numeric regex below, which doesn't match an `e+`-exponent.
  const rf = /^(rounded(?:-(?:tl|tr|br|bl|t|r|b|l|s|e|ss|se|ee|es))?)-\[(-?[\d.eE+]+)px\]$/.exec(base);
  if (rf && parseFloat(rf[2]!) >= 1000) return `${rf[1]}-full`;
  const aspect = /^aspect-\[(\d+(?:\.\d+)?)_?\/_?(\d+(?:\.\d+)?)\]$/.exec(base);
  if (aspect) {
    const w = parseFloat(aspect[1]!);
    const h = parseFloat(aspect[2]!);
    const ratio = h ? w / h : 0;
    if (Math.abs(ratio - 1) < 1e-6) return "aspect-square";
    if (Math.abs(ratio - (16 / 9)) < 1e-6) return "aspect-video";
    if (Number.isInteger(w) && Number.isInteger(h)) {
      const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
      const d = gcd(w, h);
      const sw = w / d, sh = h / d;
      if (Math.max(sw, sh) <= 24) return `aspect-[${sw}/${sh}]`;
    }
  }
  // repeat(N, minmax(0,1fr)) IS Tailwind's grid-cols-N / grid-rows-N — emit the clean class.
  const gm = /^grid-(cols|rows)-\[repeat\((\d+),_minmax\(0(?:px)?,_1fr\)\)\]$/.exec(base);
  if (gm) return `grid-${gm[1]}-${gm[2]}`;
  if (base === "grow-[1]") return "grow";
  if (base === "grow-[0]") return "grow-0";
  if (base === "shrink-[1]") return "shrink";
  if (base === "shrink-[0]") return "shrink-0";
  // percentage → named fraction (w-[100%]→w-full, w-[50%]→w-1/2, basis-[33.3333%]→basis-1/3).
  const pm = /^(w|h|min-w|min-h|basis|inset|inset-x|inset-y|top|right|bottom|left)-\[(\d*\.?\d+)%\]$/.exec(base);
  if (pm) {
    const v = parseFloat(pm[2]!);
    const frac = FRACTIONS.find(([p]) => Math.abs(p - v) < 0.4);
    return frac ? `${pm[1]}-${frac[1]}` : base;
  }
  const m = /^([a-z][a-z-]*)-\[(-?\d*\.?\d+)px\]$/.exec(base);
  if (!m) return base;
  const prefix = m[1]!;
  const n = parseFloat(m[2]!);
  const neg = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (prefix === "rounded" || /^rounded-(tl|tr|br|bl|t|r|b|l|s|e|ss|se|ee|es)$/.test(prefix)) {
    // Named buckets are the EXACT v4 values, so they match the source px. A "pill" radius
    // (≥1000px, conventionally 9999px) fully rounds the corner — identical render to Tailwind's
    // `rounded-full` (which compiles to a saturating 3.4e38px); the style gate treats the two
    // large radii as equivalent, so emit the idiomatic class. Off-scale small radii stay px.
    if (abs >= 1000) return `${prefix}-full`;
    if (abs in RADIUS_SUFFIX) return `${prefix}${RADIUS_SUFFIX[abs]}`;
    return base;
  }
  // font-size: convert px→rem but keep arbitrary — named text-* also sets a default
  // line-height, which would override an inherited one where we emit no explicit leading.
  if (prefix === "text") { const rem = pxToRem(abs); return rem ? `text-[${rem}]` : base; }
  if (SCALE_PREFIXES.has(prefix)) {
    if (abs === 0) return `${neg}${prefix}-0`;
    if (abs === 1) return `${neg}${prefix}-px`;
    const k = abs / 4;
    if (NAMED_K.has(k)) return `${neg}${prefix}-${k}`;
    const rem = pxToRem(abs);
    return rem ? `${neg}${prefix}-[${rem}]` : base;
  }
  return base;
}

// Tailwind v4 named font sizes (rem → class). A frozen `text-[1.125rem]` is the browser's measured
// size; the named `text-lg` is what a human writes. Each named size ALSO sets a default line-height,
// so mapping is only safe when the node carries an explicit `leading-*` (overriding that default) at
// the same breakpoint — otherwise the named size would impose a line-height where we inherited one.
const NAMED_TEXT: Record<string, string> = {
  "0.75rem": "text-xs", "0.875rem": "text-sm", "1rem": "text-base", "1.125rem": "text-lg",
  "1.25rem": "text-xl", "1.5rem": "text-2xl", "1.875rem": "text-3xl", "2.25rem": "text-4xl",
  "3rem": "text-5xl", "3.75rem": "text-6xl", "4.5rem": "text-7xl", "6rem": "text-8xl", "8rem": "text-9xl",
};
function namedText(base: string): string | null {
  const m = /^text-\[(-?\d*\.?\d+)(px|rem)\]$/.exec(base);
  if (!m) return null;
  const px = parseFloat(m[1]!) * (m[2] === "rem" ? 16 : 1);
  return NAMED_TEXT[(Math.round((px / 16) * 100000) / 100000) + "rem"] ?? null;
}
// ---- scale snapping (within the fidelity gate's tolerance) ----
// prettifyBase only rewrites values that are EXACTLY a scale step. But the gate accepts ±4px on
// padding/gap, ±2px on type/radius, and ~6% on box geometry — the same slack a human spends writing
// `pt-3.5` for a measured 14.06px instead of `pt-[14.0625px]`. Snap a baked sub-pixel value to the
// nearest scale step / integer px when comfortably INSIDE that budget (ε well under the gate tol), so
// the markup reads hand-authored. Bounded ε + the layout & perceptual gates backstop any accumulation;
// values not near a step stay arbitrary because they are genuine one-offs.
const SNAP_SPACE_PX = 1.0; // padding/margin/gap/inset/size → nearest 0.25rem scale step within this
const SNAP_TYPE_PX = 0.6;  // font-size/line-height/radius → nearest integer px within this
const NAMED_K_SORTED = [...NAMED_K].sort((a, b) => a - b);
function nearestNamedK(k: number): number {
  let best = NAMED_K_SORTED[0]!;
  for (const c of NAMED_K_SORTED) if (Math.abs(c - k) < Math.abs(best - k)) best = c;
  return best;
}
function snapBase(base: string): string {
  const m = /^(-?)([a-z][a-z-]*)-\[(-?\d*\.?\d+)(px|rem)\]$/.exec(base);
  if (!m) return base;
  const neg = m[1]!, prefix = m[2]!, px = parseFloat(m[3]!) * (m[4] === "rem" ? 16 : 1);
  // type metrics → integer px (kills the sub-pixel "frozen measurement" without a visible change)
  if (prefix === "text" || prefix === "leading") {
    const r = Math.round(px);
    if (r !== px && Math.abs(r - px) <= SNAP_TYPE_PX) { const rem = pxToRem(r); return `${neg}${prefix}-[${rem ?? r + "px"}]`; }
    return base;
  }
  if (prefix === "tracking") { const r = Math.round(px * 100) / 100; return r !== px ? `${neg}tracking-[${r}px]` : base; }
  if (prefix === "rounded" || /^rounded-(tl|tr|br|bl|t|r|b|l|s|e|ss|se|ee|es)$/.test(prefix)) {
    const r = Math.round(px);
    if (Math.abs(r - px) <= SNAP_TYPE_PX && r in RADIUS_SUFFIX) return `${prefix}${RADIUS_SUFFIX[r]}`;
    return base;
  }
  // spacing / size → nearest named scale step (0.25rem grid)
  if (SCALE_PREFIXES.has(prefix)) {
    const k = nearestNamedK(px / 4);
    if (Math.abs(k * 4 - px) <= SNAP_SPACE_PX) return k === 0 ? `${neg}${prefix}-0` : `${neg}${prefix}-${k}`;
  }
  return base;
}
function collapseUtils(utils: string[]): string[] {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const u of utils) {
    const m = VARIANT_PREFIX.exec(u)!;
    const prefix = m[1]!;
    if (!groups.has(prefix)) { groups.set(prefix, []); order.push(prefix); }
    groups.get(prefix)!.push(m[2]!);
  }
  const out: string[] = [];
  for (const p of order) {
    const pretty = collapseBases(groups.get(p)!).map(prettifyBase);
    // Map font-size → named scale only when this band also sets line-height (so the named size's
    // implicit default can't change the rendered leading).
    const hasLeading = pretty.some((b) => b.startsWith("leading-") || b.startsWith("[line-height"));
    for (const b of pretty) { const s = snapBase(b); out.push(p + (hasLeading ? namedText(s) ?? s : s)); }
  }
  return dedupeUtils(out);
}

function dedupeUtils(utils: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of utils) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// Drop a responsive/state band whose value now EQUALS the base utility — a no-op override. Snapping
// to the scale can collapse two distinct per-viewport measurements onto the same value (`tracking
// -[0.0781px]`@mobile + `[0.08px]`@base → both `[0.08px]`), leaving a redundant `max-lg:tracking
// -[0.08px]` next to the base. Only EXACT base-string matches are removed (conservative).
function dropRedundantBands(utils: string[]): string[] {
  const baseBases = new Set<string>();
  for (const u of utils) { const m = VARIANT_PREFIX.exec(u)!; if (m[1] === "") baseBases.add(m[2]!); }
  if (!baseBases.size) return utils;
  return utils.filter((u) => { const m = VARIANT_PREFIX.exec(u)!; return m[1] === "" || !baseBases.has(m[2]!); });
}

/** Coalesce a delta carried IDENTICALLY by both the mobile (`max-md:`) and tablet
 *  (`md:max-lg:`) bands into a single `max-lg:` — exactly the simplification a human makes
 *  ("this differs below lg"). Fidelity-neutral: `max-lg:` selects the same 375 + 768 samples
 *  that the two bands did, with the same value. Only fires when the post-prefix base matches. */
function mergeBands(utils: string[]): string[] {
  const prefixes = new Map<string, Set<string>>(); // base → variant prefixes present
  for (const u of utils) {
    const m = VARIANT_PREFIX.exec(u)!;
    if (!prefixes.has(m[2]!)) prefixes.set(m[2]!, new Set());
    prefixes.get(m[2]!)!.add(m[1]!);
  }
  const mergeable = new Set<string>(); // bases that have BOTH max-md: and md:max-lg:
  for (const [base, pres] of prefixes) if (pres.has("max-md:") && pres.has("md:max-lg:")) mergeable.add(base);
  if (!mergeable.size) return utils;
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const u of utils) {
    const m = VARIANT_PREFIX.exec(u)!;
    const base = m[2]!, pre = m[1]!;
    if (mergeable.has(base) && (pre === "max-md:" || pre === "md:max-lg:")) {
      const merged = "max-lg:" + base;
      if (!emitted.has(merged)) { out.push(merged); emitted.add(merged); }
      continue;
    }
    out.push(u);
  }
  return out;
}

// ---- source-authored intent recovery ------------------------------------
// For Tailwind-built sources the live DOM class string often carries the author's fluid law
// (`grid-rows-[auto_1fr]`, `grid-rows-1`, `w-full`, `line-clamp-5`) while computed styles only
// expose the resolved px result. Use those source utilities as candidates on a narrow allowlist,
// then still emit them through this generator's breakpoint bands so we do not copy the source
// class string wholesale or depend on its custom breakpoints/design-system classes.
type SourceAxis =
  "grid-cols" | "grid-rows" | "line-clamp" | "aspect" |
  "w" | "max-w" | "h" | "max-h";

type SourceTok = { variant: string; core: string };
type SourceIntent = { axes: Set<SourceAxis>; utilities: string[]; css: string[] };

const SOURCE_REPLACED = new Set(["img", "svg", "video", "canvas", "picture", "iframe", "input", "textarea", "select", "hr", "object", "embed"]);

function parseSourceClass(cls: string | undefined): SourceTok[] {
  if (!cls) return [];
  const out: SourceTok[] = [];
  for (const raw of cls.split(/\s+/).filter(Boolean)) {
    let depth = 0, lastColon = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === ":" && depth === 0) lastColon = i;
    }
    out.push({ variant: lastColon >= 0 ? raw.slice(0, lastColon) : "", core: lastColon >= 0 ? raw.slice(lastColon + 1) : raw });
  }
  return out;
}

const SOURCE_BP: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };
function sourceVariantActive(variant: string, vp: number): boolean {
  if (!variant) return true;
  for (const part of variant.split(":").filter(Boolean)) {
    const minArb = /^min-\[(\d+)px\]$/.exec(part);
    if (minArb) { if (vp < +minArb[1]!) return false; continue; }
    const maxArb = /^max-\[(\d+)px\]$/.exec(part);
    if (maxArb) { if (vp > +maxArb[1]!) return false; continue; }
    const maxNamed = /^max-(sm|md|lg|xl|2xl)$/.exec(part);
    if (maxNamed) { if (vp >= SOURCE_BP[maxNamed[1]!]!) return false; continue; }
    if (part in SOURCE_BP) { if (vp < SOURCE_BP[part]!) return false; continue; }
    // State, container, dark/group/peer, supports, or custom variants are not base layout intent.
    return false;
  }
  return true;
}

function sourceArbitraryInner(suffix: string): string | null {
  return suffix.startsWith("[") && suffix.endsWith("]") ? suffix.slice(1, -1) : null;
}

function sourceFluidLengthSuffix(suffix: string): boolean {
  if (/^(full|auto|screen|svh|lvh|dvh|svw|lvw|dvw|fit|min|max|prose)$/.test(suffix)) return true;
  if (/^(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)$/.test(suffix)) return true;
  if (/^\d+\/\d+$/.test(suffix)) return true;
  const inner = sourceArbitraryInner(suffix);
  if (!inner) return false;
  if (/^var\(/.test(inner)) return true;
  if (/^(calc|min|max|clamp|fit-content)\(/.test(inner)) return true;
  return /(%|vw|vh|svw|lvw|dvw|svh|lvh|dvh|fr|min-content|max-content|fit-content)/.test(inner);
}

function sourceAspectUtility(core: string): string | null {
  let m = /^aspect-(\d+)\/(\d+)-box$/.exec(core);
  if (m) return m[1] === m[2] ? "aspect-square" : `aspect-[${m[1]}/${m[2]}]`;
  m = /^aspect-(\d+)\/(\d+)$/.exec(core);
  if (m) return m[1] === m[2] ? "aspect-square" : `aspect-[${m[1]}/${m[2]}]`;
  if (/^aspect-(?:square|video|auto|\[[^\]]+\])$/.test(core)) return core;
  return null;
}

function sourceAxisForCore(core0: string): { axis: SourceAxis; utility: string } | null {
  const core = core0.startsWith("!") ? core0.slice(1) : core0;
  if (/^grid-cols-(?:\d+|none|subgrid|\[[^\]]+\])$/.test(core)) return { axis: "grid-cols", utility: core };
  const gridRows = /^grid-rows-(\d+|none|subgrid|\[[^\]]+\])$/.exec(core);
  if (gridRows) {
    const v = gridRows[1]!;
    const inner = sourceArbitraryInner(v);
    // Single-row `1fr` grids frequently encode media heights through surrounding constraints. The
    // live source can resolve them correctly, but the clone still lacks enough source CSS to derive
    // the same wide-breakpoint height, so leave numeric/single-row grids to the media/aspect pass.
    if (/^\d+$/.test(v)) return null;
    if (inner && (/^1fr$/.test(inner) || /^repeat\(1[,)]/.test(inner))) return null;
    return { axis: "grid-rows", utility: core };
  }
  if (/^line-clamp-(?:\d+|\[[^\]]+\]|none)$/.test(core)) return { axis: "line-clamp", utility: core };
  const aspect = sourceAspectUtility(core);
  if (aspect) return { axis: "aspect", utility: aspect };
  const maxW = /^max-w-(.+)$/.exec(core);
  if (maxW && sourceFluidLengthSuffix(maxW[1]!)) return { axis: "max-w", utility: core };
  const maxH = /^max-h-(.+)$/.exec(core);
  if (maxH && sourceFluidLengthSuffix(maxH[1]!)) return { axis: "max-h", utility: core };
  const size = /^([wh])-(.+)$/.exec(core);
  if (size && sourceFluidLengthSuffix(size[2]!)) return { axis: size[1] as SourceAxis, utility: core };
  return null;
}

function generatedAxisForCore(core0: string): SourceAxis | null {
  const core = core0.startsWith("!") ? core0.slice(1) : core0;
  if (core.startsWith("grid-cols-") || core.startsWith("[grid-template-columns:")) return "grid-cols";
  if (core.startsWith("grid-rows-") || core.startsWith("[grid-template-rows:")) return "grid-rows";
  if (core.startsWith("line-clamp-") || core.startsWith("[-webkit-line-clamp:")) return "line-clamp";
  if (core.startsWith("aspect-") || core.startsWith("[aspect-ratio:")) return "aspect";
  if (core.startsWith("max-w-")) return "max-w";
  if (core.startsWith("max-h-")) return "max-h";
  const size = /^([wh])-(.+)$/.exec(core);
  if (size) return size[1] as SourceAxis;
  return null;
}

function sourceVarName(util: string): string | null {
  const m = /^(?:[wh]|max-[wh])-\[var\((--[\w-]+)\)\]$/.exec(util);
  return m ? m[1]! : null;
}

function sourceRatioOf(util: string): number | null {
  if (util === "aspect-square") return 1;
  if (util === "aspect-video") return 16 / 9;
  const m = /^aspect-\[(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]$/.exec(util);
  return m ? +m[1]! / +m[2]! : null;
}

function gridTrackCount(value: string | undefined): number | null {
  if (!value || value === "none") return null;
  if (/^subgrid\b/.test(value)) return null;
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function computedAspectRatio(value: string | undefined): number | null {
  if (!value || value === "auto") return null;
  const m = /(?:^|\s)(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s|$)/.exec(value);
  return m ? +m[1]! / +m[2]! : null;
}

function percentWidth(util: string): number | null {
  const m = /^w-\[(\d+(?:\.\d+)?)%\]$/.exec(util);
  return m ? +m[1]! / 100 : null;
}

function fillsParentHeight(node: IRNode, parent: IRNode | undefined, viewports: number[]): boolean {
  if (!parent) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const pcs = parent.computedByVp[vp]; const pb = parent.bboxByVp[vp];
    if (!cs || !nb || !pcs || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    if ((pcs.display || "") === "contents") return false;
    let target = pb.height - pf(pcs.borderTopWidth) - pf(pcs.borderBottomWidth);
    if (!(target > 0)) return false;
    if (cs.maxHeight && cs.maxHeight !== "none") target = Math.min(target, pf(cs.maxHeight));
    if (Math.abs(nb.height - target) > Math.max(1.5, 0.01 * target)) return false;
    painted++;
  }
  return painted >= 1;
}

function sourcePercentWidthCompatible(node: IRNode, parent: IRNode | undefined, values: Map<number, string>, viewports: number[]): boolean {
  if (!parent) return false;
  let painted = 0;
  for (const vp of viewports) {
    const cs = node.computedByVp[vp]; const nb = node.bboxByVp[vp];
    const pcs = parent.computedByVp[vp]; const pb = parent.bboxByVp[vp];
    if (!cs || !nb || !pcs || !pb || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
    const pct = percentWidth(values.get(vp) || "");
    if (!pct) return false;
    const parentContent = pb.width - pf(pcs.paddingLeft) - pf(pcs.paddingRight) - pf(pcs.borderLeftWidth) - pf(pcs.borderRightWidth);
    if (!(parentContent > 0)) return false;
    let target = parentContent * pct;
    if (cs.maxWidth && cs.maxWidth !== "none") target = Math.min(target, pf(cs.maxWidth));
    if (Math.abs(nb.width - target) > Math.max(1.5, 0.01 * target)) return false;
    painted++;
  }
  return painted >= 1;
}

function replacedHeightAutoCompatible(node: IRNode, values: Map<number, string>, viewports: number[]): boolean {
  if (!SOURCE_REPLACED.has(node.tag)) return false;
  let painted = 0;
  for (const vp of viewports) {
    if (values.get(vp) !== "h-auto") return false;
    if (!node.visibleByVp[vp] || node.computedByVp[vp]?.display === "none") continue;
    const b = node.bboxByVp[vp]; const ratio = computedAspectRatio(node.computedByVp[vp]?.aspectRatio);
    if (!b || !ratio || b.width <= 0 || b.height <= 0) return false;
    if (Math.abs((b.width / b.height) - ratio) > 0.02) return false;
    painted++;
  }
  return painted >= 1;
}

function sourceAxisCompatible(node: IRNode, parent: IRNode | undefined, axis: SourceAxis, values: Map<number, string>, viewports: number[]): boolean {
  if (axis === "grid-cols" || axis === "grid-rows") {
    let painted = 0;
    for (const vp of viewports) {
      const cs = node.computedByVp[vp];
      if (!cs || !node.visibleByVp[vp] || (cs.display || "") === "none") continue;
      if (!/^(grid|inline-grid)$/.test(cs.display || "")) return false;
      if (axis === "grid-rows") {
        const v = values.get(vp) || "";
        const numeric = /^grid-rows-(\d+)$/.exec(v);
        if (numeric) {
          if (gridTrackCount(cs.gridTemplateRows) !== +numeric[1]!) return false;
          // Numeric single-row grids are only safe when the live browser already proved the node's
          // height is auto-derived under the authored source rule. Otherwise the px row may be the
          // only thing carrying media/aspect height in the clone.
          if (!node.sizingByVp?.[vp]?.hAuto) return false;
        }
      }
      painted++;
    }
    return painted >= 1;
  }
  if (axis === "line-clamp") {
    return viewports.some((vp) => {
      const cs = node.computedByVp[vp];
      return cs && (cs.webkitLineClamp || "") !== "none" && values.get(vp) !== "line-clamp-none";
    });
  }
  if (axis === "aspect") {
    let painted = 0;
    for (const vp of viewports) {
      if (!node.visibleByVp[vp] || node.computedByVp[vp]?.display === "none") continue;
      const b = node.bboxByVp[vp];
      const ratio = sourceRatioOf(values.get(vp) || "");
      if (!b || !ratio || b.width <= 0 || b.height <= 0) return false;
      if (Math.abs((b.width / b.height) - ratio) > 0.02) return false;
      painted++;
    }
    return painted >= 1;
  }
  if (axis === "max-w") {
    return viewports.some((vp) => {
      const cs = node.computedByVp[vp];
      return cs && cs.maxWidth && cs.maxWidth !== "none" && values.has(vp);
    });
  }
  if (axis === "max-h") {
    return viewports.some((vp) => {
      const cs = node.computedByVp[vp];
      const v = values.get(vp);
      return cs && values.has(vp) && ((v === "max-h-none" && cs.maxHeight === "none") || (v !== "max-h-none" && cs.maxHeight && cs.maxHeight !== "none"));
    });
  }
  if (axis === "w" || axis === "h") {
    if (axis === "w" && [...values.values()].some((v) => percentWidth(v) !== null)) return sourcePercentWidthCompatible(node, parent, values, viewports);
    if (axis === "h" && [...values.values()].every((v) => v === "h-auto") && replacedHeightAutoCompatible(node, values, viewports)) return true;
    return viewports.every((vp) => {
      if (!node.visibleByVp[vp] || node.computedByVp[vp]?.display === "none") return true;
      const v = values.get(vp);
      const s = node.sizingByVp?.[vp];
      if (axis === "w" && v === "w-full") return !!s?.wFill;
      if (axis === "w" && v === "w-auto" && node.tag === "svg" && node.rawHTML) return true;
      if (axis === "w" && v === "w-auto") return !!s?.wAuto;
      if (axis === "h" && v === "h-full" && SOURCE_REPLACED.has(node.tag)) return fillsParentHeight(node, parent, viewports);
      if (axis === "h" && v === "h-full" && (node.computedByVp[vp]?.position === "absolute" || node.computedByVp[vp]?.position === "fixed")) return fillsParentHeight(node, parent, viewports);
      if (axis === "h" && v === "h-full") return !!s?.hFill;
      if (axis === "h" && v === "h-auto") return !!s?.hAuto;
      if (axis === "h" && v && sourceVarName(v)) return /px$/.test(node.computedByVp[vp]?.height || "");
      return false;
    });
  }
  // Other source utilities need stronger proof passes. Leave them on computed replay for now so the
  // first source-intent layer cannot change sizing without probe evidence.
  return false;
}

function sourceIntentVarCss(node: IRNode, axis: SourceAxis, values: Map<number, string>, viewports: number[], canonical: number): string[] {
  if (axis !== "h" && axis !== "w" && axis !== "max-h") return [];
  const name = [...values.values()].map(sourceVarName).find(Boolean);
  if (!name) return [];
  const prop = axis === "h" ? "height" : axis === "w" ? "width" : "maxHeight";
  const firstVp = viewports.find((vp) => sourceVarName(values.get(vp) || "") === name && /px$/.test(node.computedByVp[vp]?.[prop] || ""));
  if (firstVp === undefined) return [];
  const base = node.computedByVp[firstVp]?.[prop];
  if (!base || !/px$/.test(base)) return [];
  const out = [`:root{${name}:${base}}`];
  for (const b of computeBands(viewports, canonical)) {
    if (!b.media) continue;
    const v = node.computedByVp[b.vp]?.[prop];
    if (sourceVarName(values.get(b.vp) || "") === name && v && v !== base && /px$/.test(v)) out.push(`${b.media} {\n:root{${name}:${v}}\n}`);
  }
  return out;
}

function sourceIntentUtilities(node: IRNode, parent: IRNode | undefined, viewports: number[], canonical: number): SourceIntent {
  const perAxis = new Map<SourceAxis, Map<number, string>>();
  for (const tok of parseSourceClass(node.srcClass)) {
    const parsed = sourceAxisForCore(tok.core);
    if (!parsed) continue;
    for (const vp of viewports) {
      if (!sourceVariantActive(tok.variant, vp)) continue;
      let m = perAxis.get(parsed.axis);
      if (!m) { m = new Map<number, string>(); perAxis.set(parsed.axis, m); }
      m.set(vp, parsed.utility);
    }
  }
  const axes = new Set<SourceAxis>();
  const utilities: string[] = [];
  const css: string[] = [];
  const bands = computeBands(viewports, canonical);
  for (const [axis, byVp] of perAxis) {
    if (!viewports.every((vp) => byVp.has(vp))) continue; // avoid partial custom-class inference for now
    if (!sourceAxisCompatible(node, parent, axis, byVp, viewports)) continue;
    const base = byVp.get(canonical)!;
    axes.add(axis);
    if (axis === "aspect") axes.add("grid-rows");
    utilities.push(base);
    for (const b of bands) {
      if (!b.media) continue;
      const v = byVp.get(b.vp)!;
      if (v !== base) utilities.push(prefixFor(b.media) + v);
    }
    css.push(...sourceIntentVarCss(node, axis, byVp, viewports, canonical));
  }
  return { axes, utilities, css };
}

function dropGeneratedAxes(utils: string[], axes: Set<SourceAxis>): string[] {
  if (!axes.size) return utils;
  return utils.filter((u) => {
    const m = VARIANT_PREFIX.exec(u)!;
    if (axes.has("aspect") && /(?:^|:)after:(?:w|h|pt)-/.test(u)) return false;
    const axis = generatedAxisForCore(m[2]!);
    return !axis || !axes.has(axis);
  });
}

export type TailwindOutput = {
  classOf: Map<string, string>; // cid → utility class string
  styleOf: Map<string, Map<string, string>>; // cid → inline style (base-only raw values: gradients/url)
  pseudoCss: string;            // pseudo-element rules ([data-cid]::before/after) + @keyframes
  colorTokens: string[];        // color token names referenced (for @theme bindings)
  colorDefsCss: string;         // :root definitions for minted (non-palette) color tokens
  stats: { nodes: number; utilities: number };
};

/** Stateful color tokenizer. Shared across buildTailwind calls in multi-route generation
 *  so the same color mints ONE site-wide `--clr-N` token (one @theme, no cross-route
 *  collisions); single-page passes none and each build gets a fresh one. */
export type ColorInterner = {
  defs: Map<string, string>;    // minted token name → literal value
  byValue: Map<string, string>; // literal value → minted token name
  tokens: Set<string>;          // ALL referenced color token names (palette + minted)
  seq: { n: number };           // monotonic counter for clr-N names
};
export function createColorInterner(): ColorInterner {
  return { defs: new Map(), byValue: new Map(), tokens: new Set(), seq: { n: 0 } };
}
/** `:root { --clr-N: <literal>; … }` for the interner's minted tokens (empty if none). */
export function colorDefsCssOf(it: ColorInterner): string {
  return it.defs.size ? `:root {\n${[...it.defs].map(([n, v]) => `  --${n}: ${v};`).join("\n")}\n}\n` : "";
}

function kebabProp(p: string): string {
  if (p.startsWith("webkit")) return "-webkit-" + kebabProp(p[6]!.toLowerCase() + p.slice(7));
  return p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/** Stage 4 hover/focus deltas, expressed as Tailwind VARIANT utilities (`hover:bg-[…]`,
 *  `focus:text-…`, `group-hover:…` for parent-hover reveals) folded into each node's className —
 *  what a developer writes — instead of `[data-cid]:hover {…}` rules in ditto.css (which forced the
 *  per-node data-cid to ship). The captured `transition` (easing) is dropped: it isn't graded and
 *  the validator screenshots with animations off, so only the end state matters and it's reproduced
 *  by the variant utility. Returns per-cid utilities + the parent cids that need a `group` marker. */
function interactionUtilities(
  ir: IR,
  interaction: InteractionCapture | undefined,
  toUtil: (prop: string, value: string) => string,
): { byCid: Map<string, string[]>; groups: Set<string> } {
  const byCid = new Map<string, string[]>();
  const groups = new Set<string>();
  if (!interaction) return { byCid, groups };
  const capCid = new Map<string, string>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) capCid.set(cap, n.id);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  const add = (cid: string, util: string): void => { (byCid.get(cid) ?? byCid.set(cid, []).get(cid)!).push(util); };
  const utilsOf = (d: StyleDelta, variant: string): string[] =>
    Object.keys(d).sort().filter((p) => kebabProp(p) !== "transition")
      .map((p) => `${variant}:${toUtil(kebabProp(p), (d as Record<string, string>)[p]!)}`);
  const emit = (deltas: Record<string, StyleDelta>, variant: string): void => {
    for (const cap of Object.keys(deltas).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
      const cid = capCid.get(cap); const d = deltas[cap]!;
      if (!cid || !Object.keys(d).length) continue;
      for (const u of utilsOf(d, variant)) add(cid, u);
    }
  };
  emit(interaction.hover, "hover");
  emit(interaction.focus, "focus");
  for (const pcap of Object.keys(interaction.hoverDesc ?? {}).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const pcid = capCid.get(pcap); if (!pcid) continue;
    const descs = interaction.hoverDesc![pcap]!;
    let any = false;
    for (const ccap of Object.keys(descs).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
      const ccid = capCid.get(ccap); const d = descs[ccap]!;
      if (!ccid || !Object.keys(d).length) continue;
      for (const u of utilsOf(d, "group-hover")) add(ccid, u);
      any = true;
    }
    if (any) groups.add(pcid);
  }
  return { byCid, groups };
}

export function buildTailwind(ir: IR, assetMap: Map<string, string>, colorVar?: (v: string) => string | null, opts?: { interner?: ColorInterner; includeNode?: (id: string) => boolean; interaction?: InteractionCapture; reflow?: boolean }): TailwindOutput {
  // Colors tokenized (var(--…)); typography/geometry kept RAW (text-[16px] reads cleaner
  // than a token ref). The full tokenResolver is deliberately NOT passed — only colors are
  // tokenized below, so spacing/type stay as readable arbitrary values.
  const rules = collectNodeRules(ir, assetMap, opts?.includeNode, colorVar, undefined, opts?.reflow);
  const classOf = new Map<string, string>();
  const styleOf = new Map<string, Map<string, string>>(); // cid → inline style (base-only gradients/url)
  const extraParts: string[] = []; // pseudo rules + url()-bearing decls, keyed by [data-cid]
  // Shared across routes in multi-route generation; fresh per build for single-page.
  const interner = opts?.interner ?? createColorInterner();
  const colorTokens = interner.tokens;
  let utilCount = 0;
  const nodeById = new Map<string, IRNode>();
  const parentById = new Map<string, IRNode>();
  const indexNode = (n: IRNode, parent?: IRNode): void => {
    nodeById.set(n.id, n);
    if (parent) parentById.set(n.id, parent);
    for (const c of n.children) if (!isTextChild(c)) indexNode(c, n);
  };
  indexNode(ir.root);

  // Color interner: every distinct color value → a stable theme token referenced as
  // var(--…). Palette colors already arrive as var(--color-*) (kept, semantic); any other
  // color is minted a numbered token (--clr-N) so raw rgb/hex NEVER lands in markup.
  // The token holds the literal value, minted in deterministic first-encounter order.
  const internColor = (literal: string): string => {
    let name = interner.byValue.get(literal);
    if (!name) { name = `clr-${interner.seq.n++}`; interner.byValue.set(literal, name); interner.defs.set(name, literal); }
    colorTokens.add(name);
    return `var(--${name})`;
  };
  // A standalone color literal, OR colors EMBEDDED in a paint value (gradient stops,
  // shadow colors), are replaced by var(--…) refs so raw rgb/hex never lands in markup.
  // Modern color functions (oklab/oklch/lab/lch/color()) must be interned too — a site authored in
  // oklab() otherwise ships hundreds of raw `text-[color:oklab(…)]` literals (the rgb/hex-only audit
  // metric silently misses them). Each has no nested parens, so a flat `\([^()]*\)` body is exact.
  const COLOR_LITERAL = /rgba?\([^()]*\)|hsla?\([^()]*\)|(?:ok)?lab\([^()]*\)|(?:ok)?lch\([^()]*\)|color\([^()]*\)|#[0-9a-fA-F]{3,8}\b/gi;
  const tokenizeColors = (prop: string, value: string): string => {
    if (prop === "content") return value; // arbitrary strings — don't touch
    if (tokenName(value)) { colorTokens.add(tokenName(value)!); return value; } // already a (palette) token
    return value.replace(COLOR_LITERAL, (m) => internColor(m));
  };
  // Some values are too fragile for Tailwind's arbitrary-value round-trip and go to RAW
  // [data-cid] CSS instead (exact, and out of markup so no magic-literal cost):
  //  - url() — Tailwind's `bg-[url("/assets/…")]` is mangled by Next's webpack url resolver.
  //  - gradient() — modern color funcs inside a gradient (e.g. `oklab(L a b / α)`, whose
  //    spaces/slash/negatives don't survive `_`-escaping) silently compile the whole
  //    background-image to `none`. A raw declaration replays the literal gradient verbatim.
  const isRaw = (v: string): boolean => v.includes("url(") || v.includes("gradient(");
  const emit = (p: string, v0: string, pre: string, utils: string[], raw: Map<string, string>): void => {
    if (isRaw(v0)) { raw.set(p, v0); return; } // raw → ditto.css (a stylesheet, not markup)
    const u = declToUtil(p, tokenizeColors(p, v0));
    if (u) utils.push(pre + u); // declToUtil returns "" for an inert decl (e.g. identity transform)
  };

  for (const [cid, nr] of rules) {
    const sel = `[data-cid="${cid}"]`;
    // transform-origin only matters with rotate/scale/skew. When this node's transform is a pure
    // translate / none at every level, each baked `origin-[Npx_Npx]` is inert noise — strip them.
    if (!(transformNeedsOrigin(nr.base.get("transform")) || nr.bands.some((b) => transformNeedsOrigin(b.decls.get("transform"))))) {
      nr.base.delete("transform-origin");
      for (const b of nr.bands) b.decls.delete("transform-origin");
    }
    const utils: string[] = [];
    const baseRaw = new Map<string, string>();
    for (const [p, v] of nr.base) emit(p, v, "", utils, baseRaw);
    // Collect the raw values each band carries so we know which BASE raw props are also banded.
    const bandRaws: Array<{ media: string; raw: Map<string, string> }> = [];
    for (const b of nr.bands) {
      const pre = prefixFor(b.media);
      const bandRaw = new Map<string, string>();
      for (const [p, v] of b.decls) emit(p, v, pre, utils, bandRaw);
      if (bandRaw.size) bandRaws.push({ media: b.media, raw: bandRaw });
    }
    // A base raw value (gradient / url background) with NO band touching the same prop is a static
    // one-off — emit it as an inline `style={{…}}` (exact, no Tailwind-escape mangling) so the node
    // needs no `[data-cid]` ditto.css rule and the shipped data-cid is stripped. If the prop IS
    // banded, it must stay in ditto.css: an inline style would out-specify the @media override.
    const bandedRawProps = new Set<string>(bandRaws.flatMap((b) => [...b.raw.keys()]));
    const inlineStyle = new Map<string, string>();
    for (const [p, v] of [...baseRaw]) {
      if (!bandedRawProps.has(p)) { inlineStyle.set(p, tokenizeColors(p, v)); baseRaw.delete(p); }
    }
    if (inlineStyle.size) styleOf.set(cid, inlineStyle);
    if (baseRaw.size) extraParts.push(fmtRule(sel, baseRaw)); // base raw BEFORE band raw (cascade)
    for (const { media, raw } of bandRaws) extraParts.push(`${media} {\n${fmtRule(sel, raw)}\n}`);
    const node = nodeById.get(cid);
    const intent = node ? sourceIntentUtilities(node, parentById.get(cid), ir.doc.viewports, ir.doc.canonicalViewport) : { axes: new Set<SourceAxis>(), utilities: [], css: [] };
    for (const css of intent.css) extraParts.push(css);
    const intentMerged = intent.axes.size ? [...dropGeneratedAxes(utils, intent.axes), ...intent.utilities] : utils;
    if (intentMerged.length) { const cu = dedupeUtils(dropRedundantBands(mergeBands(collapseUtils(dropNoopInsets(intentMerged))))); classOf.set(cid, cu.join(" ")); utilCount += cu.length; }
    // Pseudo-elements → Tailwind `before:`/`after:` variant utilities folded into the className
    // (the way a human writes a decorative pseudo), so the node needs NO `[data-cid]` ditto.css rule
    // and ships no data-cid. Fall back to a ditto.css rule only when a value can't survive Tailwind's
    // arbitrary round-trip: url()/gradient() (mangled by the escape), or a non-trivial `content`
    // (counter()/attr()/concatenation/brackets) — the simple decorative `content:""`/`"glyph"` converts.
    const pseudoUtils: string[] = [];
    for (const kind of ["before", "after"] as const) {
      const pr = nr[kind];
      if (!pr) continue;
      const content = pr.base.get("content") ?? '""';
      const simpleContent = content === '""' || /^"[^"\\[\]]*"$/.test(content);
      const allVals = [...pr.base.values(), ...pr.bands.flatMap((b) => [...b.decls.values()])];
      if (!simpleContent || allVals.some(isRaw)) {
        const psel = `${sel}::${kind}`; // fallback: raw [data-cid] rule (node keeps its data-cid)
        extraParts.push(fmtRule(psel, pr.base));
        for (const b of pr.bands) extraParts.push(`${b.media} {\n${fmtRule(psel, b.decls)}\n}`);
        continue;
      }
      const toDecl = (p: string, v: string): string =>
        p === "content" ? `content-['${arb(v.replace(/^"(.*)"$/s, "$1"))}']` : declToUtil(p, tokenizeColors(p, v));
      const raw: string[] = [];
      for (const [p, v] of pr.base) raw.push(toDecl(p, v));
      for (const b of pr.bands) { const pre = prefixFor(b.media); for (const [p, v] of b.decls) raw.push(pre + toDecl(p, v)); }
      // Collapse/snap on the bare decls, then inject `<kind>:` AFTER any responsive prefix
      // (`max-md:before:inset-0`), the order Tailwind expects.
      for (const u of mergeBands(collapseUtils(raw))) { const m = VARIANT_PREFIX.exec(u)!; pseudoUtils.push(`${m[1]}${kind}:${m[2]}`); }
    }
    const filteredPseudoUtils = intent.axes.size ? dropGeneratedAxes(pseudoUtils, intent.axes) : pseudoUtils;
    if (filteredPseudoUtils.length) {
      classOf.set(cid, dedupeUtils([...(classOf.get(cid) ?? "").split(" ").filter(Boolean), ...filteredPseudoUtils]).join(" "));
      utilCount += filteredPseudoUtils.length;
    }
  }

  // Stage 4 hover/focus → Tailwind variant utilities folded into each node's className (replacing the
  // [data-cid]:hover ditto.css rules that forced the data-cid to ship). Same toUtil pipeline as the
  // base emit (tokenize colors → declToUtil) so the variant value is identical to the captured delta.
  const inter = interactionUtilities(ir, opts?.interaction, (p, v) => declToUtil(p, tokenizeColors(p, v)));
  for (const [cid, utils] of inter.byCid) {
    if (opts?.includeNode && !opts.includeNode(cid)) continue;
    // Collapse/snap the interaction utilities the same way base utilities are (now that VARIANT_PREFIX
    // captures hover:/focus:/…): four equal `hover:border-b/l/r/t-clr-3` → one `hover:border-clr-3`.
    const collapsed = dedupeUtils(mergeBands(collapseUtils(utils)));
    // Combine with the node's existing base/pseudo classes, then drop any hover/focus delta that
    // equals the base (a no-op interaction state the capture happened to record).
    const merged = dedupeUtils(dropRedundantBands([...(classOf.get(cid) ?? "").split(" ").filter(Boolean), ...collapsed])).join(" ");
    classOf.set(cid, merged); utilCount += collapsed.length;
  }
  for (const cid of inter.groups) {
    if (opts?.includeNode && !opts.includeNode(cid)) continue;
    const cur = classOf.get(cid) ?? "";
    if (!cur.split(" ").includes("group")) classOf.set(cid, [cur, "group"].filter(Boolean).join(" "));
  }

  const kf = keyframesCss(ir, assetMap);
  const colorDefsCss = colorDefsCssOf(interner);
  const extraCss = [...new Set(extraParts)].join("\n");
  return {
    classOf,
    styleOf,
    pseudoCss: [kf, extraCss].filter(Boolean).join("\n\n"),
    colorTokens: [...colorTokens],
    colorDefsCss,
    stats: { nodes: classOf.size, utilities: utilCount },
  };
}

/** The Tailwind-mode globals.css: layer setup (preflight DROPPED), @source, @theme color
 *  + breakpoint bindings, our token :root, and our reset/fonts/page-base inside @layer base
 *  so utilities override them. */
export function tailwindGlobalsCss(opts: {
  reset: string; fontCss: string; tokensCss: string; htmlBg: string; bodyFont: string;
  clip: string; colorTokens: string[]; viewports: number[];
}): string {
  const screens = [...opts.viewports].sort((a, b) => a - b).map((v) => `  --breakpoint-vp${v}: ${v}px;`).join("\n");
  const colors = opts.colorTokens.map((n) => `  --color-${n}: var(--${n});`).join("\n");
  return `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@source "./";

/* Tailwind theme: color tokens (so bg-primary/text-foreground resolve to our vars) +
   breakpoints. @theme inline keeps the var() reference (theme-swappable at runtime). */
@theme inline {
${screens}
${colors}
}

/* Design tokens (values). */
${opts.tokensCss}
@layer base {
${opts.reset}
/* fonts */
${opts.fontCss}
html { background: ${opts.htmlBg}; }
body { font-family: ${opts.bodyFont}; }${opts.clip}
}
`;
}
