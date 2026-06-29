import { join } from "node:path";
import { rmSync } from "node:fs";
import { writeText } from "../util/fsx.js";
import type { IR, IRNode, IRChild, IRTextNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import { generateCss, RESET_CSS } from "./css.js";
import { generateInteractionCss } from "./interactionCss.js";
import { buildRuntimeSpecs, wiresJsx, dittoWireImportPath, DITTO_WIRE_TSX, accordionJsx, accordionImportPath, ACCORDION_TSX, type AccordionRuntimeSpec, type RuntimeSpec } from "./interactive.js";
import { buildMotionSpec, motionWireJsx, dittoMotionImportPath, motionHasContent, DITTO_MOTION_TSX, type MotionSpec } from "./motion.js";
import { buildMenuSpecs, menusJsx, dropdownMenuImportPath, DROPDOWN_MENU_TSX, type RTMenu } from "./menu.js";
import type { AssetGraph } from "../infer/assets.js";
import type { FontGraph } from "../infer/fonts.js";
import { SYSTEM_FALLBACK } from "../infer/fonts.js";
import { detectComponents, type ComponentPlan, type ComponentCluster } from "../infer/components.js";
import { buildClassMap } from "./classMap.js";
import { buildTailwind, tailwindGlobalsCss } from "./tailwind.js";
import { planSections, type SectionPlan } from "./sectionSplit.js";
import type { RecipeReport } from "../infer/recipes.js";
import { emitSeoAssetFiles, emitSeoRoutes, jsonLdHeadMarkup, metadataExport, routeSummaryFromIr, seoStaticFiles, viewportExport, type SeoInventory } from "./seo.js";
import { emitGeneratedDocs } from "./docs.js";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Containers whose only valid children are specific elements; the HTML parser
// foster-parents stray (whitespace) text out, so emitting it breaks hydration.
const ELEMENT_ONLY_PARENTS = new Set(["ul", "ol", "table", "thead", "tbody", "tfoot", "tr", "select", "colgroup", "optgroup", "menu", "dl"]);

// Block-level element tags. A JS-built DOM (createElement+appendChild) can legally
// place these inside a <p>/<hN> (the DOM API allows it), but when serialized to
// static HTML the parser auto-closes the <p>/<hN> before the block child and
// restructures the tree — so React's SSR markup and the browser's parsed DOM
// disagree, throwing hydration errors #418/#423 (descript, mailchimp, posthog).
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
// Table-scoped tags are only valid inside a <table>. A live React app can create them anywhere
// via the DOM API (so the captured DOM may hold an orphan <caption>/<tr>/<td>/…), but when we
// emit one as STATIC HTML with no <table> ancestor the parser foster-parents/drops it, so the
// SSR markup parses to a different tree than React expects → hydration errors #418/#423. Such
// orphans are demoted to a neutral <div> (CSS is keyed by cid, so the box renders identically).
const TABLE_SCOPED = new Set(["caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th"]);
// `<button>` establishes a parsing scope that stops a nested block from closing an
// ancestor <p>/<hN>, so a block inside a button does NOT violate the outer p/hN.
function hasBlockDescendant(node: IRNode): boolean {
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    if (BLOCK_TAGS.has(c.tag)) return true;
    if (c.tag === "button") continue; // re-scopes; its blocks don't close the ancestor p
    if (hasBlockDescendant(c)) return true;
  }
  return false;
}

// Parents whose content model the parser enforces; if the subtree violates it the
// parent is retagged to a neutral <div> so the static HTML parses to the same tree
// (CSS is keyed by cid, so the box renders identically).
//  - <p>/<hN>: a block-level element ANYWHERE in the subtree (through inline
//    wrappers like <a>/<span>) closes the <p>/<hN> in the parser ("<p> cannot be a
//    descendant of <p>"), so check descendants, not just direct children.
//  - <ul>/<ol>/<menu>/<dl>: only direct non-list children are foster-parented.
function violatesContentModel(node: IRNode, tag: string): boolean {
  if (tag === "p" || /^h[1-6]$/.test(tag)) return hasBlockDescendant(node);
  const elementChildren = node.children.filter((c): c is IRNode => !isTextChild(c));
  if (tag === "ul" || tag === "ol" || tag === "menu") return elementChildren.some((c) => c.tag !== "li");
  if (tag === "dl") return elementChildren.some((c) => c.tag !== "dt" && c.tag !== "dd" && c.tag !== "div");
  return false;
}

// HTML attribute name -> React prop name for the cases React requires camelCase.
const ATTR_RENAME: Record<string, string> = {
  for: "htmlFor", srcset: "srcSet", colspan: "colSpan", rowspan: "rowSpan",
  datetime: "dateTime", itemprop: "itemProp", hreflang: "hrefLang",
  autoplay: "autoPlay", playsinline: "playsInline", readonly: "readOnly",
  maxlength: "maxLength", crossorigin: "crossOrigin", novalidate: "noValidate",
  tabindex: "tabIndex", contenteditable: "contentEditable",
};
const BOOLEAN_ATTRS = new Set(["controls", "autoplay", "loop", "muted", "playsinline", "disabled", "checked", "selected", "readonly", "multiple", "open", "reversed", "default", "hidden", "required", "novalidate"]);
const ASSET_ATTRS = new Set(["src", "poster"]);
// 1x1 transparent gif — used for asset refs that could not be downloaded so the
// generated app never points back to a remote origin or 404s (rubric Gate 2).
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export type GenerateInput = {
  ir: IR;
  assetGraph: AssetGraph;
  fontGraph: FontGraph;
  appDir: string;
  sourceDir?: string;
  sourceUrl: string;
  seoInventory?: SeoInventory;
  colorVar?: (value: string) => string | null; // Stage 3.5: semantic color tokens
  tokenResolver?: import("../infer/tokens.js").TokenResolver; // typography/spacing token refs (var(--…))
  primitives?: Map<string, string>; // Stage 3.5: cid → recognized primitive type
  interaction?: import("../capture/interactions.js").InteractionCapture; // Stage 4: hover/focus + patterns
  rejectedSpecs?: Set<string>; // Stage 4: pattern keys the gate proved don't reproduce → static
  components?: boolean; // Stage 4.5: extract repeated subtrees into components (opt-in)
  recipeReport?: RecipeReport; // Stage 7.2: high-level recipe hints for section naming/emission
  motion?: import("../capture/motion.js").MotionCapture; // Stage 5: WAAPI + rotating-text replay
  humanize?: boolean; // Output-quality: semantic class map + (later) section split. Default true.
  humanizeMode?: "tailwind" | "css"; // styling output: Tailwind utilities (default) or semantic CSS classes.
  framework?: AppFramework; // output framework: Next.js App Router (default) or Vite React.
  reflow?: boolean; // Opt-in reflow trade: flow ALL heights incl wrappable
                    // text, accepting position drift the perceptual gate proves invisible. Default off.
};

export type AppFramework = "next" | "vite";

/** Resolve an internal href to its final value in the generated app. For
 *  multi-route sites this maps a source path to the cloned route (or a collapsed
 *  collection's representative). Single-page generation passes none. */
export type LinkRewrite = (href: string) => string;

/** Stage 4.5: a live registry of the components being extracted for one module.
 *  Runs whose emitted skeleton is byte-identical share ONE component function (keyed
 *  by `skeletonToName`); each run still gets its own data array, so the rendered DOM
 *  is unchanged — only the verbose function is deduped. `funcDefs` are the unique
 *  function sources and `dataDecls` the per-run `const Name_dataK = [...]` arrays (both
 *  emitted in the page preamble); `failed` holds clusters (by first-instance cid) that
 *  bailed back to inline; `nodeByCid` resolves instance roots to their IR nodes. */
export type ComponentRegistry = {
  plan: ComponentPlan;
  nodeByCid: Map<string, IRNode>;
  funcDefs: Map<string, string>; // component name → function source (unique skeletons)
  skeletonToName: Map<string, string>; // skeleton JSX (name-independent) → component name
  nameCounts: Map<string, number>; // baseName → # distinct skeletons (for the dedup suffix)
  dataDecls: Array<{ varName: string; compName: string; body: string; dataModel?: string }>; // per-run data arrays (editable content only)
  cidDecls: Array<{ varName: string; body: string }>; // per-run data-cid arrays (internal plumbing, kept out of content.ts)
  styleDecls: Array<{ varName: string; compName: string; body: string }>; // per-run class-override arrays (styling plumbing, kept out of content.ts)
  dataCounts: Map<string, number>; // component name → # data arrays emitted
  fieldTypes: Map<string, FieldType[]>; // Stage 6: component name → its content schema
  styleFieldTypes: Map<string, FieldType[]>; // component name → its per-instance class-override schema
  byName: Map<string, { runs: number; instances: number; cids: string[] }>; // for the summary
  failed: Set<string>; // cluster first-instance cids that bailed to inline
};

/** Stage 6: one field of an extracted component's content schema. */
export type FieldType = { name: string; type: string; optional: boolean };

/** The TS type of an emitted data value source — strings dominate (every value is a
 *  JSON literal); booleans are emitted bare; inline-SVG is a `{ __html }` object. */
function tsTypeOf(valueSrc: string): string {
  if (valueSrc === "true" || valueSrc === "false") return "boolean";
  if (valueSrc.startsWith("{ __html")) return "{ __html: string }";
  if (valueSrc.startsWith("<")) return "ReactNode"; // JSX field (e.g. an SVG icon's inner markup)
  return "string";
}

/** A field value that is raw JSX (an SVG icon) makes the content module a .tsx with a ReactNode
 *  import — `<>…</>` can't live in a plain `.ts`. */
function isJsxValue(valueSrc: string): boolean {
  return valueSrc.startsWith("<");
}

/** Generation context threaded through JSX emission: internal-link rewriting, the
 *  recognized-primitive map (cid → type) for `data-component`, and (Stage 4.5) the
 *  component-extraction registry. */
/** Stage: a live registry of section subtrees being hoisted into their own modules.
 *  `modules` maps a section component name → its rendered JSX body (rendered once, when
 *  the page first reaches that section root); `order` preserves document order for
 *  deterministic file + import emission. */
export type SectionRegistry = { plan: SectionPlan; modules: Map<string, string>; order: string[] };

/** Registry of inline SVGs hoisted into their own `svgs/` modules: `defs` maps a
 *  component name → its module source, deduped by the SVG's content (`byKey`), so a
 *  logo reused in mobile + desktop chrome becomes one component. Each instance passes its
 *  own `cid` (the grader aligns by data-cid). */
export type SvgRegistry = { byKey: Map<string, string>; defs: Map<string, string>; order: string[]; nameCount: Map<string, number> };

export type RenderCtx = { linkRewrite?: LinkRewrite; primitives?: Map<string, string>; components?: ComponentRegistry; classOf?: (cid: string) => string | undefined; styleOf?: (cid: string) => Map<string, string> | undefined; sections?: SectionRegistry; svgs?: SvgRegistry };

function buildAssetMap(assetGraph: AssetGraph): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of assetGraph.entries) {
    if (e.classification === "downloaded" && e.localPath && e.type !== "css") addAssetUrlAliases(m, e.sourceUrl, e.localPath);
  }
  return m;
}

function addAssetUrlAliases(map: Map<string, string>, sourceUrl: string, localPath: string): void {
  map.set(sourceUrl, localPath);
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname + u.search + u.hash;
    map.set(path, localPath);
    const host = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
    map.set(`${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${path}`, localPath);
  } catch {
    // Non-URL asset keys are still handled by the exact map entry above.
  }
}

function resolveUrl(url: string, base: string): string {
  try { return new URL(url, base).href; } catch { return url; }
}

/** Default single-page link rewrite: a clone is self-contained, so a link that points
 *  back to the SOURCE origin is rewritten to an app-relative path (`/enterprise`) instead
 *  of the absolute source URL (`https://www.source.com/enterprise`) — otherwise every nav
 *  link silently navigates the user off the clone and back to the live original. Matching
 *  the EXACT origin (not just the registrable host) keeps this gate-neutral: gate 3
 *  resolves both source and generated hrefs against the source origin, so a same-origin
 *  link's relative form normalizes back to the identical absolute it had before. Other
 *  origins (apex/subdomains like trust.*), in-page anchors (`#…`), and non-web schemes
 *  (mailto:/tel:) are left as captured. Multi-route `clone-site` passes its own
 *  route-aware rewrite instead. */
export function sameOriginRelativeLinkRewrite(sourceUrl: string): LinkRewrite {
  let origin = "";
  try { origin = new URL(sourceUrl).origin; } catch { /* ignore */ }
  return (href: string): string => {
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return href;
    try {
      const u = new URL(href, sourceUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return href;
      if (origin && u.origin === origin) return (u.pathname || "/") + u.search + u.hash;
      return u.href; // external navigation stays absolute
    } catch { return href; }
  };
}

function escapeText(text: string): string {
  return JSON.stringify(text);
}

/** Render a node's [key, valueExpr] pairs as clean inline JSX attributes (leading space
 *  per attr). Replaces the old `{...({…} as any)}` spread — the generated app sets
 *  `typescript.ignoreBuildErrors`, so exotic attrs never fail the build and need no cast.
 *  - boolean (`true`)        → bare attr            (e.g. `hidden`)
 *  - object (`{ __html… }`)  → `name={{…}}`         (dangerouslySetInnerHTML)
 *  - string literal          → `name="…"` when it round-trips, else `name={"…"}`
 *  - any other expression    → `name={expr}`        (component data: `d.href`, `cids[0]`) */
function jsxAttr(key: string, valueSrc: string): string {
  const name = key.startsWith('"') ? key.slice(1, -1) : key;
  if (valueSrc === "true") return name;
  if (valueSrc.startsWith("{")) return `${name}={${valueSrc}}`;
  if (valueSrc.startsWith('"')) {
    let raw: string;
    try { raw = JSON.parse(valueSrc) as string; } catch { return `${name}={${valueSrc}}`; }
    return /^[^"&<>\n\r]*$/.test(raw) ? `${name}="${raw}"` : `${name}={${valueSrc}}`;
  }
  return `${name}={${valueSrc}}`;
}
export function renderAttrs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => " " + jsxAttr(k, v)).join("");
}

/** A text child as JSX: bare when it round-trips exactly (no special chars, no leading/
 *  trailing or doubled whitespace that JSX would collapse), else the exact `{"…"}` form.
 *  Bare text reads far cleaner; the guard keeps it byte-faithful for the text gate. */
function jsxText(raw: string): string {
  if (raw.length > 0 && raw === raw.trim() && !/\s{2,}/.test(raw) && !/[{}<>&\n\r\t]/.test(raw)) return raw;
  return `{${escapeText(raw)}}`;
}

/** The ordered [propKey, valueExpr] list a node emits — rendered to clean JSX attributes
 *  by renderAttrs. Each valueExpr is ready-to-emit JS source (a JSON literal,
 *  `true`, or a `{ __html: … }` object). Component extraction reuses this so the
 *  extracted skeleton resolves attributes/assets/links exactly as inline rendering
 *  would (no divergent logic): a prop whose valueExpr is identical across instances
 *  is baked into the skeleton, one that varies becomes a per-instance data field. */
