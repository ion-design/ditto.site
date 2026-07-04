/**
 * In-page capture walker. This function is serialized and executed inside the
 * browser via page.evaluate, so it must be fully self-contained (no imports, no
 * outer references). It returns a serializable snapshot of the rendered page:
 * the visible DOM tree with computed styles, bounding boxes (in document
 * coordinates), pseudo-element styles, plus discovered CSS/font/asset references.
 *
 * Design notes:
 *  - We serialize ALL elements (including display:none) so the tree structure is
 *    identical across viewports and nodes can be aligned by pre-order index.
 *  - Inline <svg> is captured as raw outerHTML and not recursed — reconstructing
 *    SVG node-by-node is lossy; replaying the markup is exact.
 *  - script/style/link/meta/noscript/template are skipped (we generate our own
 *    CSS and never reproduce JS).
 */

export type RawBBox = { x: number; y: number; width: number; height: number };
export type RawStyle = Record<string, string>;
/** Sizing-intent probe results: does the browser re-derive this
 *  element's width/height when we drop the authored value? Ground truth for "is this dimension
 *  load-bearing". For out-of-flow (absolute/fixed) elements, `insetDrop` instead records, per side,
 *  whether setting that inset to `auto` leaves the box exactly in place — i.e. it's a filled-in used
 *  value (the browser resolved `bottom`/`right` from the containing-block size) that we should NOT
 *  bake, vs an authored anchor that pins the box. */
export type RawSizing = {
  wAuto: boolean; wFill: boolean; hAuto: boolean;
  // Does `height:100%` re-derive this box (within 0.5px) at this viewport? The HEIGHT analogue of
  // wFill: ground truth that the element FILLS a definite-height containing block, so the faithful
  // emission is `h-full` rather than a baked per-vp px band. Distinguished from hAuto (content-sized):
  // a node with hFill && !hAuto genuinely fills a definite parent (the source's `h-full`), whereas
  // hAuto means it's content-sized (drop to auto). Present only for in-flow probed elements.
  hFill?: boolean;
  // Intrinsic-size anchors: the element's min-content and max-content widths,
  // measured live. They are the anchors a fluid width LAW is fit from — a load-bearing width that
  // VARIES across viewports but rides between these bounds is a fluid rule (`clamp()`/`%`/`flex`),
  // not four baked px. Present only for in-flow probed elements (px, rounded).
  wMin?: number; wMax?: number;
  insetDrop?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
};

export type RawNode = {
  tag: string;
  attrs: Record<string, string>;
  computed: RawStyle;
  bbox: RawBBox;
  visible: boolean;
  // A font-metric / measurement scratch node injected by the SOURCE site's own JS (typography
  // libraries, FontFaceObserver): absolutely positioned, parked far off-screen, and non-painting.
  // Never user-visible; excluded from emission so it doesn't ship as page markup.
  probe?: boolean;
  sizing?: RawSizing;
  before?: RawStyle;
  after?: RawStyle;
  // ::placeholder computed style for input/textarea with placeholder text. Without it the
  // clone renders the browser's default gray, losing the authored placeholder color/type.
  placeholder?: RawStyle;
  rawHTML?: string; // set for inline <svg>
  // Computed paint of an inline <svg> root (fill/stroke/color). A raw `fill="none"` attribute may
  // still resolve to a real paint via site CSS (`fill: currentColor`); these resolved values let
  // codegen recover a paint the extraction stripped. Set only for svg roots.
  svgPaint?: { fill: string; stroke: string; color: string };
  children: RawChild[];
};

export type RawChild = RawNode | { text: string };

export type FontFace = {
  family: string;
  src: string; // raw src descriptor (may contain multiple url())
  weight?: string;
  style?: string;
  display?: string;
  unicodeRange?: string;
  stretch?: string;
};

export type PageSnapshot = {
  doc: {
    url: string;
    title: string;
    head: {
      description: string; canonical: string; ogTitle: string; ogDescription: string;
      ogImage: string; ogType: string; ogSiteName: string; twitterCard: string; themeColor: string;
      keywords?: string; robots?: string; referrer?: string; colorScheme?: string;
      meta?: Array<{ name?: string; property?: string; httpEquiv?: string; content: string }>;
      links?: Array<{
        rel: string; href: string; as?: string; type?: string; sizes?: string; media?: string;
        color?: string; hrefLang?: string; title?: string; crossOrigin?: string; referrerPolicy?: string;
      }>;
      jsonLd?: Array<{ id?: string; text: string }>;
    };
    lang: string;
    charset: string;
    viewportWidth: number;
    viewportHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    htmlBg: string;
    bodyBg: string;
    bodyColor: string;
    bodyFont: string;
    metaViewport: string;
    nodeCount: number;
    truncated: boolean;
  };
  root: RawNode;
  cssVars: Record<string, string>;
  fontFaces: FontFace[];
  cssUrls: string[];
  domAssets: Array<{ kind: string; url: string; via: string }>;
  keyframes: string[]; // raw @keyframes blocks from accessible sheets
};

