import { isTextChild, type IR, type IRNode, type IRChild } from "../normalize/ir.js";
import type { FontGraph } from "../infer/fonts.js";
import { SYSTEM_FALLBACK } from "../infer/fonts.js";
import { collectNodeRules, keyframesCss, computeBands, assembleCss, RESET_CSS } from "./css.js";
import type { TokenResolver } from "../infer/tokens.js";
import { propsList, resolveTag, resolveHtmlBg, htmlBgRule } from "./app.js";

/**
 * Fast, self-contained static preview artifact (`preview.html`).
 *
 * Product moment: the service shows the cloned page within seconds of `generate`
 * finishing — BEFORE the Next.js build + deploy completes — then swaps to the
 * deployed app. This artifact renders WITHOUT any build toolchain (no next / tailwind
 * / esbuild): it is pure string building over the same frozen IR + rules the JSX
 * emitter consumes.
 *
 * SHARED DECISION CODE (not a parallel emission path):
 *  - CSS: `collectNodeRules` + `keyframesCss` + `computeBands` + `assembleCss` from
 *    css.ts — the identical per-node rule collection + media-query banding the semantic
 *    class-map emitter (classMap.ts) and the legacy per-node emitter (generateCss) use.
 *    We emit `.c<id>` selectors, exactly like `generateCss`, so the preview's computed
 *    styles are byte-for-byte the same rules the built app resolves to. Crucially this
 *    holds even though the app's DEFAULT output is Tailwind (utilities in the JSX, no
 *    `.c<id>` rules) — the preview reuses the css-mode rule collector directly.
 *  - HTML: `propsList` + `resolveTag` from app.ts — the SAME tag resolution, attribute
 *    filtering, asset-URL mapping (src/poster/srcset), video/lottie poster stills, and
 *    class assignment the JSX renderer uses. We translate the JSX-flavoured attribute
 *    pairs to raw HTML attributes; we do NOT re-derive which attrs/assets to keep.
 *
 * Runtime-free: no DittoWire / DittoLottie / DittoMotion scripts. Lottie mounts and
 * <video> render as their captured poster/first-frame stills (the still is already
 * baked into the node's `poster`/`src` attr by capture + the asset pipeline, so
 * `propsList` emits it for us). Animations are frozen at their captured start state.
 *
 * Determinism (sacred): derived purely from the IR + rules + asset map; no timestamps,
 * no randomness. Two runs over the same frozen capture emit byte-identical HTML.
 *
 * Asset paths: the asset map yields root-absolute `/assets/cloned/...` (public/ served
 * at the app root under Next). preview.html physically sits at generated/app/preview.html
 * with assets under generated/app/public/assets/cloned/..., so we rewrite the leading
 * `/assets/` to `public/assets/` — a relative path that resolves both when the file is
 * opened at the generated app-dir root and when it is fetched alongside the file map.
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

// Inverse of app.ts's ATTR_RENAME (HTML → React). The JSX `propsList` renames HTML
// attribute names to their React spelling (for → htmlFor, class → className, …); the
// preview emits raw HTML, so map them back. Anything not listed is already an HTML name.
const REACT_TO_HTML: Record<string, string> = {
  htmlFor: "for", className: "class", srcSet: "srcset", colSpan: "colspan",
  rowSpan: "rowspan", dateTime: "datetime", itemProp: "itemprop", hrefLang: "hreflang",
  autoPlay: "autoplay", playsInline: "playsinline", readOnly: "readonly",
  maxLength: "maxlength", crossOrigin: "crossorigin", noValidate: "novalidate",
  tabIndex: "tabindex", contentEditable: "contenteditable", defaultChecked: "checked",
};

/** Rewrite the asset map's root-absolute `/assets/…` refs to the preview's relative
 *  `public/assets/…` layout (preview.html at generated/app/, assets at generated/app/public/).
 *  Applied to both inline CSS (url(/assets/…)) and HTML attribute values. Pure string op. */