export function propsList(node: IRNode, assetMap: Map<string, string>, sourceUrl: string, ctx?: RenderCtx): Array<[string, string]> {
  // Custom elements (hyphenated tags, e.g. <react-app>, <model-viewer>) are not
  // HTML elements, so React 18 does NOT map `className`→`class` or apply its other
  // camelCase attribute renames — it would emit a literal `classname` attribute
  // that no CSS rule matches, leaving the whole subtree unstyled. Use raw HTML
  // attribute names for them.
  const isCustom = node.tag.includes("-");
  const props: Array<[string, string]> = [];
  // Semantic class (classMap) when provided, else the legacy per-node `c<id>`. A node
  // with no own styles gets no class (classOf returns undefined) — keeps markup clean.
  const cls = ctx?.classOf ? ctx.classOf(node.id) : `c${node.id}`;
  if (cls) props.push([isCustom ? "class" : "className", JSON.stringify(cls)]);
  // Inline style for base-only raw values (gradients / url backgrounds) the Tailwind builder
  // couldn't safely escape — emitting them here (vs a `[data-cid]` ditto.css rule) lets the shipped
  // data-cid be stripped and reads like a hand-written one-off `style={{ backgroundImage: … }}`.
  const styleMap = ctx?.styleOf ? ctx.styleOf(node.id) : undefined;
  if (styleMap && styleMap.size) {
    props.push(["style", svgStyleToObject([...styleMap].map(([k, v]) => `${k}: ${v}`).join("; "))]);
  }
  props.push(['"data-cid"', JSON.stringify(node.id)]);
  // Stage 3.5: stamp the recognized primitive type (button/link/input/…). An
  // attribute only — no effect on computed styles or structure matching.
  const prim = ctx?.primitives?.get(node.id);
  if (prim) props.push(['"data-component"', JSON.stringify(prim)]);

  // Stage 2: a <video> is rendered as its (first-frame) poster — a streamed source
  // has no deterministic frame and its request aborts at snapshot time. Drop the
  // streaming src + autoplay so only the poster paints; keep the poster (rewritten
  // to a local still below). <source>/<track> children are dropped in renderNode.
  const isVideo = node.tag === "video";
  // An <iframe> embeds a third-party, non-deterministic document; reproducing it
  // would break self-containment (rubric Gate 2) and can't be deterministic anyway.
  // Keep the element as a placeholder sized by its captured box, but drop the
  // document-loading attrs so it paints an empty frame instead of pulling content.
  const isIframe = node.tag === "iframe";
  const attrKeys = Object.keys(node.attrs).sort();
  for (const key of attrKeys) {
    let value = node.attrs[key]!;
    if (key === "class" || key === "style" || key === "data-cid-cap") continue;
    if (isVideo && (key === "src" || key === "autoplay" || key === "loop" || key === "preload")) continue;
    if (isIframe && (key === "src" || key === "srcdoc" || key === "name")) continue;

    if (ASSET_ATTRS.has(key)) {
      const abs = resolveUrl(value, sourceUrl);
      const local = assetMap.get(abs);
      value = local ?? TRANSPARENT_GIF; // never point back to a remote origin
    } else if (key === "srcset") {
      // Keep only candidates we actually materialized; drop the rest. Lazy-load
      // libraries seed srcset with 1x1 placeholders (data: GIFs) and swap in the
      // real URLs via JS — replaying those placeholders would beat the rewritten
      // `src` (srcset wins over src) and paint a blank box. If nothing survives,
      // omit srcset so the browser falls back to the real local `src`.
      const kept = value.split(",").map((p) => p.trim()).filter(Boolean).map((seg) => {
        const sp = seg.split(/\s+/);
        const abs = resolveUrl(sp[0] ?? "", sourceUrl);
        const local = assetMap.get(abs);
        return local ? [local, ...sp.slice(1)].join(" ") : null;
      }).filter((x): x is string => x !== null);
      if (kept.length === 0) continue;
      value = kept.join(", ");
    } else if (key === "href") {
      // Preserve in-page anchors. For multi-route sites a linkRewrite maps internal
      // links to the generated clone routes (and collapsed-collection links to their
      // representative); otherwise absolutize so it never 404s inside the clone
      // (external navigation is allowed by the rubric).
      if (!value.startsWith("#")) value = ctx?.linkRewrite ? ctx.linkRewrite(value) : resolveUrl(value, sourceUrl);
    }

    let reactName = isCustom ? key : (ATTR_RENAME[key] ?? key);
    // Static clone inputs should render their captured initial state without becoming controlled
    // React fields. `checked` on its own triggers the read-only controlled-input warning.
    if (!isCustom && node.tag === "input" && key === "checked") reactName = "defaultChecked";
    const propKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(reactName) ? reactName : JSON.stringify(reactName);

    if (BOOLEAN_ATTRS.has(key) && (value === "" || value === key || value === "true")) {
      props.push([propKey, "true"]);
    } else {
      props.push([propKey, JSON.stringify(value)]);
    }
  }

  if (isVideo && !props.some(([k]) => k === "preload")) props.push(["preload", JSON.stringify("none")]);

  if (node.rawHTML && node.tag === "svg") {
    // Strip the Stage-4 capture-id (`data-cid-cap`) the interaction pass stamps on
    // elements: it's internal instrumentation, render-inert, and would otherwise
    // surface verbatim in the markup and (post-extraction) as a bogus data field.
    const inner = svgInnerForNode(node, ctx);
    const svgAttrs = extractSvgAttrs(node.rawHTML);
    let hasFillAttr = false;
    for (const [k, v] of svgAttrs) {
      if (k.toLowerCase() === "fill") hasFillAttr = true;
      if (k === "class" || k === "style" || k === "data-cid-cap" || k.includes(":")) continue;
      const reactName = SVG_ATTR_RENAME[k] ?? k;
      const propKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(reactName) ? reactName : JSON.stringify(reactName);
      if (!props.some(([pk]) => pk === propKey)) props.push([propKey, JSON.stringify(v)]);
    }
    // Raw SVG icons often rely on site CSS (`svg { fill: currentColor }` or a class) that is
    // stripped during extraction. If the root didn't declare a fill, inherit the surrounding text
    // color so monochrome wordmarks/icons don't fall back to the browser's black default.
    if (!hasFillAttr && !props.some(([pk]) => pk === "fill")) props.push(["fill", JSON.stringify("currentColor")]);
    props.push(["dangerouslySetInnerHTML", `{ __html: ${JSON.stringify(inner)} }`]);
  }

  return props;
}

function extractSvgInner(outerHTML: string): string {
  const open = outerHTML.indexOf(">");
  const close = outerHTML.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return "";
  return outerHTML.slice(open + 1, close);
}

function svgLooksLikeIllustration(node: IRNode, ctx?: RenderCtx): boolean {
  if (ctx?.primitives?.get(node.id) === "image") return true;
  const bb = node.bboxByVp[1280] ?? Object.values(node.bboxByVp)[0];
  return !!bb && bb.width >= 96 && bb.height >= 96;
}