// `| void` keeps the no-arg `page.evaluate(collectPage)` call sites type-compatible
// (Playwright types the missing argument as void); frame grafts pass { maxNodes }.
export function collectPage(opts?: { maxNodes?: number } | void): PageSnapshot {
  // NOTE: This function is serialized and run in the browser via page.evaluate,
  // so every constant/helper it uses must be declared INSIDE it (no module-scope
  // closure is available in the page).

  // Curated computed-style property set. Comprehensive enough to replay layout,
  // box model, typography, visuals, layering, and safe transitions/animations.
  const PROPS: string[] = [
    "display", "position", "top", "right", "bottom", "left", "float", "clear",
    "zIndex", "boxSizing", "visibility", "opacity", "isolation",
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
    "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignContent",
    "alignSelf", "flexGrow", "flexShrink", "flexBasis", "order",
    "gap", "rowGap", "columnGap",
    "gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas", "gridAutoFlow", "gridAutoRows",
    "gridAutoColumns", "justifyItems", "placeItems", "placeContent",
    "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd",
    "overflow", "overflowX", "overflowY",
    "objectFit", "objectPosition", "aspectRatio", "verticalAlign",
    "color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
    "letterSpacing", "wordSpacing", "textAlign", "textTransform",
    "textDecorationLine", "textDecorationColor", "textDecorationStyle",
    "whiteSpace", "wordBreak", "overflowWrap", "textOverflow", "textIndent",
    // Modern line-wrapping: `text-wrap: balance/pretty` rebalances heading line breaks
    // (getComputedStyle reports the shorthand — "balance"/"pretty"/"wrap"). Without it a
    // balanced heading wraps differently in the clone (an even two-line title collapses
    // to a lopsided break). Default "wrap" is elided downstream.
    "textWrap",
    "textShadow", "fontVariantCaps", "fontFeatureSettings",
    // Line clamping (`display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:N`):
    // the mechanism that keeps cards equal height regardless of text length. Without it the engine
    // sees only the RESULTING px height and bakes/drops it per card — uneven.
    "webkitLineClamp", "webkitBoxOrient",
    "listStyleType", "listStylePosition", "writingMode", "direction",
    "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
    "backgroundRepeat", "backgroundClip", "backgroundOrigin", "backgroundAttachment",
    "backgroundBlendMode",
    "boxShadow", "filter", "backdropFilter", "mixBlendMode",
    "transform", "transformOrigin", "transformStyle", "perspective",
    // Individual transform properties (CSS Transforms Level 2) — modern sites centre/offset with
    // `translate: -50% -50%` etc. INSTEAD of `transform`. getComputedStyle reports them separately
    // (transform stays "none"), so without capturing them a translate-centred box loses its shift.
    // Emitted as raw `[translate:...]` properties.
    "translate", "rotate", "scale",
    "clipPath", "maskImage",
    "webkitTextStroke", "webkitTextFillColor", "webkitBackgroundClip",
    "transition", "animationName", "animationDuration", "animationTimingFunction",
    "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode",
    "cursor", "pointerEvents", "userSelect", "tableLayout", "borderCollapse", "borderSpacing",
  ];

  const PSEUDO_PROPS: string[] = [
    "content", "display", "position", "top", "right", "bottom", "left", "zIndex",
    "width", "height", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
    "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "textAlign", "textTransform",
    "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat",
    "boxShadow", "opacity", "transform", "transformOrigin", "translate", "rotate", "scale", "filter",
    "overflow", "objectFit",
  ];

  // ::placeholder property set: the visual identity of placeholder text. Kept small —
  // it inherits everything else from the input itself.
  const PLACEHOLDER_PROPS: string[] = [
    "color", "opacity", "fontFamily", "fontSize", "fontWeight", "fontStyle",
    "letterSpacing", "textTransform",
  ];

  const SKIP_TAGS = new Set([
    "script", "style", "link", "meta", "noscript", "template", "base", "title", "head",
  ]);

  // Text-level tags whose whitespace-only text still renders even as the FIRST/ONLY
  // child (the lone-space case below); a block container's stray whitespace does not.
  const INLINE_TEXT_TAGS = new Set([
    "span", "strong", "em", "b", "i", "a", "u", "small", "sub", "sup", "code", "abbr", "time", "label",
  ]);

  // Frame grafts pass a lower cap so one pathological embed can't dominate the snapshot.
  const MAX_NODES = (opts && opts.maxNodes) || 12000;

  const round2 = (n: number): number => Math.round((n || 0) * 100) / 100;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // Viewport + page extents used by isVisible's off-screen test. bbox coords are in
  // DOCUMENT space (r + scroll), so the visible window on each axis is
  // [scroll, scroll + inner]. A box whose border box lies wholly outside that window
  // on a NON-scrollable axis is unreachable and paints nothing to the user.
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const scrollEl = document.scrollingElement || document.documentElement;
  // Horizontal scrolling is legitimate when the page is wider than the viewport (RTL
  // carousels, horizontal galleries). In that case content parked to the RIGHT is
  // reachable by scrolling, so we only reject boxes fully off the LEFT edge (x <= 0
  // start-of-page, never reachable). Vertical always scrolls, so we never reject
  // in-flow content below the fold — only position:fixed boxes, which do NOT scroll
  // with the page and so are truly gone if parked above/below the viewport.
  const horizScrollable = round2(scrollEl.scrollWidth) > vpW + 1;

  // Resolve `line-height: normal` to a concrete px value by probing the actual
  // line-box height for each (font-family, font-size, font-weight, font-style).
  // getComputedStyle reports the keyword "normal", which renders font-metric-
  // dependently and drifts sub-pixel over many lines (e.g. dense text tables);
  // emitting the resolved px makes the clone deterministic and exact.
  const lhCache = new Map<string, string>();
  const lhProbe = document.createElement("div");
  lhProbe.style.cssText = "position:absolute;visibility:hidden;left:-99999px;top:-99999px;padding:0;border:0;margin:0;white-space:nowrap;line-height:normal;";
  lhProbe.textContent = "Mgy";
  document.body.appendChild(lhProbe);
  const resolveNormalLineHeight = (ff: string, fs: string, fw: string, fst: string): string => {
    const key = `${ff}|${fs}|${fw}|${fst}`;
    const cached = lhCache.get(key);
    if (cached !== undefined) return cached;
    lhProbe.style.fontFamily = ff;
    lhProbe.style.fontSize = fs;
    lhProbe.style.fontWeight = fw;
    lhProbe.style.fontStyle = fst;
    const h = lhProbe.getBoundingClientRect().height;
    const v = h > 0 ? `${Math.round(h * 100) / 100}px` : "normal";
    lhCache.set(key, v);
    return v;
  };
  let nodeCount = 0;
  let truncated = false;

  const grabStyle = (cs: CSSStyleDeclaration, props: string[]): RawStyle => {
    const out: RawStyle = {};
    for (const p of props) {
      // CSSStyleDeclaration is indexable by camelCase property names.
      const v = (cs as unknown as Record<string, string>)[p];
      if (v !== undefined && v !== null && v !== "") out[p] = v;
    }
    return out;
  };

  const isVisible = (el: Element, cs: CSSStyleDeclaration, bbox: RawBBox): boolean => {
    if (cs.display === "none") return false;
    // getComputedStyle already resolves `visibility` inheritance: a descendant that
    // sets visibility:visible inside a hidden ancestor reports "visible" here (and is
    // genuinely painted), so this test is exactly CSS computed semantics — no separate
    // ancestor walk is needed. The off-screen test below is what catches un-hidden
    // content parked outside the viewport (e.g. a slide-in drawer's inner nodes).
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (parseFloat(cs.opacity || "1") === 0) return false;
    if (bbox.width === 0 && bbox.height === 0) {
      // zero-size but might still matter (e.g. absolutely positioned icon); treat
      // as not visible for matching purposes.
      return false;
    }
    // Off-screen test. bbox is document-space (x/y already include scroll). The box is
    // invisible only when it lies WHOLLY outside a non-scrollable axis window — a box
    // that merely straddles an edge (negative-margin / overflow-hidden decoration
    // peeking in) still paints and stays visible.
    //
    // Horizontal: the page never scrolls left of origin, so anything whose right edge
    // is at/left of 0 is unreachable. When the page is NOT horizontally scrollable we
    // also reject boxes whose left edge is at/right of the viewport width; when it IS
    // scrollable (wide/RTL/carousel pages), right-parked content is reachable, so only
    // the fully-left case counts.
    const rightEdge = bbox.x + bbox.width;
    if (rightEdge <= 0) return false;
    if (!horizScrollable && bbox.x >= vpW) return false;
    // Vertical: the page scrolls, so below-/above-fold in-flow content is reachable and
    // must stay visible. Only position:fixed boxes are pinned to the viewport and do NOT
    // scroll into view — a fixed box parked entirely above or below the viewport is gone.
    if (cs.position === "fixed") {
      const top = bbox.y - scrollY;
      const bottom = top + bbox.height;
      if (bottom <= 0) return false;
      if (top >= vpH) return false;
    }
    return true;
  };

  // A measurement/probe scratch node: out-of-flow (absolute/fixed), parked far off-screen
  // (≥10000px beyond any edge — real drawers/sr-only content never live out there), AND
  // non-painting (visibility:hidden / collapse / opacity:0). The two together are exclusive to
  // font-metric / measurement scratch elements the source's own JS injects (a11y sr-only text
  // stays visibility:visible so AT can read it, so it never matches). Tagged so emission drops it.
  const OFFSCREEN_PROBE_PX = 10000;
  const isProbe = (cs: CSSStyleDeclaration, bbox: RawBBox): boolean => {
    if (cs.position !== "absolute" && cs.position !== "fixed") return false;
    const nonPainting = cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity || "1") === 0;
    if (!nonPainting) return false;
    const rightEdge = bbox.x + bbox.width;
    const bottomEdge = bbox.y + bbox.height;
    const pageH = round2(scrollEl.scrollHeight);
    return rightEdge <= -OFFSCREEN_PROBE_PX || bottomEdge <= -OFFSCREEN_PROBE_PX
      || bbox.x >= OFFSCREEN_PROBE_PX + vpW || bbox.y >= OFFSCREEN_PROBE_PX + pageH;
  };

  const serializeElement = (el: Element): RawNode | null => {
    if (nodeCount >= MAX_NODES) { truncated = true; return null; }
    const tag = el.tagName.toLowerCase();
    nodeCount++;

    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bbox: RawBBox = {
      x: round2(r.x + scrollX),
      y: round2(r.y + scrollY),
      width: round2(r.width),
      height: round2(r.height),
    };

    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      // Drop inline event handlers and inline style (we replay computed style).
      const name = a.name;
      if (name.startsWith("on")) continue;
      attrs[name] = a.value;
    }

    const resolveLH = (style: RawStyle): void => {
      if (style.lineHeight === "normal" && style.fontSize) {
        style.lineHeight = resolveNormalLineHeight(
          style.fontFamily || cs.fontFamily,
          style.fontSize,
          style.fontWeight || "400",
          style.fontStyle || "normal",
        );
      }
    };

    const computed = grabStyle(cs, PROPS);
    resolveLH(computed);

    // Sizing-intent probe: does the browser re-derive this box when we drop its
    // width/height? Ground truth for whether the generator can omit the baked dimension. Run AFTER
    // the canonical cs/bbox are recorded and fully restored after, so the capture is unchanged — it
    // only ADDS three booleans. Skipped for out-of-flow, replaced, hidden, and animated elements.
    let sizing: RawSizing | undefined;
    const probePos = cs.position || "static";
    if (
      (probePos === "static" || probePos === "relative") && r.width > 1 && cs.display !== "none" &&
      (cs.animationName || "none") === "none" && (el as HTMLElement).style &&
      !/^(img|svg|video|canvas|picture|iframe|input|textarea|select|hr|object|embed|br)$/.test(tag)
    ) {
      const h = el as HTMLElement;
      const sw = h.style.getPropertyValue("width"), swp = h.style.getPropertyPriority("width");
      const sh = h.style.getPropertyValue("height"), shp = h.style.getPropertyPriority("height");
      const restore = () => {
        h.style.removeProperty("width"); if (sw) h.style.setProperty("width", sw, swp);
        h.style.removeProperty("height"); if (sh) h.style.setProperty("height", sh, shp);
      };
      try {
        h.style.setProperty("width", "auto", "important");
        const wa = el.getBoundingClientRect().width;
        h.style.setProperty("width", "100%", "important");
        const wf = el.getBoundingClientRect().width;
        // Intrinsic-size anchors (probe 3): min-content (longest unbreakable run) and max-content
        // (no-wrap natural width). A load-bearing width that varies across viewports but stays
        // between these is a fluid law; these are the anchors css.ts fits it from.
        h.style.setProperty("width", "min-content", "important");
        const wmin = el.getBoundingClientRect().width;
        h.style.setProperty("width", "max-content", "important");
        const wmax = el.getBoundingClientRect().width;
        h.style.removeProperty("width"); if (sw) h.style.setProperty("width", sw, swp);
        h.style.setProperty("height", "auto", "important");
        const ha = el.getBoundingClientRect().height;
        h.style.setProperty("height", "100%", "important");
        const hf = el.getBoundingClientRect().height;
        // Tight 0.5px: only call a dimension "reproduced" when auto/100% lands essentially exactly,
        // so a drop can't accumulate a visible shift across many elements (favours fidelity).
        let hAuto = Math.abs(ha - r.height) <= 0.5;
        let hFill = Math.abs(hf - r.height) <= 0.5;
        // Circular-height guard: a box whose fill child (height:100%) pins it back up makes BOTH
        // `height:auto` and `height:100%` reproduce the box, so the raw verdict reads hAuto (drop) —
        // even though the height is authored (e.g. `100vh` on a hero, an explicit px section). Both
        // sides then wait on each other and the box collapses. When this element's own cascade/inline
        // style declares an explicit definite height, trust that declaration: the height is authored,
        // so it is neither content-sized (hAuto) nor a parent fill (hFill). Only overrides when auto
        // actually reproduced — a genuine explicit height that auto already shrinks stays hAuto:false.
        if ((hAuto || hFill) && r.height > 2 && authorsExplicitHeight(el, sh)) {
          hAuto = false;
          hFill = false;
        }
        sizing = {
          wAuto: Math.abs(wa - r.width) <= 0.5, wFill: Math.abs(wf - r.width) <= 0.5, hAuto,
          hFill,
          wMin: Math.round(wmin * 100) / 100, wMax: Math.round(wmax * 100) / 100,
        };
      } finally {
        restore();
      }
    } else if (
      (probePos === "absolute" || probePos === "fixed") && cs.display !== "none" &&
      (cs.animationName || "none") === "none" && (el as HTMLElement).style
    ) {
      // Inset-anchor probe: for an out-of-flow box, per side, does setting that
      // inset to `auto` leave the box exactly in place? If so the inset was a filled-in USED value
      // (the browser resolved it from the containing-block size — `bottom` = page height, `right` =
      // viewport width) that bakes a huge per-viewport number and a band; if the box MOVES, the inset
      // is the authored anchor and must stay. Out-of-flow, so dropping never cascades the in-flow page.
      const h = el as HTMLElement;
      const r0 = el.getBoundingClientRect();
      const drop = { top: false, right: false, bottom: false, left: false };
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const cur = cs[side as "top"];
        if (cur === "auto" || cur == null || cur === "") { drop[side] = true; continue; } // nothing to emit
        const sv = h.style.getPropertyValue(side), svp = h.style.getPropertyPriority(side);
        try {
          h.style.setProperty(side, "auto", "important");
          const r1 = el.getBoundingClientRect();
          drop[side] = Math.abs(r1.left - r0.left) <= 0.5 && Math.abs(r1.top - r0.top) <= 0.5 &&
            Math.abs(r1.width - r0.width) <= 0.5 && Math.abs(r1.height - r0.height) <= 0.5;
        } finally {
          h.style.removeProperty(side); if (sv) h.style.setProperty(side, sv, svp);
        }
      }
      sizing = { wAuto: false, wFill: false, hAuto: false, insetDrop: drop };
    }

    const node: RawNode = {
      tag,
      attrs,
      computed,
      bbox,
      visible: isVisible(el, cs, bbox),
      ...(isProbe(cs, bbox) ? { probe: true } : {}),
      ...(sizing ? { sizing } : {}),
      children: [],
    };

    // Pseudo-elements
    try {
      const before = window.getComputedStyle(el, "::before");
      if (before.content && before.content !== "none" && before.content !== "normal") {
        node.before = grabStyle(before, PSEUDO_PROPS);
        resolveLH(node.before);
      }
      const after = window.getComputedStyle(el, "::after");
      if (after.content && after.content !== "none" && after.content !== "normal") {
        node.after = grabStyle(after, PSEUDO_PROPS);
        resolveLH(node.after);
      }
    } catch { /* ignore */ }

    // ::placeholder: only meaningful on a control that shows placeholder text.
    if ((tag === "input" || tag === "textarea") && (attrs.placeholder || "").trim()) {
      try {
        node.placeholder = grabStyle(window.getComputedStyle(el, "::placeholder"), PLACEHOLDER_PROPS);
      } catch { /* ignore */ }
    }

    // Inline SVG → raw markup, no recursion.
    if (tag === "svg") {
      node.rawHTML = el.outerHTML;
      // Capture the svg root's COMPUTED paint (fill/stroke/color) separately from the general
      // computed-prop list. A raw `fill="none"` presentation attribute paints nothing on its own; a
      // wordmark/icon is visible on the source only because site CSS (a `fill: currentColor` class,
      // an inherited `color`) overrides it. Extraction strips that CSS, so the raw attribute alone is
      // misleading — codegen consults these resolved values to decide whether the root truly paints.
      try {
        node.svgPaint = { fill: cs.fill, stroke: cs.stroke, color: cs.color };
      } catch { /* getComputedStyle already read above; guard against exotic UAs */ }
      return node;
    }

    // Whitespace inside pre/pre-wrap/break-spaces is significant (e.g. multi-line
    // code blocks with highlighted spans separated by newlines).
    const preserveWs = /^(pre|pre-wrap|break-spaces)/.test(cs.whiteSpace || "");

    // Recurse children (elements + text nodes), preserving order.
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent || "";
        if (preserveWs && t.length > 0) {
          node.children.push({ text: t });
        } else if (t.trim().length > 0) {
          node.children.push({ text: t });
        } else if (t.length > 0 && node.children.length > 0) {
          // Preserve a single significant space between inline elements.
          node.children.push({ text: " " });
        } else if (t.length > 0 && (/^inline/.test(cs.display) || INLINE_TEXT_TAGS.has(tag))) {
          // Whitespace that is the FIRST/ONLY child of an inline element still renders
          // (`of<strong> </strong>the` keeps its space); dropping it fuses the adjacent
          // text runs. Scoped to inline parents so block containers stay empty.
          node.children.push({ text: " " });
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childEl = child as Element;
      if (SKIP_TAGS.has(childEl.tagName.toLowerCase())) continue;
      const sn = serializeElement(childEl);
      if (sn) node.children.push(sn);
    }

    return node;
  };

  // ---- Stylesheet introspection (font-faces, css url(), keyframes, vars) ----
  const fontFaces: FontFace[] = [];
  const cssUrlSet = new Set<string>();
  const keyframes: string[] = [];
  const cssVars: Record<string, string> = {};
  // Selectors that AUTHOR an explicit, definite height/min-height (px/rem/em/vh/vw/…,
  // NOT auto, NOT a percentage, NOT a keyword). Harvested once from the cascade below and
  // consulted by the sizing probe to break circular parent/child height verdicts: when a box
  // and its fill child mutually justify each other's height, `height:auto` reproduces the box
  // for a reason that is NOT "content-sized", so the probe alone reads hAuto:true and the
  // authored dimension gets dropped downstream. A declared explicit length is ground truth that
  // the height is load-bearing, so we trust the declaration over the reflow verdict.
  const explicitHeightSelectors: string[] = [];

  const absUrl = (u: string): string => {
    try { return new URL(u, document.baseURI).href; } catch { return u; }
  };

  const harvestUrlsFromText = (text: string): void => {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[2];
      if (!raw || raw.startsWith("data:")) continue;
      cssUrlSet.add(absUrl(raw));
    }
  };

  // True when a `height`/`min-height` value is an explicit, definite length the browser resolves
  // to a fixed px box (px/rem/em/vh/vw/vmin/vmax/ch/…, or a calc/min/max/clamp over them). False for
  // `auto`, an empty value, a pure percentage (resolves against the parent — that's the fill case the
  // hFill probe already handles), `0`, and intrinsic keywords (fit-/min-/max-content). A definite
  // authored height is load-bearing and must survive even when the reflow probe reads hAuto:true.
  const isExplicitHeight = (raw: string): boolean => {
    const v = (raw || "").trim().toLowerCase();
    if (!v || v === "auto" || v === "0" || v === "0px" || v === "none") return false;
    if (v === "fit-content" || v === "min-content" || v === "max-content" || v === "inherit" ||
      v === "initial" || v === "unset" || v === "revert" || v === "revert-layer") return false;
    // A bare percentage resolves against the parent (fill), not an authored definite length.
    if (/^[\d.]+%$/.test(v)) return false;
    // A definite length unit (or a calc()/min()/max()/clamp() that contains one) anchors the box.
    return /(?:^|[\s(*/+-])[\d.]+(?:px|rem|em|vh|vw|vmin|vmax|svh|lvh|dvh|cm|mm|in|pt|pc|ex|ch|q)\b/.test(v);
  };

  // Does this element author an explicit definite height — via its own inline style (passed as
  // `inlineHeight`, already read by the probe) or via any matched cascade rule harvested into
  // `explicitHeightSelectors`? getComputedStyle resolves height to used px (so `100vh` reads as a
  // plain number and is indistinguishable from a content height there); the specified value is only
  // recoverable from the inline declaration and the cascade, which is why we consult both.
  const authorsExplicitHeight = (el: Element, inlineHeight: string): boolean => {
    if (isExplicitHeight(inlineHeight)) return true;
    try {
      const inlineMin = (el as HTMLElement).style?.getPropertyValue("min-height") || "";
      if (isExplicitHeight(inlineMin)) return true;
    } catch { /* ignore */ }
    for (const sel of explicitHeightSelectors) {
      try { if (el.matches(sel)) return true; } catch { /* invalid/unsupported selector */ }
    }
    return false;
  };

  const readRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const type = rule.constructor.name;
      if (type === "CSSFontFaceRule") {
        const r = rule as CSSFontFaceRule;
        const s = r.style;
        const family = (s.getPropertyValue("font-family") || "").trim().replace(/^['"]|['"]$/g, "");
        const src = (s.getPropertyValue("src") || "").trim();
        if (family && src) {
          fontFaces.push({
            family,
            src,
            weight: s.getPropertyValue("font-weight") || undefined,
            style: s.getPropertyValue("font-style") || undefined,
            display: s.getPropertyValue("font-display") || undefined,
            unicodeRange: s.getPropertyValue("unicode-range") || undefined,
            stretch: s.getPropertyValue("font-stretch") || undefined,
          });
          harvestUrlsFromText(src);
        }
      } else if (type === "CSSKeyframesRule") {
        keyframes.push((rule as CSSKeyframesRule).cssText);
      } else if (type === "CSSStyleRule") {
        const r = rule as CSSStyleRule;
        if (r.style && r.style.cssText.includes("url(")) harvestUrlsFromText(r.style.cssText);
        if (r.selectorText && r.style &&
          (isExplicitHeight(r.style.getPropertyValue("height")) ||
            isExplicitHeight(r.style.getPropertyValue("min-height")))) {
          explicitHeightSelectors.push(r.selectorText);
        }
      } else if (type === "CSSMediaRule" || type === "CSSSupportsRule") {
        try { readRules((rule as CSSGroupingRule).cssRules); } catch { /* ignore */ }
      } else if (type === "CSSImportRule") {
        const imp = rule as CSSImportRule;
        try { if (imp.styleSheet) readRules(imp.styleSheet.cssRules); } catch { /* cross-origin */ }
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      readRules(sheet.cssRules);
    } catch {
      // Cross-origin sheet — record its href so the capture layer can fetch the
      // raw text out-of-band and parse font-faces/urls from it.
      if (sheet.href) cssUrlSet.add(absUrl(sheet.href));
    }
  }

  // CSS custom properties declared on :root.
  try {
    const rootCs = window.getComputedStyle(document.documentElement);
    for (let i = 0; i < rootCs.length; i++) {
      const prop = rootCs.item(i);
      if (prop.startsWith("--")) {
        const val = rootCs.getPropertyValue(prop).trim();
        if (val) cssVars[prop] = val;
      }
    }
  } catch { /* ignore */ }

  // ---- DOM asset references ----
  const domAssets: Array<{ kind: string; url: string; via: string }> = [];
  const pushAsset = (kind: string, url: string | null, via: string): void => {
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("data:")) return;
    domAssets.push({ kind, url: absUrl(trimmed), via });
  };
  // Lazy loaders often keep a transparent data: placeholder in src/srcset and park
  // the real URL in data-* until the element scrolls near the viewport. Harvest all
  // known carriers; pushAsset skips placeholders, so this is safe for normal images.
  const harvestSrcset = (kind: string, srcset: string | null, via: string): void => {
    if (!srcset) return;
    for (const part of srcset.split(",")) {
      const u = part.trim().split(/\s+/)[0];
      if (u) pushAsset(kind, u, via);
    }
  };
  for (const img of Array.from(document.querySelectorAll("img"))) {
    pushAsset("image", img.getAttribute("src"), "img[src]");
    pushAsset("image", img.getAttribute("data-lazy-src"), "img[data-lazy-src]");
    pushAsset("image", img.getAttribute("data-src"), "img[data-src]");
    pushAsset("image", img.getAttribute("data-original"), "img[data-original]");
    pushAsset("image", img.getAttribute("data-ll-src"), "img[data-ll-src]");
    harvestSrcset("image", img.getAttribute("srcset"), "img[srcset]");
    harvestSrcset("image", img.getAttribute("data-lazy-srcset"), "img[data-lazy-srcset]");
    harvestSrcset("image", img.getAttribute("data-srcset"), "img[data-srcset]");
  }
  for (const source of Array.from(document.querySelectorAll("source"))) {
    pushAsset("media", source.getAttribute("src"), "source[src]");
    pushAsset("media", source.getAttribute("data-src"), "source[data-src]");
    harvestSrcset("image", source.getAttribute("srcset"), "source[srcset]");
    harvestSrcset("image", source.getAttribute("data-lazy-srcset"), "source[data-lazy-srcset]");
    harvestSrcset("image", source.getAttribute("data-srcset"), "source[data-srcset]");
  }
  for (const video of Array.from(document.querySelectorAll("video"))) {
    pushAsset("video", video.getAttribute("src"), "video[src]");
    pushAsset("image", video.getAttribute("poster"), "video[poster]");
  }
  for (const use of Array.from(document.querySelectorAll("use"))) {
    const href = use.getAttribute("href") || use.getAttribute("xlink:href");
    if (href && !href.startsWith("#")) pushAsset("svg", href, "use[href]");
  }

  const body = document.body;
  const root = serializeElement(body)!;
  lhProbe.remove();

  const htmlCs = window.getComputedStyle(document.documentElement);
  const bodyCs = window.getComputedStyle(body);

  const metaContent = (sel: string): string => (document.querySelector(sel) as HTMLMetaElement | null)?.content || "";
  const linkHref = (sel: string): string => (document.querySelector(sel) as HTMLLinkElement | null)?.href || "";
  const attr = (el: Element, name: string): string | undefined => {
    const v = el.getAttribute(name);
    return v && v.trim() ? v.trim() : undefined;
  };
  const headMeta = Array.from(document.head.querySelectorAll("meta")).map((m) => ({
    ...(attr(m, "name") ? { name: attr(m, "name") } : {}),
    ...(attr(m, "property") ? { property: attr(m, "property") } : {}),
    ...(attr(m, "http-equiv") ? { httpEquiv: attr(m, "http-equiv") } : {}),
    content: (m.getAttribute("content") || "").trim(),
  })).filter((m) => m.content || m.name || m.property || m.httpEquiv);
  const headLinks = Array.from(document.head.querySelectorAll("link[href]")).map((l) => {
    const link = l as HTMLLinkElement;
    return {
      rel: (link.getAttribute("rel") || "").trim(),
      href: link.href || absUrl(link.getAttribute("href") || ""),
      ...(attr(link, "as") ? { as: attr(link, "as") } : {}),
      ...(attr(link, "type") ? { type: attr(link, "type") } : {}),
      ...(attr(link, "sizes") ? { sizes: attr(link, "sizes") } : {}),
      ...(attr(link, "media") ? { media: attr(link, "media") } : {}),
      ...(attr(link, "color") ? { color: attr(link, "color") } : {}),
      ...(attr(link, "hreflang") ? { hrefLang: attr(link, "hreflang") } : {}),
      ...(attr(link, "title") ? { title: attr(link, "title") } : {}),
      ...(attr(link, "crossorigin") ? { crossOrigin: attr(link, "crossorigin") } : {}),
      ...(attr(link, "referrerpolicy") ? { referrerPolicy: attr(link, "referrerpolicy") } : {}),
    };
  }).filter((l) => l.rel || l.href);
  const jsonLd = Array.from(document.querySelectorAll("script[type]")).filter((s) => {
    const type = (s.getAttribute("type") || "").toLowerCase().split(";")[0]!.trim();
    return type === "application/ld+json";
  }).map((s) => ({
    ...(attr(s, "id") ? { id: attr(s, "id") } : {}),
    text: (s.textContent || "").trim(),
  })).filter((s) => s.text);

  for (const link of headLinks) {
    const rel = link.rel.toLowerCase();
    if (/\b(?:icon|shortcut icon|apple-touch-icon|mask-icon)\b/.test(rel)) pushAsset("image", link.href, `head link[rel="${link.rel}"]`);
    if (/\bmanifest\b/.test(rel)) pushAsset("manifest", link.href, `head link[rel="${link.rel}"]`);
  }

  return {
    doc: {
      url: location.href,
      title: document.title || "",
      // SEO head metadata (for the generated app's <metadata>, robots, llms.txt).
      head: {
        description: metaContent('meta[name="description"]'),
        canonical: linkHref('link[rel="canonical"]'),
        ogTitle: metaContent('meta[property="og:title"]'),
        ogDescription: metaContent('meta[property="og:description"]'),
        ogImage: metaContent('meta[property="og:image"]'),
        ogType: metaContent('meta[property="og:type"]'),
        ogSiteName: metaContent('meta[property="og:site_name"]'),
        twitterCard: metaContent('meta[name="twitter:card"]'),
        themeColor: metaContent('meta[name="theme-color"]'),
        keywords: metaContent('meta[name="keywords"]'),
        robots: metaContent('meta[name="robots"]'),
        referrer: metaContent('meta[name="referrer"]'),
        colorScheme: metaContent('meta[name="color-scheme"]'),
        meta: headMeta,
        links: headLinks,
        jsonLd,
      },
      lang: document.documentElement.getAttribute("lang") || "",
      charset: document.characterSet || "UTF-8",
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: round2(document.documentElement.scrollWidth),
      scrollHeight: round2(document.documentElement.scrollHeight),
      htmlBg: htmlCs.backgroundColor,
      bodyBg: bodyCs.backgroundColor,
      bodyColor: bodyCs.color,
      bodyFont: bodyCs.fontFamily,
      metaViewport: (document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null)?.content || "",
      nodeCount,
      truncated,
    },
    root,
    cssVars,
    fontFaces,
    cssUrls: Array.from(cssUrlSet).sort(),
    domAssets,
    keyframes,
  };
}