function relativizeAssets(s: string): string {
  return s.replace(/\/assets\//g, "public/assets/");
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Collapse a text run under white-space:normal the way CSS renders it (mirrors app.ts's
 *  collapseWs): every whitespace run → a single space. Verbatim under pre/pre-wrap etc. */
function collapseWs(raw: string): string {
  return raw.replace(/\s+/g, " ");
}

function preservesWhitespace(n: IRNode, canonical: number): boolean {
  const ws = (n.computedByVp[canonical] ?? Object.values(n.computedByVp)[0])?.whiteSpace;
  if (ws) return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws);
  return n.tag === "pre" || n.tag === "textarea";
}

// Element-only parents whose direct whitespace-only text children are non-significant
// (mirrors app.ts's ELEMENT_ONLY_PARENTS): a stray "\n  " between <li>s is source
// indentation, not content.
const ELEMENT_ONLY_PARENTS = new Set(["ul", "ol", "table", "thead", "tbody", "tfoot", "tr", "select", "colgroup", "optgroup", "menu", "dl"]);

/** Translate one JSX-flavoured [key, valueSrc] pair from propsList into a raw HTML
 *  attribute string (leading space), or "" to drop it. valueSrc is ready-to-emit JS
 *  source: a JSON string literal, `true`, or a `{ __html: … }` object (SVG inner — the
 *  caller handles that separately, so we skip it here). */
function htmlAttr(key: string, valueSrc: string): string {
  // The SVG inner-markup prop is emitted as literal inner HTML by the caller.
  if (key === "dangerouslySetInnerHTML") return "";
  const rawName = key.startsWith('"') ? key.slice(1, -1) : key;
  const name = REACT_TO_HTML[rawName] ?? rawName;
  if (valueSrc === "true") return ` ${name}`;
  if (valueSrc === "false") return "";
  let value: string;
  if (valueSrc.startsWith('"')) {
    try { value = JSON.parse(valueSrc) as string; } catch { return ""; }
  } else {
    // A `{ __html … }` object or other non-string expression — not a plain HTML attr.
    return "";
  }
  // Asset attrs (src/poster/srcset) and any inline url() carry the /assets/ prefix.
  if (name === "src" || name === "poster" || name === "srcset" || name === "style") value = relativizeAssets(value);
  return ` ${name}="${escapeAttr(value)}"`;
}

/** The raw-HTML attribute string for a node — REUSES propsList (app.ts) so tag/attr/asset
 *  decisions are identical to the JSX path; we only re-serialize to HTML. No ctx is passed,
 *  so propsList assigns the legacy `c<id>` class (matching our `.c<id>` CSS) and emits
 *  data-cid; component/section/svg-module machinery is inert (the composed DOM is the same). */
function attrsForNode(node: IRNode, assetMap: Map<string, string>, sourceUrl: string): string {
  return propsList(node, assetMap, sourceUrl).map(([k, v]) => htmlAttr(k, v)).join("");
}

/** The inner markup of an inline <svg> node, taken verbatim from the propsList
 *  `dangerouslySetInnerHTML` prop (already browser-serialized, capture-id stripped, start
 *  state revealed) — shared with the JSX path, url()s relativized. */
function svgInner(node: IRNode, assetMap: Map<string, string>, sourceUrl: string): string {
  for (const [k, v] of propsList(node, assetMap, sourceUrl)) {
    if (k !== "dangerouslySetInnerHTML") continue;
    const m = /\{\s*__html:\s*(".*")\s*\}$/s.exec(v);
    if (!m) return "";
    try { return relativizeAssets(JSON.parse(m[1]!) as string); } catch { return ""; }
  }
  return "";
}

function renderNode(node: IRNode, assetMap: Map<string, string>, sourceUrl: string, canonical: number, indent: number, insideInteractive: boolean, insideTable: boolean): string {
  const pad = "  ".repeat(indent);
  const tag = resolveTag(node, insideInteractive, insideTable);
  const attrs = attrsForNode(node, assetMap, sourceUrl);
  const childInteractive = insideInteractive || node.tag === "a" || node.tag === "button";
  const childTable = insideTable || node.tag === "table";

  // Inline SVG: emit the shared inner markup verbatim inside the <svg> box.
  if (node.rawHTML && tag === "svg") {
    const inner = svgInner(node, assetMap, sourceUrl);
    return inner ? `${pad}<svg${attrs}>${inner}</svg>` : `${pad}<svg${attrs}></svg>`;
  }
  if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs} />`;

  const children = renderChildren(node.children, tag, assetMap, sourceUrl, canonical, indent + 1, childInteractive, childTable, preservesWhitespace(node, canonical));
  if (children.length === 0) return `${pad}<${tag}${attrs}></${tag}>`;
  return `${pad}<${tag}${attrs}>\n${children.join("\n")}\n${pad}</${tag}>`;
}

function renderChildren(children: IRChild[], parentTag: string | null, assetMap: Map<string, string>, sourceUrl: string, canonical: number, indent: number, insideInteractive: boolean, insideTable: boolean, preserveWs: boolean): string[] {
  const pad = "  ".repeat(indent);
  const parts: string[] = [];
  // Coalesce adjacent text children into one node (the browser merges them anyway).
  let textBuf = "";
  const flush = () => {
    if (parentTag && ELEMENT_ONLY_PARENTS.has(parentTag) && textBuf.trim() === "") { textBuf = ""; return; }
    const out = preserveWs ? textBuf : collapseWs(textBuf);
    if (out.length) parts.push(`${pad}${escapeText(out)}`);
    textBuf = "";
  };
  for (const c of children) {
    if (isTextChild(c)) { textBuf += c.text; continue; }
    // <source>/<track> children: kept only if the JSX path would keep them. The JSX
    // emitter filters video <track> and non-materialized <source>; but propsList/resolveTag
    // don't, so filter here to match. A video/picture <source> without a local candidate
    // and any <video> <track> would otherwise reference a missing/remote file.
    if (parentTag === "video" && c.tag === "track") continue;
    flush();
    parts.push(renderNode(c, assetMap, sourceUrl, canonical, indent, insideInteractive, insideTable));
  }
  flush();
  return parts;
}

/** The inline stylesheet: reset + fonts + tokens + page base + per-node rules + keyframes.
 *  The per-node rules and keyframes come from the SHARED css.ts collectors (identical to
 *  what the built app resolves to); all url()/asset refs are relativized. */
function previewCss(ir: IR, assetMap: Map<string, string>, tokensCss: string, fontGraph: FontGraph, colorVar?: (v: string) => string | null, tokenResolver?: TokenResolver): string {
  const rules = collectNodeRules(ir, assetMap, undefined, colorVar, tokenResolver);
  const bands = computeBands(ir.doc.viewports, ir.doc.canonicalViewport);
  const kf = keyframesCss(ir, assetMap);
  const nodeCss = assembleCss([...rules.keys()], (cid) => rules.get(cid)!, (cid) => `.c${cid}`, bands, kf);

  const pv = ir.doc.perViewport[ir.doc.canonicalViewport];
  const htmlBg = resolveHtmlBg(pv);
  const noHScroll = Object.entries(ir.doc.perViewport).every(([vp, d]) => d.scrollWidth <= Number(vp) * 1.03);
  const clip = noHScroll ? "\nhtml, body { overflow-x: clip; }" : "";

  const doc = `${RESET_CSS}
/* fonts */
${fontGraph.css}

/* tokens */
${tokensCss}

/* page base */
${htmlBgRule(htmlBg)}body { font-family: ${SYSTEM_FALLBACK}; }${clip}

/* nodes */
${nodeCss}`;
  return relativizeAssets(doc);
}

/**
 * Emit the standalone `preview.html` document as a string. Pure + deterministic.
 * `tokensCss` is the assembled color-palette + token CSS (same string the pipeline
 * feeds generateApp). `sourceUrl` drives asset-URL resolution (matching the JSX path).
 */
export function generatePreviewHtml(input: {
  ir: IR;
  assetMap: Map<string, string>;
  fontGraph: FontGraph;
  tokensCss: string;
  sourceUrl: string;
  colorVar?: (v: string) => string | null;
  tokenResolver?: TokenResolver;
}): string {
  const { ir, assetMap, fontGraph, tokensCss, sourceUrl, colorVar, tokenResolver } = input;
  const canonical = ir.doc.canonicalViewport;
  const css = previewCss(ir, assetMap, tokensCss, fontGraph, colorVar, tokenResolver);
  const body = renderChildren(ir.root.children, ir.root.tag, assetMap, sourceUrl, canonical, 2, false, false, false).join("\n");
  const bodyAttrs = attrsForNode(ir.root, assetMap, sourceUrl);
  const lang = ir.doc.lang || "en";
  const title = ir.doc.title || "Preview";
  return `<!doctype html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="${escapeAttr(ir.doc.charset || "utf-8")}" />
<meta name="viewport" content="${escapeAttr(ir.doc.metaViewport || "width=device-width, initial-scale=1")}" />
<title>${escapeText(title)}</title>
<style>
${css}
</style>
</head>
<body${bodyAttrs}>
${body}
</body>
</html>
`;
}