function revealCapturedSvgStartState(inner: string, node: IRNode, ctx?: RenderCtx): string {
  if (!svgLooksLikeIllustration(node, ctx)) return inner;
  if (!/(?:\sopacity=(["'])0(?:\.0+)?\1|opacity\s*:\s*0(?:\.0+)?\b)/.test(inner)) return inner;
  return inner
    .replace(/\sopacity=(["'])0(?:\.0+)?\1/g, " opacity=\"1\"")
    .replace(/opacity\s*:\s*0(?:\.0+)?\b/g, "opacity:1");
}

function svgInnerForNode(node: IRNode, ctx?: RenderCtx): string {
  const inner = extractSvgInner(node.rawHTML || "").replace(/\s+data-cid-cap="[^"]*"/g, "");
  return revealCapturedSvgStartState(inner, node, ctx);
}

function extractSvgAttrs(outerHTML: string): Array<[string, string]> {
  const m = /^<svg\b([^>]*)>/i.exec(outerHTML);
  if (!m) return [];
  const attrStr = m[1]!;
  const out: Array<[string, string]> = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(attrStr)) !== null) {
    const name = a[1]!;
    const val = a[3] ?? a[4] ?? "";
    out.push([name, val]);
  }
  return out;
}

// SVG presentation attributes that React requires in camelCase (kebab in JSX is silently
// dropped — and `fill-rule`/`clip-rule` being dropped changes how a path fills). Anything not
// here that's already camel/lowercase (d, cx, fill, viewBox, opacity, transform, offset…) or a
// data-/aria- attribute passes through unchanged.
const SVG_ATTR_RENAME: Record<string, string> = {
  "fill-rule": "fillRule", "clip-rule": "clipRule", "clip-path": "clipPath", "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin", "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset", "stroke-miterlimit": "strokeMiterlimit", "stroke-opacity": "strokeOpacity",
  "fill-opacity": "fillOpacity", "stop-color": "stopColor", "stop-opacity": "stopOpacity", "font-family": "fontFamily",
  "font-size": "fontSize", "font-weight": "fontWeight", "text-anchor": "textAnchor", "letter-spacing": "letterSpacing",
  "shape-rendering": "shapeRendering",
  "gradientunits": "gradientUnits", "gradienttransform": "gradientTransform", "patternunits": "patternUnits",
  "patterncontentunits": "patternContentUnits", "xlink:href": "xlinkHref", "xml:space": "xmlSpace",
  "color-interpolation-filters": "colorInterpolationFilters", "flood-color": "floodColor", "flood-opacity": "floodOpacity",
  "baseline-shift": "baselineShift", "dominant-baseline": "dominantBaseline", "alignment-baseline": "alignmentBaseline",
  "paint-order": "paintOrder", "vector-effect": "vectorEffect", "marker-start": "markerStart", "marker-mid": "markerMid",
  "marker-end": "markerEnd", "mask-type": "maskType", "stroke-linejoin ": "strokeLinejoin",
};
/** A CSS inline-style string → a React style-object literal (`fill:red;stroke-width:2` →
 *  `{ fill: "red", strokeWidth: "2" }`). */
function svgStyleToObject(style: string): string {
  const props = style.split(";").map((s) => s.trim()).filter(Boolean).map((decl) => {
    const i = decl.indexOf(":"); if (i < 0) return null;
    const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const v = decl.slice(i + 1).trim();
    return `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`;
  }).filter(Boolean);
  return `{ ${props.join(", ")} }`;
}
/** Convert one element's raw attribute string to JSX attributes (React-cased). */
function svgConvertAttrs(attrStr: string): string {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null; let out = "";
  while ((m = re.exec(attrStr)) !== null) {
    const raw = m[1]!; const val = m[3] ?? m[4] ?? "";
    if (raw === "class") { out += ` className=${JSON.stringify(val)}`; continue; }
    if (raw === "style") { out += ` style={${svgStyleToObject(val)}}`; continue; }
    const lower = raw.toLowerCase();
    const key = SVG_ATTR_RENAME[raw] ?? SVG_ATTR_RENAME[lower] ??
      (raw.startsWith("data-") || raw.startsWith("aria-") ? raw : raw.includes(":") ? null : raw);
    if (!key || !/^[a-zA-Z_$][\w$-]*$/.test(key)) continue;
    out += ` ${key}=${JSON.stringify(val)}`;
  }
  return out;
}
/** Parse a browser-serialized SVG inner fragment into JSX child elements (so an icon ships as
 *  real `<path d=… />` markup, not a `dangerouslySetInnerHTML` blob). Input is well-formed
 *  (DOM-serialized): lowercase tags, quoted attrs. Returns "" when there's nothing to render. */
function svgInnerToJsx(inner: string, pad: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return "";
  const tokens = trimmed.match(/<\/[a-zA-Z][^>]*>|<[a-zA-Z][^>]*?\/>|<[a-zA-Z][^>]*>|[^<]+/g) || [];
  const lines: string[] = [];
  let depth = 0;
  const ind = (): string => pad + "  ".repeat(depth);
  for (const t of tokens) {
    if (/^<\//.test(t)) {
      depth = Math.max(0, depth - 1);
      const tag = t.slice(2, -1).trim().split(/\s/)[0]!;
      lines.push(`${ind()}</${tag}>`);
    } else if (/\/>$/.test(t)) {
      const m = /^<([a-zA-Z][\w:-]*)([\s\S]*?)\/>$/.exec(t);
      if (m) lines.push(`${ind()}<${m[1]}${svgConvertAttrs(m[2]!)} />`);
    } else if (/^</.test(t)) {
      const m = /^<([a-zA-Z][\w:-]*)([\s\S]*)>$/.exec(t);
      if (m) { lines.push(`${ind()}<${m[1]}${svgConvertAttrs(m[2]!)}>`); depth++; }
    } else {
      const txt = t.trim();
      if (txt) lines.push(`${ind()}{${JSON.stringify(txt)}}`);
    }
  }
  // Collapse an empty element (`<g ...>` immediately followed by `</g>`) to self-closing.
  const merged: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    const next = lines[i + 1];
    const openM = /^(\s*)<([a-zA-Z][\w:-]*)([\s\S]*)>$/.exec(cur);
    const isOpen = openM && !/\/>$/.test(cur) && !/^\s*<\//.test(cur);
    if (isOpen && next && new RegExp(`^\\s*</${openM![2]}>$`).test(next)) {
      merged.push(`${openM![1]}<${openM![2]}${openM![3]} />`);
      i++;
    } else merged.push(cur);
  }
  return merged.join("\n");
}

/** Resolve the emitted tag for a node: an interactive element nested in another is
 *  retagged to a neutral span/div (HTML can't nest <a>/<button>), and a container
 *  whose children violate its content model becomes a <div>. CSS is keyed by cid so
 *  the box renders identically. Shared by inline rendering and component extraction. */
export function resolveTag(node: IRNode, insideInteractive: boolean, insideTable = false): string {
  const isInteractive = node.tag === "a" || node.tag === "button";
  let tag = node.tag;
  if (isInteractive && insideInteractive) {
    const disp = (node.computedByVp[1280] ?? Object.values(node.computedByVp)[0])?.display ?? "";
    tag = /inline(?!-block|-flex|-grid)/.test(disp) ? "span" : "div";
  }
  if (TABLE_SCOPED.has(tag) && !insideTable) tag = "div"; // orphan table element → neutral box
  if (violatesContentModel(node, tag)) tag = "div";
  return tag;
}

function renderNode(node: IRNode, assetMap: Map<string, string>, sourceUrl: string, indent: number, insideInteractive = false, ctx?: RenderCtx, insideTable = false): string {
  const pad = "  ".repeat(indent);
  const attrs = renderAttrs(propsList(node, assetMap, sourceUrl, ctx));
  const tag = resolveTag(node, insideInteractive, insideTable);
  const childInteractive = insideInteractive || node.tag === "a" || node.tag === "button";
  const childTable = insideTable || node.tag === "table";

  if (node.rawHTML && tag === "svg") {
    // Inline SVGs render as real JSX (`<path d=… />`), not a dangerouslySetInnerHTML blob —
    // attrs sans the __html prop, inner markup parsed to React-cased child elements.
    const innerSrc = svgInnerForNode(node, ctx);
    const noHtml = (p: [string, string]) => p[0] !== "dangerouslySetInnerHTML";
    // Hoist inline SVGs into their own svgs/ modules (dedup by content; cid per instance)
    // so section files aren't walls of path data. Skeleton SVGs stay inline (already deduped).
    if (ctx?.svgs) {
      const reg = ctx.svgs;
      const restAttrs = renderAttrs(propsList(node, assetMap, sourceUrl, ctx).filter((p) => p[0] !== '"data-cid"' && noHtml(p)));
      const key = restAttrs + "\0" + innerSrc; // dedup on attrs AND content
      let name = reg.byKey.get(key);
      if (!name) {
        const base = ctx.primitives?.get(node.id) === "image" ? "Illustration" : "Icon";
        const n = (reg.nameCount.get(base) ?? 0) + 1;
        reg.nameCount.set(base, n);
        name = n === 1 ? base : `${base}${n}`;
        reg.byKey.set(key, name);
        reg.order.push(name);
        const body = svgInnerToJsx(innerSrc, "      ");
        const el = body ? `<svg${restAttrs} data-cid={cid}>\n${body}\n    </svg>` : `<svg${restAttrs} data-cid={cid} />`;
        reg.defs.set(name, `export default function ${name}({ cid }: { cid?: string }) {\n  return (\n    ${el}\n  );\n}\n`);
      }
      return `${pad}<${name} cid={${JSON.stringify(node.id)}} />`;
    }
    const restAttrs = renderAttrs(propsList(node, assetMap, sourceUrl, ctx).filter(noHtml));
    const body = svgInnerToJsx(innerSrc, pad + "  ");
    return body ? `${pad}<svg${restAttrs}>\n${body}\n${pad}</svg>` : `${pad}<svg${restAttrs} />`;
  }
  if (VOID_TAGS.has(tag)) {
    return `${pad}<${tag}${attrs} />`;
  }

  const childParts = emitChildren(node.children, tag, assetMap, sourceUrl, indent + 1, childInteractive, ctx, childTable);
  if (childParts.length === 0) {
    return `${pad}<${tag}${attrs} />`;
  }
  return `${pad}<${tag}${attrs}>\n${childParts.join("\n")}\n${pad}</${tag}>`;
}

/** Emit an ordered child list to JSX lines (text coalesced), substituting a
 *  `{Name_data.map(...)}` call for any run of extracted-component instances. Shared
 *  by renderNode (parentTag is the element tag) and the body/chrome fragment
 *  renderers (parentTag null → no element-only-parent whitespace rule). */
function emitChildren(children: IRChild[], parentTag: string | null, assetMap: Map<string, string>, sourceUrl: string, indent: number, childInteractive: boolean, ctx?: RenderCtx, insideTable = false): string[] {
  const pad = "  ".repeat(indent);
  const parts: string[] = [];
  // Coalesce consecutive text children into one. Emitting them as separate JSX
  // expressions ({"a"}{"b"}) makes React insert comment separators the browser's
  // merged single text node won't match -> hydration error #418 (ssense had 27
  // such pairs). The browser merges adjacent text anyway, so this is also faithful.
  let textBuf = "";
  const flushText = () => {
    if (parentTag && ELEMENT_ONLY_PARENTS.has(parentTag) && textBuf.trim() === "") { textBuf = ""; return; }
    if (textBuf.length) parts.push(`${pad}${jsxText(textBuf)}`);
    textBuf = "";
  };
  const reg = ctx?.components;
  for (const c of children) {
    if (isTextChild(c)) {
      textBuf += c.text;
      continue;
    }
    if (parentTag === "video" && (c.tag === "source" || c.tag === "track")) continue;
    // Section split: a section-root child is hoisted into its own module and replaced
    // by a `<HeroSection />` placeholder. Rendered once (subtree → module body); the
    // composed DOM is identical to inlining (same tags/cids/classes).
    const secName = ctx?.sections?.plan.roots.get(c.id);
    if (secName) {
      if (textBuf.trim() === "") textBuf = ""; else flushText();
      const sreg = ctx!.sections!;
      if (!sreg.modules.has(secName)) {
        sreg.order.push(secName);
        sreg.modules.set(secName, ""); // reserve before rendering (guards re-entry)
        sreg.modules.set(secName, renderNode(c, assetMap, sourceUrl, 2, childInteractive, ctx, insideTable));
      }
      parts.push(`${pad}<${secName} />`);
      continue;
    }
    const cluster = reg?.plan.rootToCluster.get(c.id);
    if (cluster && !reg!.failed.has(cluster.rootCids[0]!)) {
      // Drop whitespace-only buffer abutting the run (non-significant for the
      // block/flex/grid containers extraction is allowed in); keep real text.
      if (textBuf.trim() === "") textBuf = ""; else flushText();
      if (reg!.plan.firstRoot.has(c.id)) {
        const call = registerComponent(cluster, ctx!, assetMap, sourceUrl, childInteractive, insideTable);
        if (call) { parts.push(`${pad}${call}`); continue; }
        // extraction bailed (e.g. inconsistent tag resolution) → render inline below
      } else {
        continue; // a non-first instance of a kept cluster: already covered by the map
      }
    }
    flushText();
    parts.push(renderNode(c, assetMap, sourceUrl, indent, childInteractive, ctx, insideTable));
  }
  flushText();
  return parts;
}

/** Render an ordered list of body children to JSX fragment lines (text coalesced).
 *  Used for the single-page body, and for multi-route page (middle children) and
 *  shared-layout chrome (header/footer children). */
export function renderChildrenJsx(children: IRChild[], assetMap: Map<string, string>, sourceUrl: string, indent: number, ctx?: RenderCtx): string {
  return emitChildren(children, null, assetMap, sourceUrl, indent, false, ctx).join("\n");
}

// ---------- Stage 4.5: component extraction emission ----------
// ---------- Stage 6: semantic field naming (the editable content model) ----------

/** Per-component field-name generator: each varying prop/text becomes a stable,
 *  *semantic* data key (title/href/imgSrc/date…) inferred from STRUCTURE — the prop
 *  key or the owning node's tag — deduped within the component, with a generic
 *  fallback. Naming is a pure function of shape (never the per-instance value), so
 *  two runs of the same shape emit the same keys and still share one function (the
 *  skeleton-dedup invariant). cid plumbing fields are named `_cid` (underscored) to
 *  read as non-content. */
type FieldGen = { field: (hint: string) => string };

function makeFieldGen(initial?: Iterable<string>): FieldGen {
  const used = new Set(initial ?? []);
  const dedup = (base: string): string => {
    let n = base, i = 2;
    while (used.has(n)) n = `${base}${i++}`;
    used.add(n);
    return n;
  };
  const clean = (hint: string, fallback: string): string => {
    const h = hint.replace(/[^a-zA-Z0-9_$]/g, "");
    return dedup(/^[a-zA-Z_$]/.test(h) ? h : fallback);
  };
  return {
    field: (hint: string) => clean(hint, "value"),
  };
}

/** Per-component collector for the data-cid of each skeleton node, kept SEPARATE from
 *  the editable content: `rows[i]` is instance i's cid list (in skeleton node order), so
 *  the rendered DOM keeps each instance's original cid (gates align by data-cid) while
 *  content.ts holds only semantic fields. `k` is the running node index. */
type CidCollector = { rows: string[][]; k: number };
function takeCid(coll: CidCollector, instances: IRNode[]): number {
  const idx = coll.k++;
  instances.forEach((n, i) => { coll.rows[i]![idx] = JSON.stringify(n.id); });
  return idx;
}

/** A self-contained class-name merger emitted into each component module that needs it
 *  (kept import-free so component files stay standalone). Skips falsy parts and joins —
 *  exact for our output because a node's baked base classes and its per-instance overrides
 *  are disjoint token sets. Swap in `tailwind-merge` if you want conflict-aware merging
 *  when hand-editing the ./_styles overrides. */
const CN_HELPER = `function cn(...parts: Array<string | false | null | undefined>) {\n  return parts.filter(Boolean).join(" ");\n}`;

/** Split a className value SOURCE (a JSON string literal as emitted by propsList) into its
 *  whitespace-separated tokens. Returns [] for a non-string / unparseable source. */
function parseClassTokens(valueSrc: string): string[] {
  try {
    const s = JSON.parse(valueSrc);
    return typeof s === "string" ? s.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Semantic field name for a varying ATTRIBUTE prop, from the prop key + owner tag. */
function propHint(propKey: string, tag: string): string {
  const k = propKey.replace(/^"|"$/g, "");
  switch (k) {
    case "className": case "class": return "className";
    case "href": return "href";
    case "src": return /^(img|picture)$/.test(tag) ? "imgSrc" : tag === "video" ? "videoSrc" : "src";
    case "poster": return "poster";
    case "srcSet": return "srcSet";
    case "alt": return "alt";
    case "title": return "label";
    case "aria-label": return "ariaLabel";
    case "data-component": return "kind";
    case "dangerouslySetInnerHTML": return "icon";
    default: return k;
  }
}

/** Semantic field name for a varying TEXT run, from the owning element tag. */
function textHint(tag: string, ancestors: string[] = []): string {
  const chain = [tag, ...ancestors];
  if (chain.some((t) => t === "time")) return "date";
  if (chain.some((t) => /^h[1-6]$/.test(t))) return "title";
  if (chain.some((t) => t === "p")) return "description";
  if (tag === "a" || tag === "button") return "label";
  // Common card/button shape: text wrapped in a span/div inside an anchor/button.
  // Keep this below heading/paragraph detection so full-card links do not turn
  // their titles and descriptions into generic labels.
  if ((tag === "span" || tag === "div") && ancestors.some((t) => t === "a" || t === "button")) return "label";
  return "text";
}

const elementChildren = (n: IRNode): IRNode[] => n.children.filter((c): c is IRNode => !isTextChild(c));

function propValue(node: IRNode, key: string, assetMap: Map<string, string>, sourceUrl: string, ctx: RenderCtx): string | undefined {
  return propsList(node, assetMap, sourceUrl, ctx).find(([k]) => k === key)?.[1];
}

function textOf(node: IRNode): string {
  let out = "";
  const walk = (n: IRNode): void => {
    for (const c of n.children) {
      if (isTextChild(c)) out += c.text;
      else walk(c);
    }
  };
  walk(node);
  return out;
}

type LogoCloudShape = { root: IRNode; link?: IRNode; inner?: IRNode; img: IRNode; tooltip?: IRNode };

function logoCloudShape(root: IRNode): LogoCloudShape | null {
  if (root.tag !== "div") return null;
  const kids = elementChildren(root);
  if (kids.length !== 1) return null;
  const only = kids[0]!;
  if (only.tag === "img") return { root, img: only };
  if (only.tag !== "a") return null;
  const linkKids = elementChildren(only);
  if (linkKids.length !== 1 || linkKids[0]!.tag !== "div") return null;
  const inner = linkKids[0]!;
  const innerKids = elementChildren(inner);
  const img = innerKids.find((c) => c.tag === "img");
  if (!img) return null;
  const tooltip = innerKids.find((c) => c !== img && c.tag === "div");
  return { root, link: only, inner, img, ...(tooltip ? { tooltip } : {}) };
}

function rowsOf(src: Array<Map<string, string>>): string {
  return src
    .map((m) => "{ " + [...m].map(([k, v]) => `${k}: ${v}`).join(", ") + " }")
    .join(",\n    ");
}

function rowsHaveField(rows: Array<Map<string, string>>, field: string): boolean {
  return rows.some((r) => r.has(field));
}

function literalString(valueSrc: string): string | null {
  try {
    const v = JSON.parse(valueSrc);
    return typeof v === "string" ? v.trim() : null;
  } catch {
    return null;
  }
}

function valuesLookStat(rows: Array<Map<string, string>>, field: string): boolean {
  const values = rows.map((r) => r.get(field)).filter((v): v is string => !!v).map(literalString).filter((v): v is string => v !== null);
  return values.length > 0 && values.every((v) => /^[\d,.]+k?$/i.test(v));
}

function renameDataField(skeleton: string, rows: Array<Map<string, string>>, from: string, to: string): string {
  if (from === to || rowsHaveField(rows, to)) return skeleton;
  let changed = false;
  for (const row of rows) {
    const value = row.get(from);
    if (value === undefined) continue;
    row.delete(from);
    row.set(to, value);
    changed = true;
  }
  return changed ? skeleton.replace(new RegExp(`\\bd\\.${from}\\b`, "g"), `d.${to}`) : skeleton;
}

function semanticizeRecipeFields(cluster: ComponentCluster, skeleton: string, rows: Array<Map<string, string>>): string {
  if (cluster.recipeKind !== "card-grid" && cluster.recipeKind !== "feature-grid" && cluster.recipeKind !== "product-grid") return skeleton;
  let out = skeleton;
  if (!rowsHaveField(rows, "title")) {
    out = renameDataField(out, rows, "label", "title");
    out = renameDataField(out, rows, "text", "title");
  }
  if (!rowsHaveField(rows, "description")) {
    out = renameDataField(out, rows, "text2", "description");
  }
  if (valuesLookStat(rows, "label2")) out = renameDataField(out, rows, "label2", "stat");
  return out;
}

function canonicalViewportFor(n: IRNode): number {
  if (n.computedByVp[1280] || n.visibleByVp[1280] !== undefined) return 1280;
  const keys = Object.keys(n.computedByVp).map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return keys[0] ?? 1280;
}

type TextLeaf = { text: string; node: IRNode; index: number; ancestorTags: string[] };

function normalizeTextValue(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function meaningfulTextValue(text: string): boolean {
  if (!text) return false;
  if (/^[→⤓·|]+$/.test(text)) return false;
  if (text.length === 1 && !/^\d$/.test(text)) return false;
  return true;
}

function collectVisibleTextLeaves(root: IRNode): TextLeaf[] {
  const out: TextLeaf[] = [];
  const vp = canonicalViewportFor(root);
  const walk = (node: IRNode, hidden: boolean, ancestorTags: string[]): void => {
    const cs = node.computedByVp[vp];
    const nodeHidden = hidden
      || node.attrs["aria-hidden"] === "true"
      || node.visibleByVp[vp] === false
      || cs?.display === "none"
      || cs?.visibility === "hidden"
      || cs?.opacity === "0";
    if (node.tag === "svg" || node.tag === "script" || node.tag === "style") return;
    for (const c of node.children) {
      if (isTextChild(c)) {
        if (nodeHidden) continue;
        const text = normalizeTextValue(c.text);
        if (meaningfulTextValue(text)) out.push({ text, node, index: out.length, ancestorTags });
      } else {
        walk(c, nodeHidden, [...ancestorTags, node.tag]);
      }
    }
  };
  walk(root, false, []);
  return out;
}

function textLeafTag(leaf: TextLeaf): string {
  return leaf.node.tag;
}

function isDateText(text: string, leaf?: TextLeaf): boolean {
  return (!!leaf && textLeafTag(leaf) === "time")
    || /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(text)
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text);
}

function isReadTimeText(text: string): boolean {
  return /\b\d+\s+min\s+read\b/i.test(text);
}

function isStatText(text: string): boolean {
  return /^[\d,.]+k?$/i.test(text);
}

function isPriceText(text: string): boolean {
  return /^(?:from\s+)?[$£€]\s?\d[\d,.]*(?:\.\d{2})?(?:\s*(?:\/|per)\s+\w+)?$/i.test(text)
    || /^\d[\d,.]*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP)$/i.test(text);
}

function isBadgeText(text: string): boolean {
  return /\b(?:new|sale|sold out|limited|popular|best seller|bestseller|pre-order)\b/i.test(text) && text.length <= 32;
}

function isCtaText(text: string): boolean {
  return /\b(?:get started|start|try|join|sign up|book|contact|shop|learn more|view|download|talk|read more|apply|subscribe)\b/i.test(text);
}

function isMetadataText(text: string, leaf?: TextLeaf): boolean {
  return isDateText(text, leaf) || isReadTimeText(text) || isStatText(text) || isPriceText(text) || isBadgeText(text);
}

function cssPx(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

function leafBox(leaf: TextLeaf) {
  return leaf.node.bboxByVp[canonicalViewportFor(leaf.node)];
}

function sameTextRow(a: TextLeaf, b: TextLeaf): boolean {
  const ab = leafBox(a);
  const bb = leafBox(b);
  if (!ab || !bb) return false;
  const ac = ab.y + ab.height / 2;
  const bc = bb.y + bb.height / 2;
  return Math.abs(ac - bc) <= Math.max(4, Math.min(ab.height || 0, bb.height || 0) * 0.35);
}

function textLeafScore(leaf: TextLeaf): number {
  const vp = canonicalViewportFor(leaf.node);
  const cs = leaf.node.computedByVp[vp];
  const b = leaf.node.bboxByVp[vp];
  const fontSize = cssPx(cs?.fontSize);
  const fontWeight = cssPx(cs?.fontWeight);
  const area = b ? Math.min(12000, Math.max(0, b.width * b.height)) / 300 : 0;
  const headingLike = /^h[1-6]$/.test(leaf.node.tag) || leaf.ancestorTags.some((tag) => /^h[1-6]$/.test(tag));
  const tagBoost = headingLike ? 120 : leaf.node.tag === "p" ? 10 : 0;
  const weightBoost = Math.max(0, fontWeight - 400) / 20;
  const lengthBoost = Math.min(leaf.text.length, 90) / 4;
  return tagBoost + fontSize * 2 + weightBoost + lengthBoost + area;
}

function isDateCompanion(date: TextLeaf | undefined, leaf: TextLeaf): boolean {
  return !!date
    && leaf.index > date.index
    && leaf.index <= date.index + 3
    && sameTextRow(date, leaf)
    && leaf.text.length <= 40
    && !isDateText(leaf.text, leaf)
    && !isReadTimeText(leaf.text)
    && !isStatText(leaf.text);
}

function selectVariantTextFields(root: IRNode): Map<string, string> {
  const leaves = collectVisibleTextLeaves(root);
  const fields = new Map<string, string>();
  const used = new Set<number>();
  const set = (field: string, leaf: TextLeaf | undefined): void => {
    if (!leaf || fields.has(field) || used.has(leaf.index)) return;
    fields.set(field, leaf.text);
    used.add(leaf.index);
  };

  const date = leaves.find((l) => isDateText(l.text, l));
  set("date", date);
  const readTime = leaves.find((l) => isReadTimeText(l.text));
  const stat = [...leaves].reverse().find((l) => isStatText(l.text));
  set("stat", stat);
  const price = [...leaves].reverse().find((l) => isPriceText(l.text));
  set("price", price);
  const badge = leaves.find((l) => isBadgeText(l.text));
  set("badge", badge);
  if (readTime) {
    const author = [...leaves].filter((l) => l.index < readTime.index && !used.has(l.index) && !isMetadataText(l.text, l) && !isCtaText(l.text) && !isDateCompanion(date, l)).pop();
    set("author", author);
    set("readTime", readTime);
  }
  const category = leaves.find((l) => !used.has(l.index) && isDateCompanion(date, l));
  set("category", category);
  const label = leaves.find((l) => !used.has(l.index) && isCtaText(l.text));
  set("label", label);

  const primaryCandidates = leaves.filter((l) =>
    !used.has(l.index)
    && !isCtaText(l.text)
    && !isMetadataText(l.text, l)
    && !isDateCompanion(date, l)
    && l.text.length >= 3
  );
  const title = [...primaryCandidates].sort((a, b) => textLeafScore(b) - textLeafScore(a) || a.index - b.index)[0];
  set("title", title);

  const description = title
    ? [...primaryCandidates]
      .filter((l) => !used.has(l.index) && l.index > title.index && l.text.length >= 12 && /\s/.test(l.text))
      .sort((a, b) => b.text.length - a.text.length || a.index - b.index)[0]
    : undefined;
  set("description", description);

  const eyebrow = title
    ? [...leaves].filter((l) => l.index < title.index && !used.has(l.index) && !isCtaText(l.text) && !isMetadataText(l.text, l) && l.text.length <= 48).pop()
    : undefined;
  set("eyebrow", eyebrow);

  const ordered = new Map<string, string>();
  for (const key of ["eyebrow", "badge", "title", "description", "price", "label", "date", "category", "author", "readTime", "stat"]) {
    const value = fields.get(key);
    if (value !== undefined) ordered.set(key, value);
  }
  return ordered;
}

function replaceStaticTextAll(src: string, literal: string, expr: string): string {
  const bare = escapeRegExp(literal);
  const quoted = escapeRegExp(JSON.stringify(literal));
  return src
    .replace(new RegExp(`(\\n\\s*)${bare}(\\s*\\n)`, "g"), `$1{${expr}}$2`)
    .replace(new RegExp(`(\\n\\s*)\\{${quoted}\\}(\\s*\\n)`, "g"), `$1{${expr}}$2`);
}

function countJsxTags(src: string): number {
  return (src.match(/<[a-zA-Z][a-zA-Z0-9.]*(\s|\/|>)/g) ?? []).length;
}

function variantSlug(text: string, fallback: string, used: Set<string>): string {
  const base = (text || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || fallback;
  let out = base;
  let i = 2;
  while (used.has(out)) out = `${base}-${i++}`;
  used.add(out);
  return out;
}

function textFieldForValues(rows: Array<Map<string, string>>, values: string[]): string | undefined {
  const first = rows[0];
  if (!first) return undefined;
  for (const key of first.keys()) {
    if (key === "variant") continue;
    let ok = true;
    for (let i = 0; i < rows.length; i++) {
      const rowValue = rows[i]?.get(key);
      const literal = rowValue ? literalString(rowValue) : null;
      if (literal === null || literal !== normalizeTextValue(values[i] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) return key;
  }
  return undefined;
}

function hasVariantSlotMedia(n: IRNode): boolean {
  if (/^(img|svg|picture|video|canvas|iframe)$/.test(n.tag) || n.rawHTML) return true;
  const vp = canonicalViewportFor(n);
  if (/\burl\(/.test(n.computedByVp[vp]?.backgroundImage ?? "")) return true;
  return elementChildren(n).some(hasVariantSlotMedia);
}

function canVariantSlot(nodes: IRNode[]): boolean {
  if (!nodes.length || !nodes.some(hasVariantSlotMedia)) return false;
  const textLens = nodes.map((n) => normalizeTextValue(textOf(n)).length);
  return Math.max(...textLens) <= 220;
}

type VariantSlot = { name: string; src: string };

function makeVariantSlot(componentName: string, nodes: IRNode[], rows: Array<Map<string, string>>, variants: string[], indent: number, slots: VariantSlot[], assetMap: Map<string, string>, sourceUrl: string, insideInteractive: boolean, ctx: RenderCtx, insideTable: boolean): string {
  const slotName = `${componentName}Slot${slots.length + 1}`;
  const cases = nodes.map((node, i) => {
    let jsx = renderNode(node, assetMap, sourceUrl, 4, insideInteractive, ctx, insideTable);
    for (const [field, value] of rows[i] ?? []) {
      if (field === "variant") continue;
      const literal = literalString(value);
      if (literal) jsx = replaceStaticTextAll(jsx, literal, `d.${field}`);
    }
    return `    case ${JSON.stringify(variants[i] ?? node.id)}:\n      return (\n${jsx}\n      );`;
  }).join("\n");
  slots.push({
    name: slotName,
    src: `function ${slotName}({ d }: { d: ${componentName}Data }) {\n  switch (d.variant) {\n${cases}\n    default:\n      return null;\n  }\n}`,
  });
  return `${"  ".repeat(indent)}<${slotName} d={d} />`;
}

function emitVariantSkeleton(componentName: string, instances: IRNode[], variants: string[], insideInteractive: boolean, indent: number, dataRows: Array<Map<string, string>>, styleRows: Array<Map<string, string>>, cids: CidCollector, gen: FieldGen, styleGen: FieldGen, slots: VariantSlot[], assetMap: Map<string, string>, sourceUrl: string, ctx: RenderCtx, insideTable = false, ancestors: string[] = []): string | null {
  const repr = instances[0]!;
  const tags = instances.map((n) => resolveTag(n, insideInteractive, insideTable));
  if (!tags.every((t) => t === tags[0])) {
    return canVariantSlot(instances) ? makeVariantSlot(componentName, instances, dataRows, variants, indent, slots, assetMap, sourceUrl, insideInteractive, ctx, insideTable) : null;
  }
  const tag = tags[0]!;
  const pad = "  ".repeat(indent);
  const cpad = "  ".repeat(indent + 1);

  if (repr.rawHTML && tag === "svg") {
    const toJsx = (n: IRNode): string => svgInnerToJsx(svgInnerForNode(n, ctx), cpad);
    const inners = instances.map(toJsx);
    const attrs = renderAttrs(fieldedProps(instances, dataRows, styleRows, cids, gen, styleGen, assetMap, sourceUrl, ctx));
    if (!inners.some((s) => s.trim())) return `${pad}<svg${attrs} />`;
    if (inners.every((s) => s === inners[0])) return `${pad}<svg${attrs}>\n${inners[0]}\n${pad}</svg>`;
    return canVariantSlot(instances) ? makeVariantSlot(componentName, instances, dataRows, variants, indent, slots, assetMap, sourceUrl, insideInteractive, ctx, insideTable) : null;
  }

  const children = instances.map((n) => n.children);
  const sameChildCount = children.every((kids) => kids.length === repr.children.length);
  if (!sameChildCount) {
    return canVariantSlot(instances) ? makeVariantSlot(componentName, instances, dataRows, variants, indent, slots, assetMap, sourceUrl, insideInteractive, ctx, insideTable) : null;
  }

  const attrs = renderAttrs(fieldedProps(instances, dataRows, styleRows, cids, gen, styleGen, assetMap, sourceUrl, ctx));
  if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs} />`;

  const childInteractive = insideInteractive || repr.tag === "a" || repr.tag === "button";
  const childTable = insideTable || repr.tag === "table";
  const childParts: string[] = [];
  let runText: string[] | null = null;
  const flushText = () => {
    if (!runText) return;
    const buf = runText;
    runText = null;
    if (ELEMENT_ONLY_PARENTS.has(tag) && buf.every((t) => t.trim() === "")) return;
    if (!buf.some((t) => t.length > 0)) return;
    if (buf.every((t) => t === buf[0])) {
      childParts.push(`${cpad}${jsxText(buf[0]!)}`);
      return;
    }
    const existing = textFieldForValues(dataRows, buf);
    if (existing) {
      childParts.push(`${cpad}{d.${existing}}`);
      return;
    }
    const f = gen.field(textHint(tag, ancestors));
    instances.forEach((_, i) => dataRows[i]!.set(f, escapeText(buf[i]!)));
    childParts.push(`${cpad}{d.${f}}`);
  };

  for (let i = 0; i < repr.children.length; i++) {
    if (isTextChild(repr.children[i]!)) {
      if (!runText) runText = instances.map(() => "");
      instances.forEach((n, k) => { runText![k] += (n.children[i] as IRTextNode).text; });
      continue;
    }
    if (tag === "video" && (repr.children[i] as IRNode).tag === "source") continue;
    if (tag === "video" && (repr.children[i] as IRNode).tag === "track") continue;
    flushText();
    const subNodes = instances.map((n) => n.children[i] as IRNode);
    const sub = emitVariantSkeleton(componentName, subNodes, variants, childInteractive, indent + 1, dataRows, styleRows, cids, gen, styleGen, slots, assetMap, sourceUrl, ctx, childTable, [...ancestors, repr.tag]);
    if (sub === null) return null;
    childParts.push(sub);
  }
  flushText();

  if (childParts.length === 0) return `${pad}<${tag}${attrs} />`;
  return `${pad}<${tag}${attrs}>\n${childParts.join("\n")}\n${pad}</${tag}>`;
}

function sharedVariantComponentSource(name: string, items: IRNode[], variants: string[], dataRows: Array<Map<string, string>>, styleRows: Array<Map<string, string>>, cids: CidCollector, assetMap: Map<string, string>, sourceUrl: string, insideInteractive: boolean, ctx: RenderCtx, insideTable: boolean): string | null {
  const reservedFields = new Set<string>();
  for (const row of dataRows) for (const key of row.keys()) reservedFields.add(key);
  const gen = makeFieldGen(reservedFields);
  const styleGen = makeFieldGen();
  const slots: VariantSlot[] = [];
  const skeleton = emitVariantSkeleton(name, items, variants, insideInteractive, 2, dataRows, styleRows, cids, gen, styleGen, slots, assetMap, sourceUrl, ctx, insideTable);
  if (!skeleton || slots.length === 0 || countJsxTags(skeleton) < 3) return null;
  const usesStyles = styleRows.some((m) => m.size > 0);
  const params = usesStyles
    ? `{ d, cids, styles }: { d: ${name}Data; cids: string[]; styles: ${name}Styles }`
    : `{ d, cids }: { d: ${name}Data; cids: string[] }`;
  return `function ${name}(${params}) {\n  return (\n${skeleton}\n  );\n}\n\n${slots.map((s) => s.src).join("\n\n")}`;
}

function registerVariantCardItem(cluster: ComponentCluster, ctx: RenderCtx, assetMap: Map<string, string>, sourceUrl: string, insideInteractive: boolean, insideTable = false): string | null {
  const reg = ctx.components!;
  const clusterId = cluster.rootCids[0]!;
  const nodes = cluster.rootCids.map((cid) => reg.nodeByCid.get(cid));
  if (nodes.some((n) => !n)) { reg.failed.add(clusterId); return null; }
  const items = nodes as IRNode[];
  const base = cluster.recipeKind === "feature-grid" ? "FeatureGridItem" : cluster.recipeKind === "product-grid" ? "ProductCard" : "CardGridItem";
  const n = (reg.nameCounts.get(base) ?? 0) + 1;
  reg.nameCounts.set(base, n);
  const name = n === 1 ? base : `${base}${n}`;
  const dataRows: Array<Map<string, string>> = [];
  const variants: string[] = [];
  const usedVariants = new Set<string>();

  for (const item of items) {
    const fields = selectVariantTextFields(item);
    const variant = variantSlug(fields.get("title") ?? fields.get("eyebrow") ?? "", item.id, usedVariants);
    const row = new Map<string, string>();
    row.set("variant", JSON.stringify(variant));
    variants.push(variant);
    for (const [field, value] of fields) row.set(field, JSON.stringify(value));
    dataRows.push(row);
  }

  const sharedRows: Array<Map<string, string>> = dataRows.map((row) => new Map(row));
  const sharedStyleRows: Array<Map<string, string>> = items.map(() => new Map());
  const sharedCids: CidCollector = { rows: items.map(() => []), k: 0 };
  const shared = sharedVariantComponentSource(name, items, variants, sharedRows, sharedStyleRows, sharedCids, assetMap, sourceUrl, insideInteractive, ctx, insideTable);
  const outputRows = shared ? sharedRows : dataRows;
  const usesStyles = !!shared && sharedStyleRows.some((m) => m.size > 0);
  if (shared) {
    reg.funcDefs.set(name, shared);
  } else {
    const cases: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = dataRows[i]!;
      const variant = variants[i]!;
      let jsx = renderNode(item, assetMap, sourceUrl, 4, insideInteractive, ctx, insideTable);
      for (const [field, valueSrc] of row) {
        if (field === "variant") continue;
        const value = literalString(valueSrc);
        if (value) jsx = replaceStaticTextAll(jsx, value, `d.${field}`);
      }
      cases.push(`    case ${JSON.stringify(variant)}:\n      return (\n${jsx}\n      );`);
    }
    reg.funcDefs.set(name, `function ${name}({ d }: { d: ${name}Data }) {\n  switch (d.variant) {\n${cases.join("\n")}\n    default:\n      return null;\n  }\n}`);
  }

  reg.fieldTypes.set(name, schemaOf(outputRows));
  if (usesStyles) reg.styleFieldTypes.set(name, schemaOf(sharedStyleRows));

  const dc = (reg.dataCounts.get(name) ?? 0) + 1;
  reg.dataCounts.set(name, dc);
  const dataVar = dc === 1 ? `${name}_data` : `${name}_data${dc}`;
  const cidsVar = dc === 1 ? `${name}_cids` : `${name}_cids${dc}`;
  const stylesVar = dc === 1 ? `${name}_styles` : `${name}_styles${dc}`;
  reg.dataDecls.push({
    varName: dataVar,
    compName: name,
    body: `[\n    ${rowsOf(outputRows)}\n]`,
    ...(cluster.dataModel ? { dataModel: cluster.dataModel } : {}),
  });
  if (shared) {
    reg.cidDecls.push({ varName: cidsVar, body: `[\n    ${sharedCids.rows.map((r) => `[${r.join(", ")}]`).join(",\n    ")}\n]` });
    if (usesStyles) reg.styleDecls.push({ varName: stylesVar, compName: name, body: `[\n    ${rowsOf(sharedStyleRows)}\n]` });
  }
  const agg = reg.byName.get(name) ?? { runs: 0, instances: 0, cids: [] };
  agg.runs++; agg.instances += items.length; agg.cids.push(...cluster.rootCids);
  reg.byName.set(name, agg);
  const stylesProp = shared && usesStyles ? ` styles={${stylesVar}[i]}` : "";
  return shared
    ? `{${dataVar}.map((d, i) => <${name} key={d.variant} d={d} cids={${cidsVar}[i]}${stylesProp} />)}`
    : `{${dataVar}.map((d) => <${name} key={d.variant} d={d} />)}`;
}

function registerLogoCloudItem(cluster: ComponentCluster, ctx: RenderCtx, assetMap: Map<string, string>, sourceUrl: string): string | null {
  const reg = ctx.components!;
  const clusterId = cluster.rootCids[0]!;
  const nodes = cluster.rootCids.map((cid) => reg.nodeByCid.get(cid));
  if (nodes.some((n) => !n)) { reg.failed.add(clusterId); return null; }
  const shapes = (nodes as IRNode[]).map(logoCloudShape);
  if (shapes.some((s) => !s)) { reg.failed.add(clusterId); return null; }
  const items = shapes as LogoCloudShape[];

  const name = "LogoCloudItem";
  if (!reg.funcDefs.has(name)) {
    reg.funcDefs.set(name, `function ${name}({ d, cids, styles }: { d: ${name}Data; cids: string[]; styles: ${name}Styles }) {\n  const image = <img className={styles.imgClassName} data-cid={cids[3]} data-component="image" alt={d.alt} height={d.height} src={d.imgSrc} srcSet={d.srcSet} width={d.width} />;\n  return (\n    <div className={styles.rootClassName} data-cid={cids[0]}>\n      {d.href ? (\n        <a className={styles.linkClassName} data-cid={cids[1]} data-component="link" href={d.href} rel={d.rel} target={d.target}>\n          <div className={styles.innerClassName} data-cid={cids[2]}>\n            {image}\n            {d.tooltip ? <div className={styles.tooltipClassName} data-cid={cids[4]}>{d.tooltip}</div> : null}\n          </div>\n        </a>\n      ) : image}\n    </div>\n  );\n}`);
    reg.fieldTypes.set(name, [
      { name: "alt", type: "string", optional: false },
      { name: "height", type: "string", optional: true },
      { name: "href", type: "string", optional: true },
      { name: "imgSrc", type: "string", optional: false },
      { name: "rel", type: "string", optional: true },
      { name: "srcSet", type: "string", optional: true },
      { name: "target", type: "string", optional: true },
      { name: "tooltip", type: "string", optional: true },
      { name: "width", type: "string", optional: true },
    ]);
    reg.styleFieldTypes.set(name, [
      { name: "rootClassName", type: "string", optional: true },
      { name: "linkClassName", type: "string", optional: true },
      { name: "innerClassName", type: "string", optional: true },
      { name: "imgClassName", type: "string", optional: true },
      { name: "tooltipClassName", type: "string", optional: true },
    ]);
  }

  const dataRows: Array<Map<string, string>> = [];
  const styleRows: Array<Map<string, string>> = [];
  const cidRows: string[][] = [];
  for (const s of items) {
    const data = new Map<string, string>();
    const styles = new Map<string, string>();
    const setData = (field: string, value: string | undefined): void => { if (value !== undefined) data.set(field, value); };
    const setStyle = (field: string, node: IRNode | undefined): void => {
      if (!node) return;
      const value = propValue(node, "className", assetMap, sourceUrl, ctx);
      if (value !== undefined) styles.set(field, value);
    };
    setData("alt", propValue(s.img, "alt", assetMap, sourceUrl, ctx) ?? JSON.stringify(""));
    setData("height", propValue(s.img, "height", assetMap, sourceUrl, ctx));
    setData("href", s.link ? propValue(s.link, "href", assetMap, sourceUrl, ctx) : undefined);
    setData("imgSrc", propValue(s.img, "src", assetMap, sourceUrl, ctx) ?? JSON.stringify(""));
    setData("rel", s.link ? propValue(s.link, "rel", assetMap, sourceUrl, ctx) : undefined);
    setData("srcSet", propValue(s.img, "srcSet", assetMap, sourceUrl, ctx));
    setData("target", s.link ? propValue(s.link, "target", assetMap, sourceUrl, ctx) : undefined);
    setData("tooltip", s.tooltip ? JSON.stringify(textOf(s.tooltip)) : undefined);
    setData("width", propValue(s.img, "width", assetMap, sourceUrl, ctx));
    setStyle("rootClassName", s.root);
    setStyle("linkClassName", s.link);
    setStyle("innerClassName", s.inner);
    setStyle("imgClassName", s.img);
    setStyle("tooltipClassName", s.tooltip);
    dataRows.push(data);
    styleRows.push(styles);
    cidRows.push([s.root.id, s.link?.id ?? "", s.inner?.id ?? "", s.img.id, s.tooltip?.id ?? ""].map((id) => JSON.stringify(id)));
  }

  const dc = (reg.dataCounts.get(name) ?? 0) + 1;
  reg.dataCounts.set(name, dc);
  const dataVar = dc === 1 ? `${name}_data` : `${name}_data${dc}`;
  const cidsVar = dc === 1 ? `${name}_cids` : `${name}_cids${dc}`;
  const stylesVar = dc === 1 ? `${name}_styles` : `${name}_styles${dc}`;
  reg.dataDecls.push({
    varName: dataVar,
    compName: name,
    body: `[\n    ${rowsOf(dataRows)}\n]`,
    ...(cluster.dataModel ? { dataModel: cluster.dataModel } : {}),
  });
  reg.cidDecls.push({ varName: cidsVar, body: `[\n    ${cidRows.map((r) => `[${r.join(", ")}]`).join(",\n    ")}\n]` });
  reg.styleDecls.push({ varName: stylesVar, compName: name, body: `[\n    ${rowsOf(styleRows)}\n]` });
  const agg = reg.byName.get(name) ?? { runs: 0, instances: 0, cids: [] };
  agg.runs++; agg.instances += items.length; agg.cids.push(...cluster.rootCids);
  reg.byName.set(name, agg);
  return `{${dataVar}.map((d, i) => <${name} key={i} d={d} cids={${cidsVar}[i]} styles={${stylesVar}[i]} />)}`;
}

/** Build the source for an extracted run — its per-instance data array, plus (only the
 *  first time a given skeleton is seen) a `function <Name>({ d })` — and return the
 *  `{<Name>_dataK.map(...)}` call that replaces the inline run. Runs whose skeleton is
 *  byte-identical share one function (each keeps its own data array), so the page reads
 *  with one reusable component instead of N near-duplicates. Returns null (→ render
 *  inline) if the run can't be emitted as one faithful skeleton (e.g. instances resolve
 *  to different tags). */
function registerComponent(cluster: ComponentCluster, ctx: RenderCtx, assetMap: Map<string, string>, sourceUrl: string, insideInteractive: boolean, insideTable = false): string | null {
  if (cluster.looseRecipe === "logo-cloud-item") return registerLogoCloudItem(cluster, ctx, assetMap, sourceUrl);
  if (cluster.looseRecipe === "variant-card-item") return registerVariantCardItem(cluster, ctx, assetMap, sourceUrl, insideInteractive, insideTable);
  const reg = ctx.components!;
  const clusterId = cluster.rootCids[0]!;
  const nodes = cluster.rootCids.map((cid) => reg.nodeByCid.get(cid));
  if (nodes.some((n) => !n)) { reg.failed.add(clusterId); return null; }
  const instances = nodes as IRNode[];

  const dataRows: Array<Map<string, string>> = instances.map(() => new Map());
  const styleRows: Array<Map<string, string>> = instances.map(() => new Map());
  const cids: CidCollector = { rows: instances.map(() => []), k: 0 };
  const gen = makeFieldGen();
  const styleGen = makeFieldGen();
  let skeleton = emitSkeleton(instances, insideInteractive, 2, dataRows, styleRows, cids, gen, styleGen, assetMap, sourceUrl, ctx, insideTable);
  if (skeleton === null) { reg.failed.add(clusterId); return null; }
  skeleton = semanticizeRecipeFields(cluster, skeleton, dataRows);
  // A node whose className varies routes its per-instance diff to `styles` (kept out of
  // content.ts) and merges it back with cn() — so the skeleton takes a `styles` prop.
  const usesStyles = styleRows.some((m) => m.size > 0);

  // Dedup by the (name-independent) skeleton string: identical shape → one function. Whether
  // the skeleton references `styles` is encoded in the string, so dedup stays consistent.
  let name = reg.skeletonToName.get(skeleton);
  if (!name) {
    const base = cluster.baseName;
    const c = (reg.nameCounts.get(base) ?? 0) + 1;
    reg.nameCounts.set(base, c);
    name = c === 1 ? base : `${base}${c}`;
    reg.skeletonToName.set(skeleton, name);
    const params = usesStyles
      ? `{ d, cids, styles }: { d: ${name}Data; cids: string[]; styles: ${name}Styles }`
      : `{ d, cids }: { d: ${name}Data; cids: string[] }`;
    reg.funcDefs.set(name, `function ${name}(${params}) {\n  return (\n${skeleton}\n  );\n}`);
  }
  // Per-run data array (editable content) + parallel cids (internal plumbing) and, when any
  // node's className varies, styles (per-instance class overrides — styling, not content).
  const dc = (reg.dataCounts.get(name) ?? 0) + 1;
  reg.dataCounts.set(name, dc);
  const dataVar = dc === 1 ? `${name}_data` : `${name}_data${dc}`;
  const cidsVar = dc === 1 ? `${name}_cids` : `${name}_cids${dc}`;
  const stylesVar = dc === 1 ? `${name}_styles` : `${name}_styles${dc}`;
  reg.dataDecls.push({
    varName: dataVar,
    compName: name,
    body: `[\n    ${rowsOf(dataRows)}\n]`,
    ...(cluster.dataModel ? { dataModel: cluster.dataModel } : {}),
  });
  reg.cidDecls.push({ varName: cidsVar, body: `[\n    ${cids.rows.map((r) => `[${r.join(", ")}]`).join(",\n    ")}\n]` });
  if (usesStyles) reg.styleDecls.push({ varName: stylesVar, compName: name, body: `[\n    ${rowsOf(styleRows)}\n]` });
  // Stage 6: record the component's content (and class-override) schema once — shape is
  // fixed across runs.
  if (!reg.fieldTypes.has(name)) reg.fieldTypes.set(name, schemaOf(dataRows));
  if (usesStyles && !reg.styleFieldTypes.has(name)) reg.styleFieldTypes.set(name, schemaOf(styleRows));
  const agg = reg.byName.get(name) ?? { runs: 0, instances: 0, cids: [] };
  agg.runs++; agg.instances += instances.length; agg.cids.push(...cluster.rootCids);
  reg.byName.set(name, agg);
  const stylesProp = usesStyles ? ` styles={${stylesVar}[i]}` : "";
  return `{${dataVar}.map((d, i) => <${name} key={i} d={d} cids={${cidsVar}[i]}${stylesProp} />)}`;
}

/** Infer a component's content schema from its per-instance data rows: the union of
 *  field names in first-seen order, each typed from a present value and marked
 *  optional when absent in some instances (a prop present on only some). */
function schemaOf(dataRows: Array<Map<string, string>>): FieldType[] {
  const order: string[] = [];
  const type = new Map<string, string>();
  const present = new Map<string, number>();
  for (const row of dataRows) {
    for (const [f, v] of row) {
      if (!type.has(f)) { type.set(f, tsTypeOf(v)); order.push(f); }
      present.set(f, (present.get(f) ?? 0) + 1);
    }
  }
  return order.map((name) => ({ name, type: type.get(name)!, optional: (present.get(name) ?? 0) < dataRows.length }));
}

/** The props-object source for an extracted node: each instance's [key,value] list
 *  (via the shared propsList) is reconciled — class/data-cid collapse to one cid data
 *  field, a prop identical across all instances is baked, one that varies (or is
 *  present only in some) becomes a `d.fN` data field. A VARYING className is special-cased
 *  (see below) so styling never lands in the editable content. */
function fieldedProps(instances: IRNode[], dataRows: Array<Map<string, string>>, styleRows: Array<Map<string, string>>, cids: CidCollector, gen: FieldGen, styleGen: FieldGen, assetMap: Map<string, string>, sourceUrl: string, ctx: RenderCtx): Array<[string, string]> {
  const lists = instances.map((n) => propsList(n, assetMap, sourceUrl, ctx));
  // data-cid is the one prop that is ALWAYS per-instance (the grader aligns by it) — kept
  // in the separate `cids` array, NOT the editable content row.
  const idx = takeCid(cids, instances);
  const out: Array<[string, string]> = [['"data-cid"', `cids[${idx}]`]];

  // Reconcile every OTHER prop: identical across instances → bake; varies → a data field.
  // First-seen order, for determinism.
  const order: string[] = [];
  const vals = new Map<string, Array<string | undefined>>();
  lists.forEach((list, i) => {
    for (const [k, v] of list) {
      if (k === '"data-cid"') continue;
      if (!vals.has(k)) { vals.set(k, instances.map(() => undefined)); order.push(k); }
      vals.get(k)![i] = v;
    }
  });
  for (const k of order) {
    if (k === "dangerouslySetInnerHTML") continue; // SVG inner → rendered as a real JSX child in emitSkeleton
    const vv = vals.get(k)!;
    if (vv.every((v) => v !== undefined && v === vv[0])) {
      out.push([k, vv[0]!]); // identical across instances → bake
    } else if (k === "className" || k === "class") {
      // className is STYLING, not content — it must never pollute the editable content
      // (content.ts). When it varies across instances, keep the tokens COMMON to all
      // instances baked into the skeleton and route only the per-instance DIFF to the
      // separate `styles` array (./_styles), merged back with cn(). Token order in the
      // class attribute doesn't affect the computed style (utility precedence is by
      // stylesheet order), so this split renders identically to the source.
      const tokenLists = vv.map((v) => (v === undefined ? [] : parseClassTokens(v)));
      const shared = tokenLists.length
        ? tokenLists.reduce((acc, toks) => acc.filter((t) => toks.includes(t)), tokenLists[0]!.slice())
        : [];
      const sharedSet = new Set(shared);
      const diffs = tokenLists.map((toks) => toks.filter((t) => !sharedSet.has(t)));
      if (diffs.every((d) => d.length === 0)) {
        // Same token SET across all instances (only order/whitespace differed) → bake it;
        // no per-instance override is needed (and no `styles` field is allocated).
        out.push([k, JSON.stringify(shared.join(" "))]);
      } else {
        const f = styleGen.field("className");
        instances.forEach((_, i) => { if (diffs[i]!.length) styleRows[i]!.set(f, JSON.stringify(diffs[i]!.join(" "))); });
        out.push([k, shared.length ? `cn(${JSON.stringify(shared.join(" "))}, styles.${f})` : `styles.${f}`]);
      }
    } else {
      const f = gen.field(propHint(k, instances[0]!.tag));
      instances.forEach((_, i) => { if (vv[i] !== undefined) dataRows[i]!.set(f, vv[i]!); });
      out.push([k, `d.${f}`]);
    }
  }
  return out;
}

/** Emit the JSX skeleton for a set of aligned instance nodes, recording per-instance
 *  varying values into dataRows. Mirrors renderNode's structural decisions (tag
 *  resolution, void/svg handling, text coalescing) so the skeleton renders exactly
 *  what inlining each instance would. Returns null if the instances don't resolve to
 *  a single tag (→ caller falls back to inline). */
function emitSkeleton(instances: IRNode[], insideInteractive: boolean, indent: number, dataRows: Array<Map<string, string>>, styleRows: Array<Map<string, string>>, cids: CidCollector, gen: FieldGen, styleGen: FieldGen, assetMap: Map<string, string>, sourceUrl: string, ctx: RenderCtx, insideTable = false, ancestors: string[] = []): string | null {
  const repr = instances[0]!;
  const tags = instances.map((n) => resolveTag(n, insideInteractive, insideTable));
  if (!tags.every((t) => t === tags[0])) return null;
  const tag = tags[0]!;
  const attrs = renderAttrs(fieldedProps(instances, dataRows, styleRows, cids, gen, styleGen, assetMap, sourceUrl, ctx));
  const pad = "  ".repeat(indent);
  const cpad = "  ".repeat(indent + 1);

  if (repr.rawHTML && tag === "svg") {
    // SVG inner content renders as a REAL JSX child (not a dangerouslySetInnerHTML __html blob).
    // When it's identical across instances, bake it; when it varies, it's a ReactNode field in the
    // content array (which then ships as content.tsx). Mirrors renderNode's standalone-SVG path.
    const toJsx = (n: IRNode): string => svgInnerToJsx(svgInnerForNode(n, ctx), cpad);
    const inners = instances.map(toJsx);
    if (!inners.some((s) => s.trim())) return `${pad}<svg${attrs} />`;
    if (inners.every((s) => s === inners[0])) return `${pad}<svg${attrs}>\n${inners[0]}\n${pad}</svg>`;
    const f = gen.field("icon");
    instances.forEach((n, i) => dataRows[i]!.set(f, `<>\n${inners[i]}\n${cpad}</>`));
    return `${pad}<svg${attrs}>{d.${f}}</svg>`;
  }
  if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs} />`;

  const childInteractive = insideInteractive || repr.tag === "a" || repr.tag === "button";
  const childTable = insideTable || repr.tag === "table";
  const childParts: string[] = [];
  let runText: string[] | null = null; // per-instance coalesced text for the current run
  const flushText = () => {
    if (!runText) return;
    const buf = runText; runText = null;
    if (ELEMENT_ONLY_PARENTS.has(tag) && buf.every((t) => t.trim() === "")) return;
    if (!buf.some((t) => t.length > 0)) return;
    if (buf.every((t) => t === buf[0])) childParts.push(`${cpad}${jsxText(buf[0]!)}`);
    else {
      const f = gen.field(textHint(tag, ancestors));
      instances.forEach((_, i) => dataRows[i]!.set(f, escapeText(buf[i]!)));
      childParts.push(`${cpad}{d.${f}}`);
    }
  };
  const len = repr.children.length;
  for (let i = 0; i < len; i++) {
    if (isTextChild(repr.children[i]!)) {
      if (!runText) runText = instances.map(() => "");
      instances.forEach((n, k) => { runText![k] += (n.children[i] as IRTextNode).text; });
      continue;
    }
    if (tag === "video" && (repr.children[i] as IRNode).tag === "source") continue;
    if (tag === "video" && (repr.children[i] as IRNode).tag === "track") continue;
    flushText();
    const sub = emitSkeleton(instances.map((n) => n.children[i] as IRNode), childInteractive, indent + 1, dataRows, styleRows, cids, gen, styleGen, assetMap, sourceUrl, ctx, childTable, [...ancestors, repr.tag]);
    if (sub === null) return null;
    childParts.push(sub);
  }
  flushText();

  if (childParts.length === 0) return `${pad}<${tag}${attrs} />`;
  return `${pad}<${tag}${attrs}>\n${childParts.join("\n")}\n${pad}</${tag}>`;
}

/** Build the per-module extraction registry from the IR (env-gated by the caller). */
export function buildComponentRegistry(ir: IR, primitives?: Map<string, string>, recipes?: RecipeReport): ComponentRegistry {
  const plan = detectComponents(ir, primitives, recipes);
  const nodeByCid = new Map<string, IRNode>();
  const index = (n: IRNode): void => { nodeByCid.set(n.id, n); for (const c of n.children) if (!isTextChild(c)) index(c); };
  index(ir.root);
  return {
    plan, nodeByCid,
    funcDefs: new Map(), skeletonToName: new Map(), nameCounts: new Map(),
    dataDecls: [], cidDecls: [], styleDecls: [], dataCounts: new Map(), fieldTypes: new Map(), styleFieldTypes: new Map(), byName: new Map(), failed: new Set(),
  };
}

export type ExtractedComponent = { name: string; runs: number; instances: number; rootCids: string[] };

/** The components actually promoted — one entry per UNIQUE component (after skeleton
 *  dedup), with how many runs reuse it, the total instances, and every instance's root
 *  cid (so a visualizer can outline them). Recorded for the manifest / DoD. */
export function summarizeComponents(reg: ComponentRegistry): ExtractedComponent[] {
  return [...reg.byName].map(([name, v]) => ({ name, runs: v.runs, instances: v.instances, rootCids: v.cids }));
}

/** The page-module preamble with data INLINED — component function defs followed by
 *  each run's `const Name_dataK = [...]`. Used by multi-route generation (which keeps
 *  its per-route data inline for now). "" when nothing was extracted. */
export function componentPreamble(reg: ComponentRegistry | undefined): string {
  if (!reg) return "";
  const data = reg.dataDecls.map((d) => `const ${d.varName} = ${d.body};`);
  const cids = reg.cidDecls.map((c) => `const ${c.varName}: string[][] = ${c.body};`);
  const styles = reg.styleDecls.map((s) => `const ${s.varName} = ${s.body};`);
  const fns = [...reg.funcDefs.values()];
  const cn = fns.some((f) => f.includes("cn(")) ? [CN_HELPER] : [];
  const parts = [...cn, ...fns, ...data, ...cids, ...styles];
  return parts.length ? parts.join("\n\n") : "";
}

/** Stage 6: import path for an extracted component module — depth-aware so nested routes
 *  (`clone-site`) resolve up to the shared `components/` folder. */
/** kebab-case file base for a PascalCase component name (the conventional split: files
 *  kebab-case, exports PascalCase). HeroSection → hero-section, MediaCard2 → media-card2. */
export function fileBase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
function svgFileBase(name: string): string {
  return "svg-" + fileBase(name);
}

/** A content var (`Logo3_data`, `TextLink2_data2`) → a clean camelCase prop name
 *  (`logo3Data`, `textLink2Data2`) — used so a section can expose editable data props
 *  that default to the imported arrays without an import-alias collision. */
export function camelVar(v: string): string {
  const c = v.replace(/_(\w)/g, (_m, ch: string) => ch.toUpperCase());
  return c.charAt(0).toLowerCase() + c.slice(1);
}

function cleanPropBase(value: string): string {
  const c = value.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!c) return "";
  return /^[a-zA-Z_$]/.test(c) ? c.charAt(0).toLowerCase() + c.slice(1) : "";
}

function sectionDataPropNames(usedData: string[], reg: ComponentRegistry | undefined): Map<string, string> {
  const byVar = new Map((reg?.dataDecls ?? []).map((d) => [d.varName, d]));
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  for (const v of usedData) {
    const model = byVar.get(v)?.dataModel;
    const base = cleanPropBase(model ?? "");
    if (!base) {
      out.set(v, camelVar(v));
      continue;
    }
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.set(v, n === 1 ? base : `${base}${n}`);
  }
  return out;
}

type ContentBinding = {
  varName: string;
  exportName: string;
  typeName: string;
  compName: string;
  body: string;
  fields: FieldType[];
};

type ContentObjectDecl = {
  exportName: string;
  typeName: string;
  typeSrc: string;
  valueSrc: string;
};

const RESERVED_IDENT = new Set([
  "default", "function", "class", "const", "let", "var", "import", "export",
  "return", "if", "else", "switch", "case", "for", "while", "do", "new",
  "try", "catch", "finally", "throw", "extends", "super",
]);

function safeIdent(value: string, fallback: string): string {
  const raw = value.replace(/[^a-zA-Z0-9_$]/g, "");
  const ident = raw && /^[a-zA-Z_$]/.test(raw) ? raw : fallback;
  return RESERVED_IDENT.has(ident) ? `${ident}Data` : ident;
}

function pascalIdent(value: string, fallback: string): string {
  const ident = safeIdent(value, fallback);
  return ident.charAt(0).toUpperCase() + ident.slice(1);
}

function hasJsxDataValue(decl: ComponentRegistry["dataDecls"][number]): boolean {
  return /\b\w+:\s*</.test(decl.body);
}

const NORMALIZED_TEXT_CONTENT_FIELDS = new Set([
  "alt", "ariaLabel", "author", "category", "description", "eyebrow",
  "badge", "label", "price", "readTime", "stat", "title", "tooltip",
]);

function normalizeTextContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeContentBody(body: string, fields: FieldType[]): string {
  const textFields = new Set(fields.filter((f) => NORMALIZED_TEXT_CONTENT_FIELDS.has(f.name)).map((f) => f.name));
  if (!textFields.size) return body;
  return body.replace(/\b([a-zA-Z_$][\w$]*)\s*:\s*("(?:[^"\\]|\\.)*")/g, (match, field: string, literal: string) => {
    if (!textFields.has(field)) return match;
    try {
      const value = JSON.parse(literal) as unknown;
      if (typeof value !== "string") return match;
      const normalized = normalizeTextContent(value);
      return `${field}: ${JSON.stringify(normalized)}`;
    } catch {
      return match;
    }
  });
}

function shouldExportContentDecl(decl: ComponentRegistry["dataDecls"][number], fields: FieldType[]): boolean {
  if (decl.dataModel) return true;
  if (!fields.length) return false;
  const names = fields.map((f) => f.name);
  if (names.some((n) => /(?:^|_)className$/.test(n) || n === "style")) return false;
  if (names.some((n) => /^(?:text|label|value)\d+$/.test(n))) return false;
  const allowed = new Set([
    "alt", "ariaLabel", "author", "category", "date", "dateTime", "description",
    "badge", "height", "href", "href2", "imgSrc", "label", "poster", "price",
    "readTime", "rel", "salePrice", "src", "srcSet", "stat", "target", "title",
    "tooltip", "variant", "width",
  ]);
  return names.every((n) => allowed.has(n));
}

function buildContentBindings(reg: ComponentRegistry | undefined): Map<string, ContentBinding> {
  const out = new Map<string, ContentBinding>();
  if (!reg) return out;
  const counts = new Map<string, number>();
  const used = new Set<string>();
  const unique = (base: string): string => {
    let name = safeIdent(base, "content");
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    if (n > 1) name = `${name}${n}`;
    while (used.has(name)) {
      const next = (counts.get(base) ?? n) + 1;
      counts.set(base, next);
      name = `${base}${next}`;
    }
    used.add(name);
    return name;
  };
  for (const decl of reg.dataDecls) {
    // JSX fragments need a TSX content module. Keep those colocated for now so content.ts
    // stays parse-simple and high-signal.
    if (hasJsxDataValue(decl)) continue;
    const fields = reg.fieldTypes.get(decl.compName) ?? [];
    if (!shouldExportContentDecl(decl, fields)) continue;
    const base = cleanPropBase(decl.dataModel ?? "") || camelVar(decl.varName);
    const exportName = unique(base);
    out.set(decl.varName, {
      varName: decl.varName,
      exportName,
      typeName: `${pascalIdent(exportName, "Content")}Item`,
      compName: decl.compName,
      body: decl.body,
      fields,
    });
  }
  return out;
}

function contentModule(reg: ComponentRegistry | undefined, objectDecls: ContentObjectDecl[] = []): string {
  const bindings = [...buildContentBindings(reg).values()];
  if (!bindings.length && !objectDecls.length) return "";
  const out: string[] = [
    "// Semantic page content extracted from recognized recipe sections.",
    "",
  ];
  for (const b of bindings) {
    const fields = b.fields.length
      ? b.fields.map((f) => `  ${f.name}${f.optional ? "?" : ""}: ${f.type};`).join("\n")
      : "  [key: string]: unknown;";
    out.push(`export type ${b.typeName} = {\n${fields}\n};`);
    out.push(`export const ${b.exportName}: ${b.typeName}[] = ${normalizeContentBody(b.body, b.fields)};`);
    out.push("");
  }
  for (const d of objectDecls) {
    out.push(d.typeSrc);
    out.push(`export const ${d.exportName}: ${d.typeName} = ${d.valueSrc};`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function componentImportPath(name: string, depth = 0): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "components/" + fileBase(name);
}

/** Colocated content: the `const Name_dataK: NameData[] = [...]` declarations for the data vars a
 *  module uses. The data lives in the module that renders it (a section, or the page) — its type
 *  comes from the component that consumes it (merged into that component's default import, since a
 *  data array and its `<Name>` render site always travel into the same module). Returns the consts
 *  plus the set of component names whose `Name` import should carry `{ type NameData }`. */
function inlineData(usedData: string[], reg: ComponentRegistry | undefined): { consts: string[]; typeForComp: Set<string> } {
  const byVar = new Map((reg?.dataDecls ?? []).map((d) => [d.varName, d]));
  const consts: string[] = [];
  const typeForComp = new Set<string>();
  for (const v of usedData) {
    const d = byVar.get(v);
    if (!d) continue;
    typeForComp.add(d.compName);
    consts.push(`const ${v}: ${d.compName}Data[] = ${d.body};`);
  }
  return { consts, typeForComp };
}

/** Stage 6: each extracted component as its own standalone module (default export), so the
 *  clone ships one editable file per component under `components/` instead of a wall of
 *  inline defs in page.tsx. The function bodies are self-contained — they read only their
 *  `d` prop — so no per-file imports are needed. "" list when nothing was extracted. */
/** A short human description of an extracted component, from its name. */
function describeComponent(name: string): string {
  const base = name.replace(/\d+$/, "");
  const map: Record<string, string> = {
    NavLink: "A navigation link.", TextLink: "A text link.", CardLink: "A linked card.",
    MediaLink: "A linked media tile.", Logo: "A logo.", FeatureCard: "A feature card.",
    ProductCard: "A product card.", Card: "A card.", MediaCard: "A card with media + heading.", ProfileCard: "A profile/person card.",
    MediaTile: "A media tile.", ListRow: "A list row.", Tile: "A content tile.",
  };
  return map[base] ?? `${base.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} component.`;
}

export function componentFiles(reg: ComponentRegistry | undefined, svgs?: SvgRegistry): Array<{ name: string; module: string }> {
  if (!reg || reg.funcDefs.size === 0) return [];
  return [...reg.funcDefs].map(([name, src]) => {
    const agg = reg.byName.get(name);
    void agg;
    const header = `/** ${describeComponent(name)} */`;
    const cnDef = src.includes("cn(") ? CN_HELPER + "\n" : "";
    // The component's props-data type is DEFINED here (colocated), not imported from a central content
    // file — and exported so the section that supplies the data can type its array. Per-instance class
    // overrides still come from _styles.ts (pure styling plumbing).
    const typeImports: string[] = [];
    const fields = reg.fieldTypes.get(name) ?? [];
    let typeDef = "";
    if (src.includes(`${name}Data`)) {
      if (fields.some((f) => /\bReactNode\b/.test(f.type))) typeImports.push(`import type { ReactNode } from "react";`);
      typeDef = fields.length
        ? `export type ${name}Data = {\n${fields.map((f) => `  ${f.name}${f.optional ? "?" : ""}: ${f.type};`).join("\n")}\n};\n`
        : `export type ${name}Data = Record<string, never>;\n`;
    }
    if (src.includes(`${name}Styles`)) typeImports.push(`import type { ${name}Styles } from "../_styles";`);
    const svgImports: string[] = [];
    for (const c of scanRefs(src).comps) {
      if (svgs?.defs.has(c)) svgImports.push(`import ${c} from "../svgs/${svgFileBase(c)}";`);
    }
    const imports = [...typeImports, ...svgImports];
    const importBlock = imports.length ? imports.join("\n") + "\n" : "";
    return { name, module: `${importBlock}${typeDef}${header}\n${cnDef}export default ${src}\n` };
  });
}

/** Stage 6: the `import Name from "./components/Name"` lines for the page module, one per
 *  extracted component. "" when nothing was extracted. */
export function componentImports(reg: ComponentRegistry | undefined, depth = 0): string {
  if (!reg || reg.funcDefs.size === 0) return "";
  return [...reg.funcDefs.keys()].map((name) => `import ${name} from "${componentImportPath(name, depth)}";`).join("\n");
}

/** The per-run `const Name_dataK = [...]` decls only (no function defs) — for `clone-site`,
 *  which splits component functions into files but keeps each route's data inline in its
 *  page module. "" when nothing was extracted. */
export function componentDataDecls(reg: ComponentRegistry | undefined): string {
  if (!reg || reg.dataDecls.length === 0) return "";
  const data = reg.dataDecls.map((d) => `const ${d.varName} = ${d.body};`);
  const cids = reg.cidDecls.map((c) => `const ${c.varName}: string[][] = ${c.body};`);
  const styles = reg.styleDecls.map((s) => `const ${s.varName} = ${s.body};`);
  return [...data, ...cids, ...styles].join("\n");
}

/** The internal data-cid arrays module (`_cids.ts`) — one `string[][]` per run, kept out
 *  of the editable content module so content.ts stays purely semantic. */
export function componentCidsModule(reg: ComponentRegistry | undefined): string {
  if (!reg || reg.cidDecls.length === 0) return "";
  const out: string[] = [
    "// Per-instance node ids, kept out of content.ts so the content stays semantic.",
    "",
  ];
  for (const c of reg.cidDecls) out.push(`export const ${c.varName}: string[][] = ${c.body};`);
  return out.join("\n") + "\n";
}

/** The internal per-instance class-override module (`_styles.ts`) — one typed array per run
 *  holding the className diffs a component's nodes vary by. The component bakes the classes
 *  common to all instances into its skeleton and merges these per-instance diffs back with
 *  cn(); styling lives here (not content.ts) so the editable content stays semantic. ""
 *  when no extracted node had a varying className. */
export function componentStylesModule(reg: ComponentRegistry | undefined): string {
  if (!reg || reg.styleDecls.length === 0) return "";
  const out: string[] = [
    "// Per-instance class overrides, merged onto each component's shared base classes with cn().",
    "",
  ];
  for (const [name, fields] of reg.styleFieldTypes) {
    const body = fields.map((f) => `  ${f.name}${f.optional ? "?" : ""}: ${f.type};`).join("\n");
    out.push(`export type ${name}Styles = {\n${body}\n};`);
  }
  out.push("");
  for (const s of reg.styleDecls) out.push(`export const ${s.varName}: ${s.compName}Styles[] = ${s.body};`);
  return out.join("\n") + "\n";
}

// ---------- Section split: per-module imports + file emission ----------

const COMP_TAG_RE = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
const DATA_VAR_RE = /\b(\w+_data\d*)\b/g;
const CID_VAR_RE = /\b(\w+_cids\d*)\b/g;
const STYLE_VAR_RE = /\b(\w+_styles\d*)\b/g;
/** Component identifiers + data/cid/style array vars referenced by a module's JSX, in
 *  first-seen (document) order — so a section/page module imports only what it actually uses. */
function scanRefs(jsx: string): { comps: string[]; dataVars: string[]; cidVars: string[]; styleVars: string[] } {
  const comps: string[] = [], dataVars: string[] = [], cidVars: string[] = [], styleVars: string[] = [];
  const cs = new Set<string>(), ds = new Set<string>(), cd = new Set<string>(), st = new Set<string>();
  let m: RegExpExecArray | null;
  COMP_TAG_RE.lastIndex = 0; while ((m = COMP_TAG_RE.exec(jsx)) !== null) if (!cs.has(m[1]!)) { cs.add(m[1]!); comps.push(m[1]!); }
  DATA_VAR_RE.lastIndex = 0; while ((m = DATA_VAR_RE.exec(jsx)) !== null) if (!ds.has(m[1]!)) { ds.add(m[1]!); dataVars.push(m[1]!); }
  CID_VAR_RE.lastIndex = 0; while ((m = CID_VAR_RE.exec(jsx)) !== null) if (!cd.has(m[1]!)) { cd.add(m[1]!); cidVars.push(m[1]!); }
  STYLE_VAR_RE.lastIndex = 0; while ((m = STYLE_VAR_RE.exec(jsx)) !== null) if (!st.has(m[1]!)) { st.add(m[1]!); styleVars.push(m[1]!); }
  return { comps, dataVars, cidVars, styleVars };
}

/** Import lines for the extracted components + SVGs + their data (content) + cids
 *  (internal) arrays a module's JSX uses (depth = levels below `src/app`). */
function buildRefImports(jsx: string, reg: ComponentRegistry | undefined, depth: number, svgs?: SvgRegistry): string {
  const { comps, dataVars, cidVars, styleVars } = scanRefs(jsx);
  const up = depth === 0 ? "./" : "../".repeat(depth);
  const knownData = new Set(reg?.dataDecls.map((d) => d.varName) ?? []);
  const usedData = dataVars.filter((v) => knownData.has(v));
  const { consts, typeForComp } = inlineData(usedData, reg);
  const lines: string[] = [];
  for (const c of comps) {
    if (reg?.funcDefs.has(c)) {
      const t = typeForComp.has(c) ? `, { type ${c}Data }` : "";
      lines.push(`import ${c}${t} from "${componentImportPath(c, depth)}";`);
    } else if (svgs?.defs.has(c)) lines.push(`import ${c} from "${up}svgs/${svgFileBase(c)}";`);
  }
  if (!reg) return lines.join("\n");
  const knownCids = new Set(reg.cidDecls.map((c) => c.varName));
  const usedCids = cidVars.filter((v) => knownCids.has(v));
  if (usedCids.length) lines.push(`import { ${usedCids.join(", ")} } from "${up}_cids";`);
  const knownStyles = new Set(reg.styleDecls.map((s) => s.varName));
  const usedStyles = styleVars.filter((v) => knownStyles.has(v));
  if (usedStyles.length) lines.push(`import { ${usedStyles.join(", ")} } from "${up}_styles";`);
  // Colocated content: the page's own data arrays as typed consts, after all imports.
  return lines.join("\n") + (consts.length ? "\n\n" + consts.join("\n") : "");
}

/** `import HeroSection from "./sections/HeroSection"` lines for the page module. */
function sectionImports(order: string[], depth = 0): string {
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  return order.map((n) => `import ${n} from "${prefix}sections/${fileBase(n)}";`).join("\n");
}

/** A short human description of a section, from its name — for the file doc header
 *  (a developer-facing cue + a metadata signal). */
function describeSection(name: string): string {
  if (name === "Navbar") return "Top navigation bar.";
  if (name === "Footer" || /^Footer\d*$/.test(name)) return "Site footer.";
  if (name === "Header") return "Page header.";
  if (/^HeroSection/.test(name)) return "Hero section — the page's lead block.";
  const words = name.replace(/Section\d*$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? `${words} section.` : "Page section.";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function staticJsxTexts(block: string): string[] {
  const out: string[] = [];
  const re = /\n(\s*)([^<>{}\n][^<>{}\n]*?\S)\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const text = (m[2] ?? "").trim();
    if (!text || /^[→⤓·|]+$/.test(text)) continue;
    out.push(text);
  }
  return out;
}

function replaceFirstStaticText(src: string, literal: string, expr: string): string {
  const re = new RegExp(`(\\n\\s*)${escapeRegExp(literal)}(\\s*\\n)`);
  return src.replace(re, `$1{${expr}}$2`);
}

function ctaContentTemplate(sectionName: string, jsx: string): { body: string; decl: ContentObjectDecl; param: string } | null {
  if (!/^Cta/.test(sectionName)) return null;
  let body = jsx;
  const exportName = safeIdent(cleanPropBase(`${sectionName}Content`), "ctaContent");
  const typeName = `${pascalIdent(exportName, "CtaContent")}`;
  const heading = body.match(/<h[1-6]\b[\s\S]*?<\/h[1-6]>/);
  const title = heading ? staticJsxTexts(heading[0])[0] : undefined;
  if (title) body = replaceFirstStaticText(body, title, "content.title");

  const actions: Array<{ label: string; href: string; ariaLabel?: string }> = [];
  body = body.replace(/<a\b[\s\S]*?<\/a>/g, (block) => {
    const href = /href="([^"]*)"/.exec(block)?.[1];
    const label = staticJsxTexts(block)[0];
    if (!href || !label) return block;
    const index = actions.length;
    const ariaLabel = /aria-label="([^"]*)"/.exec(block)?.[1];
    actions.push({ label, href, ...(ariaLabel && ariaLabel !== label ? { ariaLabel } : {}) });
    let next = block.replace(`href=${JSON.stringify(href)}`, `href={content.actions[${index}].href}`);
    if (ariaLabel) next = next.replace(`aria-label=${JSON.stringify(ariaLabel)}`, `aria-label={content.actions[${index}].ariaLabel ?? content.actions[${index}].label}`);
    next = replaceFirstStaticText(next, label, `content.actions[${index}].label`);
    return next;
  });

  if (!title && actions.length === 0) return null;
  const actionType = `export type ${typeName}Action = {\n  label: string;\n  href: string;\n  ariaLabel?: string;\n};`;
  const contentType = `export type ${typeName} = {\n  title?: string;\n  actions: ${typeName}Action[];\n};`;
  return {
    body,
    decl: {
      exportName,
      typeName,
      typeSrc: `${actionType}\n\n${contentType}`,
      valueSrc: JSON.stringify({ ...(title ? { title } : {}), actions }, null, 2),
    },
    param: `content = ${exportName}`,
  };
}

/** Each hoisted section as its own editable module (default export). The section's data
 *  arrays become props that DEFAULT to the content.ts arrays — so the section is drop-in
 *  editable (pass your own data to override) while still rendering the captured content by
 *  default. Imports only what the section uses. Render-identical to the inlined subtree. */
export function sectionFiles(sreg: SectionRegistry | undefined, reg: ComponentRegistry | undefined, svgs?: SvgRegistry): { files: Array<{ name: string; module: string }>; contentDecls: ContentObjectDecl[] } {
  if (!sreg) return { files: [], contentDecls: [] };
  const contentBindings = buildContentBindings(reg);
  const contentDecls: ContentObjectDecl[] = [];
  const files = sreg.order.map((name) => {
    const jsx = sreg.modules.get(name) ?? "";
    const { comps, dataVars, cidVars, styleVars } = scanRefs(jsx);
    const knownData = new Set(reg?.dataDecls.map((d) => d.varName) ?? []);
    const usedData = dataVars.filter((v) => knownData.has(v));
    const inlineVars = usedData.filter((v) => !contentBindings.has(v));
    const { consts, typeForComp } = inlineData(inlineVars, reg);
    const lines: string[] = [];
    for (const c of comps) {
      if (reg?.funcDefs.has(c)) {
        const t = typeForComp.has(c) ? `, { type ${c}Data }` : "";
        lines.push(`import ${c}${t} from "${componentImportPath(c, 1)}";`);
      } else if (svgs?.defs.has(c)) lines.push(`import ${c} from "../svgs/${svgFileBase(c)}";`);
    }
    const knownCids = new Set(reg?.cidDecls.map((c) => c.varName) ?? []);
    const usedCids = cidVars.filter((v) => knownCids.has(v));
    const knownStyles = new Set(reg?.styleDecls.map((s) => s.varName) ?? []);
    const usedStyles = styleVars.filter((v) => knownStyles.has(v));
    if (usedCids.length) lines.push(`import { ${usedCids.join(", ")} } from "../_cids";`);
    if (usedStyles.length) lines.push(`import { ${usedStyles.join(", ")} } from "../_styles";`);
    const dataProps = sectionDataPropNames(usedData, reg);
    const contentImports: string[] = [];
    const dataParamParts: string[] = [];
    let body = jsx;
    for (const v of usedData) {
      const p = dataProps.get(v) ?? camelVar(v);
      if (p !== v) body = body.split(`${v}.map(`).join(`${p}.map(`);
      const binding = contentBindings.get(v);
      if (binding) {
        const alias = safeIdent(`${p}Content`, "contentData");
        contentImports.push(`${binding.exportName} as ${alias}`);
        dataParamParts.push(`${p} = ${alias}`);
      } else {
        dataParamParts.push(`${p} = ${v}`);
      }
    }
    const cta = ctaContentTemplate(name, body);
    if (cta) {
      body = cta.body;
      contentDecls.push(cta.decl);
      contentImports.push(cta.decl.exportName);
    }
    if (contentImports.length) lines.push(`import { ${contentImports.join(", ")} } from "../content";`);
    // Colocated content: the section's data arrays as typed consts, exposed as camelCase props that
    // default to them — so the section is drop-in editable (pass your own data to override) without a
    // central content file. Class-override arrays (styling plumbing) import straight from _styles.
    const paramParts = [
      ...dataParamParts,
      ...(cta ? [cta.param] : []),
    ];
    const params = paramParts.length ? `{ ${paramParts.join(", ")} } = {}` : "";
    const header = `/** ${describeSection(name)} */`;
    const importBlock = lines.length ? lines.join("\n") + "\n" : "";
    const allConsts = consts;
    const constBlock = allConsts.length ? allConsts.join("\n") + "\n" : "";
    const module = `${importBlock}${constBlock}${header}\nexport default function ${name}(${params}) {\n  return (\n${body}\n  );\n}\n`;
    return { name, module };
  });
  return { files, contentDecls };
}

export function generatePageTsx(ir: IR, assetMap: Map<string, string>, sourceUrl: string, ctx?: RenderCtx, wires?: RuntimeSpec[], motionSpec?: MotionSpec, menus?: RTMenu[], accordions?: AccordionRuntimeSpec[]): string {
  // page renders the body's children; the <body> element itself (c0) is rendered
  // by layout so cid alignment is preserved.
  const hasWires = !!wires && wires.length > 0;
  const hasMotion = !!motionSpec && motionHasContent(motionSpec);
  const hasMenus = !!menus && menus.length > 0;
  const hasAccordions = !!accordions && accordions.length > 0;
  const wiresBlock = hasWires ? "\n" + wiresJsx(wires!, 3) : "";
  const motionBlock = hasMotion ? "\n" + motionWireJsx(motionSpec!, 3) : "";
  const menusBlock = hasMenus ? "\n" + menusJsx(menus!, 3) : "";
  const accordionBlock = hasAccordions ? "\n" + accordionJsx(accordions!, 3) : "";
  // Render the body first so component extraction populates the registry, then import
  // each extracted component from its own `components/Name` module (written by
  // generateApp) and its data from the editable ./content module (Stage 6).
  const body = renderChildrenJsx(ir.root.children, assetMap, sourceUrl, 3, ctx);
  // Import the section components (when split) + only the extracted components/data/cids
  // the page composes DIRECTLY (the rest are imported by the section modules). buildRefImports
  // scans the rendered body, so it works whether or not the page was split into sections.
  const compImports = [
    ctx?.sections ? sectionImports(ctx.sections.order, 0) : "",
    buildRefImports(body, ctx?.components, 0, ctx?.svgs),
  ];
  const imports = [
    hasWires ? `import DittoWire from "${dittoWireImportPath(0)}";` : "",
    hasAccordions ? `import Accordion from "${accordionImportPath(0)}";` : "",
    hasMotion ? `import DittoMotion from "${dittoMotionImportPath(0)}";` : "",
    hasMenus ? `import DropdownMenu from "${dropdownMenuImportPath(0)}";` : "",
    ...compImports,
  ].filter(Boolean).join("\n");
  const importBlock = imports ? imports + "\n\n" : "";
  return `${importBlock}export default function Page() {
  return (
    <>
${body}${wiresBlock}${accordionBlock}${motionBlock}${menusBlock}
    </>
  );
}
`;
}

/** SEO scaffolding (Next App Router): robots.ts + sitemap.ts + an llms.txt route, generated
 *  from the captured URL / title / description — the discovery files a real site ships. */
function seoFiles(ir: IR): Array<[string, string]> {
  let origin = "https://example.com";
  try { origin = new URL(ir.doc.sourceUrl).origin; } catch { /* keep default */ }
  const url = ir.doc.sourceUrl || origin + "/";
  const title = ir.doc.title || "Home";
  const desc = ir.doc.head?.description || "";
  const robots = `import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: ${JSON.stringify(origin + "/sitemap.xml")},
  };
}
`;
  const sitemap = `import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: ${JSON.stringify(url)}, changeFrequency: "weekly", priority: 1 }];
}
`;
  const llmsText = [`# ${title}`, ...(desc ? ["", `> ${desc}`] : []), "", "## Pages", "", `- [${title}](${url})`, ""].join("\n");
  const llms = `export const dynamic = "force-static";

export function GET() {
  return new Response(${JSON.stringify(llmsText)}, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
`;
  return [["robots.ts", robots], ["sitemap.ts", sitemap], [join("llms.txt", "route.ts"), llms]];
}

function generateLayoutTsx(ir: IR, bodyClass?: string, seo?: SeoInventory): string {
  const lang = ir.doc.lang || "en";
  const title = ir.doc.title || "Cloned Page";
  const bodyId = ir.root.id; // body is the IR root; its class/cid must match the IR
  const cls = bodyClass ?? "c" + bodyId;
  const bodyAttrs = renderAttrs(cls ? [["className", JSON.stringify(cls)], ['"data-cid"', JSON.stringify(bodyId)]] : [['"data-cid"', JSON.stringify(bodyId)]]);
  const metadata = seo ? metadataExport(seo) : `export const metadata = { title: ${JSON.stringify(title)} };\n`;
  const viewport = seo ? viewportExport(seo) : `export const viewport = { width: "device-width", initialScale: 1 };\n`;
  const jsonLd = seo ? jsonLdHeadMarkup(seo, 8) : "";
  const head = jsonLd ? `      <head>\n${jsonLd}\n      </head>\n` : "";
  return `import "./globals.css";
import "./ditto.css";
import type { ReactNode } from "react";

${metadata}${viewport}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={${JSON.stringify(lang)}}>
${head}      <body${bodyAttrs}>
        {children}
      </body>
    </html>
  );
}
`;
}

function generateGlobalsCss(ir: IR, fontGraph: FontGraph, tokensCss: string): string {
  const cw = ir.doc.canonicalViewport;
  const pv = ir.doc.perViewport[cw];
  const htmlBg = pv?.htmlBg && pv.htmlBg !== "rgba(0, 0, 0, 0)" ? pv.htmlBg : (pv?.bodyBg ?? "#ffffff");
  // If the SOURCE page never scrolls horizontally (its scrollWidth fits the
  // viewport at every captured width), neither should the clone. JS-driven
  // widgets (custom-element carousels, sliders) position children off-axis via
  // script we don't reproduce, so replaying their computed grid/flex placement can
  // push content past the viewport — a clone-only horizontal scrollbar the source
  // doesn't have (casper/resend/glossier). Clip it at the page box. `clip` (not
  // `hidden`) doesn't create a scroll container, so position:sticky still works.
  const noHScroll = Object.entries(ir.doc.perViewport).every(([vp, d]) => d.scrollWidth <= Number(vp) * 1.03);
  const clip = noHScroll ? "\nhtml, body { overflow-x: clip; }" : "";
  return `${RESET_CSS}
/* fonts */
${fontGraph.css}

/* tokens */
${tokensCss}

/* page base */
html { background: ${htmlBg}; }
body { font-family: ${SYSTEM_FALLBACK}; }${clip}
`;
}

function sourceRoot(appDir: string, framework: AppFramework): string {
  return framework === "next" ? join(appDir, "src", "app") : join(appDir, "src");
}

export function viteGlobalsCss(css: string): string {
  return css + "\n#root { display: contents; }\n";
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlAttr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${htmlEscape(value)}"` : "";
}

function headTagsFromSeo(seo: SeoInventory | undefined, fallback: { title: string; description?: string }): string {
  const title = seo?.title || fallback.title || "Cloned Page";
  const description = seo?.description || fallback.description || "";
  const lines: string[] = [
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${htmlEscape(title)}</title>`,
  ];
  if (description) lines.push(`    <meta name="description" content="${htmlEscape(description)}" />`);
  if (seo?.keywords) lines.push(`    <meta name="keywords" content="${htmlEscape(seo.keywords)}" />`);
  if (seo?.robots) lines.push(`    <meta name="robots" content="${htmlEscape(seo.robots)}" />`);
  if (seo?.referrer) lines.push(`    <meta name="referrer" content="${htmlEscape(seo.referrer)}" />`);
  if (seo?.themeColor) lines.push(`    <meta name="theme-color" content="${htmlEscape(seo.themeColor)}" />`);
  if (seo?.colorScheme) lines.push(`    <meta name="color-scheme" content="${htmlEscape(seo.colorScheme)}" />`);
  if (seo?.canonicalUrl) lines.push(`    <link rel="canonical" href="${htmlEscape(seo.canonicalUrl)}" />`);
  for (const alt of seo?.alternates ?? []) {
    lines.push(`    <link rel="alternate" hreflang="${htmlEscape(alt.hrefLang)}" href="${htmlEscape(alt.href)}" />`);
  }
  for (const icon of seo?.icons ?? []) {
    const attrs = [
      `rel="${htmlEscape(icon.rel)}"`,
      `href="${htmlEscape(icon.localPath || icon.href)}"`,
      icon.type ? `type="${htmlEscape(icon.type)}"` : "",
      icon.sizes ? `sizes="${htmlEscape(icon.sizes)}"` : "",
      icon.media ? `media="${htmlEscape(icon.media)}"` : "",
      icon.color ? `color="${htmlEscape(icon.color)}"` : "",
    ].filter(Boolean).join(" ");
    lines.push(`    <link ${attrs} />`);
  }
  if (seo?.manifest) lines.push(`    <link rel="manifest" href="${htmlEscape(seo.manifest.localPath || seo.manifest.href)}" />`);
  for (const entry of seo?.openGraph ?? []) {
    lines.push(`    <meta property="${htmlEscape(entry.property)}" content="${htmlEscape(entry.content)}" />`);
  }
  for (const entry of seo?.twitter ?? []) {
    lines.push(`    <meta name="${htmlEscape(entry.name)}" content="${htmlEscape(entry.content)}" />`);
  }
  for (const [index, entry] of (seo?.jsonLd ?? []).entries()) {
    const json = entry.text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
    lines.push(`    <script type="application/ld+json" data-ditto-json-ld="${index}">${json}</script>`);
  }
  return lines.join("\n");
}

export function generateViteIndexHtml(opts: {
  lang: string;
  bodyCid: string;
  bodyClass?: string;
  seo?: SeoInventory;
  title: string;
  description?: string;
  entry: string;
}): string {
  const cls = opts.bodyClass ?? "c" + opts.bodyCid;
  const bodyAttrs = `${htmlAttr("class", cls)} data-cid="${htmlEscape(opts.bodyCid)}"`;
  return `<!doctype html>
<html lang="${htmlEscape(opts.lang || "en")}">
  <head>
${headTagsFromSeo(opts.seo, { title: opts.title, description: opts.description })}
  </head>
  <body${bodyAttrs}>
    <div id="root"></div>
    <script type="module" src="${htmlEscape(opts.entry)}"></script>
  </body>
</html>
`;
}

export function generateViteMainTsx(pageImport = "./page", cssImport = "./ditto.css"): string {
  return `import { createRoot } from "react-dom/client";
import "./globals.css";
import ${JSON.stringify(cssImport)};
import Page from ${JSON.stringify(pageImport)};

createRoot(document.getElementById("root")!).render(<Page />);
`;
}

export function generateViteConfig(entries: Array<{ name: string; html: string }>): string {
  const input = entries
    .map((entry) => `      ${JSON.stringify(entry.name)}: fileURLToPath(new URL(${JSON.stringify("./" + entry.html)}, import.meta.url))`)
    .join(",\n");
  return `import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
${input}
      },
    },
  },
});
`;
}

function recipeResponsiveClassCleaner(recipes: RecipeReport | undefined, opts: { tailwind: boolean }): (cid: string, className: string | undefined) => string | undefined {
  const recipeParents = new Set<string>();
  const repeatedGridParents = new Set<string>();
  const fillGridParents = new Set<string>();
  const columnPlans = new Map<string, string[]>();
  const gridColumnTokens = (c: RecipeReport["candidates"][number]): string[] | null => {
    if (c.kind !== "card-grid" && c.kind !== "feature-grid" && c.kind !== "product-grid") return null;
    const regimes = c.responsiveRegimes
      .filter((r) => (r.visibleItems ?? 0) > 0 && (r.columns ?? 0) > 0)
      .sort((a, b) => a.viewport - b.viewport);
    if (regimes.length < 2) return null;
    const prefixFor = (vp: number): string => vp >= 1536 ? "2xl:" : vp >= 1024 ? "lg:" : vp >= 768 ? "md:" : "";
    const tokens: string[] = [];
    let last: number | undefined;
    for (const r of regimes) {
      const columns = Math.max(1, Math.min(r.columns ?? 1, c.itemCount ?? r.columns ?? 1));
      if (last === undefined) {
        tokens.push(`grid-cols-${columns}`);
        last = columns;
        continue;
      }
      if (columns === last) continue;
      const prefix = prefixFor(r.viewport);
      if (prefix) tokens.push(`${prefix}grid-cols-${columns}`);
      else tokens[0] = `grid-cols-${columns}`;
      last = columns;
    }
    return tokens.length >= 1 && new Set(tokens.map((t) => t.replace(/^(?:md|lg|2xl):/, ""))).size >= 1 ? tokens : null;
  };
  for (const c of recipes?.candidates ?? []) {
    if ((c.kind === "card-grid" || c.kind === "feature-grid" || c.kind === "product-grid" || c.kind === "gallery-showcase" || c.kind === "logo-cloud") && c.confidence >= 0.86 && c.itemParentCid) {
      recipeParents.add(c.itemParentCid);
      if (c.kind === "card-grid" || c.kind === "feature-grid" || c.kind === "product-grid" || c.kind === "gallery-showcase") repeatedGridParents.add(c.itemParentCid);
      if (c.kind === "card-grid" || c.kind === "feature-grid" || c.kind === "product-grid") fillGridParents.add(c.itemParentCid);
      const columns = gridColumnTokens(c);
      if (columns) columnPlans.set(c.itemParentCid, columns);
    }
  }
  return (cid, className) => {
    if (!className || !recipeParents.has(cid)) return className;
    const tokens = className.split(/\s+/).filter(Boolean);
    const tokenSet = new Set(tokens);
    const columnPlan = opts.tailwind ? columnPlans.get(cid) : undefined;
    const keep = tokens.filter((token) => {
      if (columnPlan && /^(?:[a-z0-9-]+:)*grid-cols-(?:\d+|\[[^\]]+\])$/.test(token)) return false;
      if (/^(?:[a-z0-9-]+:)*grid-rows-\[(?:auto_?)+\]$/.test(token)) return false;
      if (repeatedGridParents.has(cid) && /^(?:[a-z0-9-]+:)*grid-rows-\d+$/.test(token)) return false;
      const initialCols = /^(?:(.*):)?grid-cols-\[initial\]$/.exec(token);
      if (initialCols) {
        const prefix = initialCols[1] ? `${initialCols[1]}:` : "";
        if (tokenSet.has(`${prefix}flex`) || tokenSet.has(`${prefix}block`)) return false;
      }
      const initialGapX = /^(?:(.*):)?gap-x-\[initial\]$/.exec(token);
      if (initialGapX) {
        const prefix = initialGapX[1] ? `${initialGapX[1]}:` : "";
        if (tokenSet.has(`${prefix}grid-cols-1`)) return false;
      }
      return true;
    });
    if (opts.tailwind && fillGridParents.has(cid)) {
      const hasGridDisplay = keep.some((token) => /^(?:[a-z0-9-]+:)*grid$/.test(token));
      const hasBaseWidth = keep.some((token) => /^w-/.test(token));
      if (hasGridDisplay && !hasBaseWidth) keep.unshift("w-full");
    }
    if (columnPlan) keep.push(...columnPlan);
    return keep.join(" ");
  };
}

export function generateApp(input: GenerateInput, tokensCss: string): { pageTsx: string; cloneCss: string; components: ExtractedComponent[] } {
  const { ir, assetGraph, fontGraph, appDir, sourceUrl } = input;
  const assetMap = buildAssetMap(assetGraph);
  const framework = input.framework ?? "next";
  const rootDir = sourceRoot(appDir, framework);

  const runtimeSpecs = buildRuntimeSpecs(ir, input.interaction, undefined, input.rejectedSpecs);
  const accordions = runtimeSpecs.filter((s): s is AccordionRuntimeSpec => s.kind === "accordion");
  const wires = runtimeSpecs.filter((s) => s.kind !== "accordion");
  const motionSpec = buildMotionSpec(ir, input.motion);
  const components = input.components ? buildComponentRegistry(ir, input.primitives, input.recipeReport) : undefined;
  const linkRewrite = sameOriginRelativeLinkRewrite(sourceUrl);
  const menus = buildMenuSpecs(ir, input.interaction?.menus, assetMap, sourceUrl, linkRewrite);
  // Output-quality: dedup the per-node fidelity CSS into shared, semantically-named
  // classes (fidelity-neutral — grouped nodes have byte-identical rules). The JSX then
  // references these classes instead of `c<id>`, and ditto.css reads as a component
  // stylesheet. Default on; `humanize:false` falls back to the legacy per-node path.
  const humanize = input.humanize !== false;
  const mode = input.humanizeMode ?? "tailwind";
  // Tailwind mode (default): translate each node's exact decls to utility classes.
  // CSS mode: dedup into shared semantic CSS classes. Both fidelity-neutral.
  const tw = humanize && mode === "tailwind" ? buildTailwind(ir, assetMap, input.colorVar, { interaction: input.interaction, reflow: input.reflow }) : undefined;
  const classMap = humanize && mode === "css" ? buildClassMap(ir, assetMap, input.colorVar, input.primitives, input.tokenResolver) : undefined;
  const cleanRecipeClass = recipeResponsiveClassCleaner(input.recipeReport, { tailwind: !!tw });
  const classOf = tw ? (cid: string) => cleanRecipeClass(cid, tw.classOf.get(cid)) : classMap ? (cid: string) => classMap.classOf.get(cid) : undefined;
  const styleOf = tw ? (cid: string) => tw.styleOf.get(cid) : undefined;
  // Section split (single-page humanized): plan section roots, render each into its own
  // module. Disabled if planning found no clean split (page stays inlined).
  const sectionPlan = humanize ? planSections(ir, input.recipeReport) : undefined;
  const sections: SectionRegistry | undefined = sectionPlan && sectionPlan.roots.size > 0 ? { plan: sectionPlan, modules: new Map(), order: [] } : undefined;
  const svgs: SvgRegistry | undefined = humanize ? { byKey: new Map(), defs: new Map(), order: [], nameCount: new Map() } : undefined;
  const pageTsx = generatePageTsx(ir, assetMap, sourceUrl, { primitives: input.primitives, components, linkRewrite, classOf, styleOf, sections, svgs }, wires, motionSpec, menus, accordions);
  // Tailwind mode: utilities live in the JSX; ditto.css carries only pseudo-elements +
  // keyframes + interaction CSS (keyed by [data-cid], since nodes have no c<id> class).
  // Tailwind mode folds hover/focus into the className as `hover:`/`focus:` variant utilities
  // (buildTailwind), so ditto.css carries ONLY pseudo-element rules + keyframes — no [data-cid]:hover.
  const cloneCss = tw
    ? tw.pseudoCss
    : (classMap ? classMap.css : generateCss(ir, assetMap, undefined, input.colorVar, input.tokenResolver)) + generateInteractionCss(ir, input.interaction);
  const sectionOut = sectionFiles(sections, components, svgs);
  const contentTs = contentModule(components, sectionOut.contentDecls);

  // Scaffold
  writeText(join(appDir, "package.json"), framework === "vite" ? (tw ? PACKAGE_JSON_VITE_TW : PACKAGE_JSON_VITE) : (tw ? PACKAGE_JSON_TW : PACKAGE_JSON));
  writeText(join(appDir, "tsconfig.json"), framework === "vite" ? TSCONFIG_JSON_VITE : TSCONFIG_JSON);
  if (framework === "vite") {
    rmSync(join(appDir, "next.config.mjs"), { force: true });
    rmSync(join(appDir, "next-env.d.ts"), { force: true });
    rmSync(join(appDir, "src", "app"), { recursive: true, force: true });
    writeText(join(appDir, "vite.config.ts"), generateViteConfig([{ name: "main", html: "index.html" }]));
    writeText(join(appDir, "src", "vite-env.d.ts"), `/// <reference types="vite/client" />\n`);
  } else {
    rmSync(join(appDir, "index.html"), { force: true });
    rmSync(join(appDir, "vite.config.ts"), { force: true });
    rmSync(join(appDir, "src", "routes"), { recursive: true, force: true });
    rmSync(join(appDir, "src", "page.tsx"), { force: true });
    rmSync(join(appDir, "src", "main.tsx"), { force: true });
    rmSync(join(appDir, "src", "vite-env.d.ts"), { force: true });
    writeText(join(appDir, "next.config.mjs"), NEXT_CONFIG);
    writeText(join(appDir, "next-env.d.ts"), `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`);
  }
  writeText(join(appDir, ".gitignore"), "node_modules\n.next\nout\ndist\n");
  if (tw) writeText(join(appDir, "postcss.config.mjs"), `export default { plugins: { "@tailwindcss/postcss": {} } };\n`);

  // App source. Clear generated component/section dirs first so a regenerate-in-place
  // never leaves stale modules from a previous run (the per-run deliverable writes to a
  // fresh dir, but `regen` and downstream tools reuse one).
  for (const sub of ["clone", "ditto", "components", "sections", "svgs"]) rmSync(join(rootDir, sub), { recursive: true, force: true });
  if (framework === "next") {
    writeText(join(rootDir, "layout.tsx"), generateLayoutTsx(ir, classOf ? classOf(ir.root.id) : undefined, input.seoInventory));
  } else {
    const bodyClass = classOf ? classOf(ir.root.id) : undefined;
    writeText(join(appDir, "index.html"), generateViteIndexHtml({
      lang: ir.doc.lang || "en",
      bodyCid: ir.root.id,
      bodyClass,
      seo: input.seoInventory,
      title: ir.doc.title || "Cloned Page",
      description: ir.doc.head?.description,
      entry: "/src/main.tsx",
    }));
    writeText(join(rootDir, "main.tsx"), generateViteMainTsx());
  }
  writeText(join(rootDir, "page.tsx"), pageTsx);
  // Stage 7: semantic recipe content lives in a shared content.ts module. JSX-heavy data
  // arrays stay colocated with their section until we add a TSX content emitter.
  rmSync(join(rootDir, "content.ts"), { force: true });
  rmSync(join(rootDir, "content.tsx"), { force: true });
  if (contentTs) writeText(join(rootDir, "content.ts"), contentTs);
  // Internal data-cid arrays (kept out of the editable content module).
  const cidsModule = componentCidsModule(components);
  if (cidsModule) writeText(join(rootDir, "_cids.ts"), cidsModule);
  // Internal per-instance class overrides (styling, also kept out of content.ts).
  const stylesModule = componentStylesModule(components);
  if (stylesModule) writeText(join(rootDir, "_styles.ts"), stylesModule);
  // Stage 6: one editable file per extracted component (imported by page.tsx).
  // Files are kebab-case, exports PascalCase (the conventional split).
  for (const { name, module } of componentFiles(components, svgs)) {
    writeText(join(rootDir, "components", fileBase(name) + ".tsx"), module);
  }
  // Section split: one editable file per hoisted section (imported by page.tsx).
  for (const { name, module } of sectionOut.files) {
    writeText(join(rootDir, "sections", fileBase(name) + ".tsx"), module);
  }
  // Inline SVGs hoisted into their own modules (imported by sections/page).
  if (svgs) for (const [name, module] of svgs.defs) {
    writeText(join(rootDir, "svgs", svgFileBase(name) + ".tsx"), module);
  }
  if (tw) {
    const cw = ir.doc.canonicalViewport;
    const pv = ir.doc.perViewport[cw];
    const htmlBg = pv?.htmlBg && pv.htmlBg !== "rgba(0, 0, 0, 0)" ? pv.htmlBg : (pv?.bodyBg ?? "#ffffff");
    const noHScroll = Object.entries(ir.doc.perViewport).every(([vp, d]) => d.scrollWidth <= Number(vp) * 1.03);
    const clip = noHScroll ? "\nhtml, body { overflow-x: clip; }" : "";
    const globals = tailwindGlobalsCss({
      reset: RESET_CSS, fontCss: fontGraph.css, tokensCss: tokensCss + (tw.colorDefsCss ? "\n" + tw.colorDefsCss : ""),
      htmlBg, bodyFont: SYSTEM_FALLBACK, clip, colorTokens: tw.colorTokens, viewports: ir.doc.viewports,
    });
    writeText(join(rootDir, "globals.css"), framework === "vite" ? viteGlobalsCss(globals) : globals);
  } else {
    const globals = generateGlobalsCss(ir, fontGraph, tokensCss);
    writeText(join(rootDir, "globals.css"), framework === "vite" ? viteGlobalsCss(globals) : globals);
  }
  writeText(join(rootDir, "ditto.css"), cloneCss);
  if (wires.length) writeText(join(rootDir, "ditto", "DittoWire.tsx"), DITTO_WIRE_TSX);
  if (accordions.length) writeText(join(rootDir, "ditto", "Accordion.tsx"), ACCORDION_TSX);
  if (motionHasContent(motionSpec)) writeText(join(rootDir, "ditto", "DittoMotion.tsx"), DITTO_MOTION_TSX);
  if (menus.length) writeText(join(rootDir, "ditto", "DropdownMenu.tsx"), DROPDOWN_MENU_TSX);
  const routeSummary = routeSummaryFromIr(ir, "/", "/", sourceUrl);
  if (framework === "next") {
    if (input.seoInventory) {
      emitSeoRoutes(appDir, input.seoInventory, [routeSummary]);
      if (input.sourceDir) emitSeoAssetFiles(appDir, input.sourceDir, assetGraph, input.seoInventory);
    } else {
      for (const [rel, body] of seoFiles(ir)) writeText(join(rootDir, rel), body);
    }
  } else {
    if (input.seoInventory) {
      for (const [rel, body] of seoStaticFiles(input.seoInventory, [routeSummary])) writeText(join(appDir, "public", rel), body);
    }
  }
  emitGeneratedDocs(appDir, {
    sourceUrl,
    routes: [routeSummary],
    styling: mode,
    framework,
    multiRoute: false,
    components: !!input.components,
    sectionCount: sectionOut.files.length,
    componentCount: components ? summarizeComponents(components).length : 0,
    svgCount: svgs?.defs.size ?? 0,
    hasContentModule: !!contentTs,
    runtimeUtilities: [
      ...(wires.length ? ["DittoWire"] : []),
      ...(accordions.length ? ["Accordion"] : []),
      ...(motionHasContent(motionSpec) ? ["DittoMotion"] : []),
      ...(menus.length ? ["DropdownMenu"] : []),
    ],
  });

  return { pageTsx, cloneCss, components: components ? summarizeComponents(components) : [] };
}

export const PACKAGE_JSON = `{
  "name": "cloned-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "15.5.19",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "@types/node": "22.10.5",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3"
  }
}
`;

/** package.json for Tailwind-mode output: adds Tailwind v4 + the PostCSS plugin. */
export const PACKAGE_JSON_TW = `{
  "name": "cloned-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "15.5.19",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "@types/node": "22.10.5",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4"
  }
}
`;

export const PACKAGE_JSON_VITE = `{
  "name": "cloned-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "vite preview"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.7.0",
    "vite": "^6.4.3",
    "typescript": "5.7.3",
    "@types/node": "22.10.5",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3"
  }
}
`;

export const PACKAGE_JSON_VITE_TW = `{
  "name": "cloned-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "vite preview"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.7.0",
    "vite": "^6.4.3",
    "typescript": "5.7.3",
    "@types/node": "22.10.5",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4"
  }
}
`;

export const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

export const TSCONFIG_JSON_VITE = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"],
  "exclude": ["node_modules", "dist"]
}
`;

export const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};
export default nextConfig;
`;
