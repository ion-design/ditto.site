import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import type { RawSizing } from "../src/capture/walker.js";
import { generateCss, collectNodeRules, RESET_CSS } from "../src/generate/css.js";

const VPS = [375, 1280];
const CANONICAL = 1280;

/** Computed style with the minimum the emitter reads, per viewport. */
function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", listStyleType: "disc", listStylePosition: "outside", ...over };
}

function node(id: string, tag: string, cs: StyleMap, children: IRChild[] = [], visible = true): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { ...cs };
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = visible;
  }
  return { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/css",
      title: "CSS Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: CANONICAL,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
      nodeCount: 4,
      keyframes: [],
    },
    root,
  };
}

/** The base-rule body for a selector (first non-banded `.c<id>{…}` block). */
function baseRule(css: string, id: string): string {
  const m = css.match(new RegExp(`\\.c${id}\\{([^}]*)\\}`));
  return m?.[1] ?? "";
}

// Root scroll-lock un-clamp: a popup vendor locks the page with
// body{position:absolute;overflow:hidden;height:100vh}, which the capture bakes as the body's
// computed style AND collapses document.scrollHeight down to the clamp (so the captured-scrollHeight
// trigger can never fire). The IR's in-flow CONTENT EXTENT (a footer laid out at y=5000) still
// exceeds the clamp, so the un-clamp must fire off that signal and strip the lock.
describe("generateCss root scroll-lock un-clamp (content-extent trigger)", () => {
  it("drops the body height/position/overflow lock when IR content extent exceeds the clamp", () => {
    const footer = node("n1", "footer", computed());
    // Footer sits far below the one-viewport clamp at every viewport.
    for (const vp of VPS) footer.bboxByVp[vp] = { x: 0, y: 4000, width: vp, height: 1000 }; // bottom = 5000
    const bodyCs = computed({ position: "absolute", overflow: "hidden", overflowY: "hidden", height: "812px", top: "0px", left: "0px" });
    const root = node("n0", "body", bodyCs, [footer]);
    for (const vp of VPS) root.bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 812 };
    // perViewport.scrollHeight stays collapsed to 800 (the lock's doing) — so ONLY the content
    // extent can trigger the un-clamp.
    const css = generateCss(irWith(root), new Map());
    const body = baseRule(css, "n0");
    assert.ok(!/height:812px/.test(body), `body height clamp dropped (got: ${body})`);
    assert.ok(!/position:absolute/.test(body), `body position:absolute stripped (got: ${body})`);
    assert.ok(/overflow-y:visible/.test(body), `overflow-y forced visible (got: ${body})`);
    assert.ok(!/overflow:hidden/.test(body), `overflow:hidden not emitted (got: ${body})`);
  });

  it("does NOT un-clamp a genuine one-screen page (content extent within the clamp)", () => {
    const inner = node("n1", "div", computed());
    for (const vp of VPS) inner.bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 700 };
    const bodyCs = computed({ overflow: "hidden", overflowY: "hidden", height: "800px" });
    const root = node("n0", "body", bodyCs, [inner]);
    for (const vp of VPS) root.bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 800 };
    const css = generateCss(irWith(root), new Map());
    const body = baseRule(css, "n0");
    // The clamp is legitimate (content fits) — height kept, overflow not forced to visible.
    assert.ok(/height:800px/.test(body), `legit body height preserved (got: ${body})`);
  });
});

describe("generateCss list markers", () => {
  it("re-establishes list-style on a <ul> whose disc equals the parent's initial value", () => {
    // list-style-type's initial value is `disc` on EVERY element, so a real <ul disc>
    // equals its parent <div>'s computed value — but the reset (`ul, ol, menu
    // { list-style: none; }`) breaks the inheritance chain, so it must still emit.
    const li = node("n2", "li", computed({ display: "list-item" }));
    const ul = node("n1", "ul", computed(), [li]);
    const root = node("n0", "body", computed(), [ul]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(baseRule(css, "n1").includes("list-style-type:disc"));
    // The <li> inherits from the ul (not reset), so parent-equality elision still applies.
    assert.ok(!baseRule(css, "n2").includes("list-style-type"));
  });

  it("does not emit list-style-type on non-list tags at the initial disc", () => {
    const div = node("n1", "div", computed());
    const root = node("n0", "body", computed(), [div]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(!baseRule(css, "n1").includes("list-style-type"));
  });
});

describe("generateCss visibility", () => {
  it("emits visibility:hidden for a node hidden at the canonical viewport", () => {
    const hidden = node("n1", "div", computed({ visibility: "hidden" }), [], false);
    const shown = node("n2", "div", computed());
    const root = node("n0", "body", computed(), [hidden, shown]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(baseRule(css, "n1").includes("visibility:hidden"));
    assert.ok(!baseRule(css, "n2").includes("visibility"));
  });

  it("restores inherited visibility at a band where the node is shown", () => {
    const n = node("n1", "div", computed({ visibility: "hidden" }), [], false);
    n.computedByVp[375]!.visibility = "visible";
    n.visibleByVp[375] = true;
    const root = node("n0", "body", computed(), [n]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(baseRule(css, "n1").includes("visibility:hidden"));
    const band = css.match(/@media \(max-width: \d+px\) \{\n([\s\S]*?)\n\}/);
    assert.ok(band?.[1]?.includes("visibility:inherit"));
  });

  it("stays silent on the descendants of a hidden subtree (inheritance covers them)", () => {
    const child = node("n2", "div", computed({ visibility: "hidden" }), [], false);
    const parent = node("n1", "div", computed({ visibility: "hidden" }), [child], false);
    const root = node("n0", "body", computed(), [parent]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(baseRule(css, "n1").includes("visibility:hidden"));
    assert.ok(!baseRule(css, "n2").includes("visibility"));
  });
});

// Hidden-node banded geometry. A `visibility:hidden` box still PARTICIPATES in layout (unlike
// `display:none`), so the emitter must not let the base rule's baked CANONICAL geometry stand at
// widths where the capture measured something else — that is how a desktop `left:548px` slider
// arrow ends up parked, invisibly, 210px past the right edge of a 375px viewport.
describe("generateCss hidden-node banded geometry", () => {
  const HVPS = [375, 1280, 1920];
  type VpState = { cs?: StyleMap; bbox?: BBox; visible?: boolean };
  function nodeAt(id: string, tag: string, byVp: Record<number, VpState>, children: IRChild[] = []): IRNode {
    const computedByVp: Record<number, StyleMap> = {};
    const bboxByVp: Record<number, BBox> = {};
    const visibleByVp: Record<number, boolean> = {};
    for (const vp of HVPS) {
      const s = byVp[vp] ?? {};
      computedByVp[vp] = computed(s.cs);
      bboxByVp[vp] = s.bbox ?? { x: 0, y: 0, width: vp, height: 100 };
      visibleByVp[vp] = s.visible ?? true;
    }
    return { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
  }
  function ir3(root: IRNode): IR {
    const ir = irWith(root);
    ir.doc.viewports = HVPS;
    ir.doc.sampleViewports = HVPS;
    ir.doc.perViewport = Object.fromEntries(HVPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }]));
    return ir;
  }
  /** The `.c<id>{…}` body inside the first @media block whose query matches `mediaRe`. */
  function bandRule(css: string, mediaRe: RegExp, id: string): string {
    for (const m of css.matchAll(/@media ([^{]+) \{\n([\s\S]*?)\n\}/g)) {
      if (!mediaRe.test(m[1]!)) continue;
      const r = m[2]!.match(new RegExp(`\\.c${id}\\{([^}]*)\\}`));
      if (r) return r[1]!;
    }
    return "";
  }
  const arrowCs = (left: string, hidden: boolean): StyleMap =>
    ({ display: "flex", position: "absolute", left, ...(hidden ? { visibility: "hidden" } : {}) });

  it("emits the captured per-band geometry for a box its own visibility:hidden leaves occupying space", () => {
    // Hidden at base AND at the mobile band with DIFFERENT lefts (the swiper-arrow shape): the
    // band must carry the mobile left, not inherit the baked canonical one.
    const arrow = nodeAt("n1", "div", {
      375: { cs: arrowCs("37px", true), bbox: { x: 37, y: 0, width: 46, height: 46 }, visible: false },
      1280: { cs: arrowCs("548px", true), bbox: { x: 548, y: 0, width: 46, height: 46 }, visible: false },
      1920: { cs: arrowCs("588px", false), bbox: { x: 588, y: 0, width: 46, height: 46 } },
    });
    const root = nodeAt("n0", "body", { 1280: { cs: { position: "relative" } } }, [arrow]);
    const css = generateCss(ir3(root), new Map());
    assert.ok(baseRule(css, "n1").includes("visibility:hidden"));
    assert.ok(baseRule(css, "n1").includes("left:548px"));
    const mobile = bandRule(css, /max-width/, "n1");
    assert.ok(mobile.includes("left:37px"), `mobile band should carry the captured left, got: ${mobile}`);
    assert.ok(!mobile.includes("display:none"), "an occupying hidden box must stay in layout");
    // The wide band where the node becomes visible keeps working: visibility restored + its left.
    const wide = bandRule(css, /min-width/, "n1");
    assert.ok(wide.includes("visibility:inherit"), `wide band should restore visibility, got: ${wide}`);
    assert.ok(wide.includes("left:588px"), `wide band should carry the 1920 left, got: ${wide}`);
  });

  it("hides a visibility:hidden box whose captured bbox is 0x0 with display:none at that band", () => {
    // At 375 the hidden arrow occupied NOTHING (uninitialised swiper) — display:none reproduces
    // "renders nothing, takes no space" and cannot extend the scrollable area.
    const arrow = nodeAt("n1", "div", {
      375: { cs: arrowCs("calc(50% - 52px)", true), bbox: { x: 0, y: 0, width: 0, height: 0 }, visible: false },
      1280: { cs: arrowCs("548px", true), bbox: { x: 548, y: 0, width: 46, height: 46 }, visible: false },
      1920: { cs: arrowCs("588px", false), bbox: { x: 588, y: 0, width: 46, height: 46 } },
    });
    const root = nodeAt("n0", "body", { 1280: { cs: { position: "relative" } } }, [arrow]);
    const css = generateCss(ir3(root), new Map());
    const mobile = bandRule(css, /max-width/, "n1");
    assert.ok(mobile.includes("display:none"), `0x0 hidden band should be display:none, got: ${mobile}`);
    const wide = bandRule(css, /min-width/, "n1");
    assert.ok(wide.includes("visibility:inherit") && wide.includes("left:588px"));
  });

  it("emits display:none at a band where the node turns display:none even when hidden at base", () => {
    // The base rule bakes an OCCUPYING visibility:hidden box (canonical geometry); without the
    // band that box would render at mobile widths where the source had display:none.
    const wrap = nodeAt("n1", "div", {
      375: { cs: { display: "none", visibility: "hidden" }, bbox: { x: 0, y: 0, width: 0, height: 0 }, visible: false },
      1280: { cs: { visibility: "hidden" }, bbox: { x: 40, y: 0, width: 1200, height: 574 }, visible: false },
      1920: { cs: {}, bbox: { x: 320, y: 0, width: 1280, height: 533 } },
    });
    const root = nodeAt("n0", "body", {}, [wrap]);
    const css = generateCss(ir3(root), new Map());
    assert.ok(baseRule(css, "n1").includes("visibility:hidden"));
    const mobile = bandRule(css, /max-width/, "n1");
    assert.ok(mobile.includes("display:none"), `own display:none band must emit even when hidden at base, got: ${mobile}`);
  });

  it("emits per-band geometry for an occupying box an ancestor hides at base AND at the band", () => {
    // The cropin.com/cotton slider arrow: the elementor-widget ANCESTOR is visibility:hidden at
    // 375/1280 (so the arrow is never ownHidden and never shownAtBase) yet the arrow's absolute
    // box still occupies layout. Without a band the base's canonical left:548px parks it 210px
    // past the right edge of a 375px viewport — the band must carry the captured mobile left.
    const arrow = nodeAt("n2", "div", {
      375: { cs: arrowCs("120px", true), bbox: { x: 112, y: 0, width: 46, height: 46 }, visible: false },
      1280: { cs: arrowCs("548px", true), bbox: { x: 548, y: 0, width: 46, height: 46 }, visible: false },
      1920: { cs: arrowCs("588px", false), bbox: { x: 588, y: 0, width: 46, height: 46 } },
    });
    const parent = nodeAt("n1", "div", {
      375: { cs: { position: "relative", visibility: "hidden" }, visible: false },
      1280: { cs: { position: "relative", visibility: "hidden" }, visible: false },
      1920: { cs: { position: "relative" } },
    }, [arrow]);
    const root = nodeAt("n0", "body", {}, [parent]);
    const css = generateCss(ir3(root), new Map());
    const mobile = bandRule(css, /max-width/, "n2");
    assert.ok(mobile.includes("left:120px"), `mobile band should carry the captured left, got: ${mobile}`);
    assert.ok(!mobile.includes("display:none"), "an occupying hidden box must stay in layout");
  });

  it("still emits only the hide for a box an ANCESTOR's visibility:hidden covers", () => {
    // Inherited hides stay breakpoint noise: the ancestor's own rule (and its geometry
    // correction) covers the subtree — the child emits its hide, not geometry overrides.
    const child = nodeAt("n2", "div", {
      375: { cs: { position: "absolute", left: "10px", visibility: "hidden" }, bbox: { x: 10, y: 0, width: 40, height: 40 }, visible: false },
      1280: { cs: { position: "absolute", left: "500px" }, bbox: { x: 500, y: 0, width: 40, height: 40 } },
      1920: { cs: { position: "absolute", left: "500px" }, bbox: { x: 500, y: 0, width: 40, height: 40 } },
    });
    const parent = nodeAt("n1", "div", {
      375: { cs: { position: "relative", visibility: "hidden" }, visible: false },
      1280: { cs: { position: "relative" } },
      1920: { cs: { position: "relative" } },
    }, [child]);
    const root = nodeAt("n0", "body", {}, [parent]);
    const css = generateCss(ir3(root), new Map());
    const mobile = bandRule(css, /max-width/, "n2");
    assert.ok(mobile.includes("visibility:hidden"), `child should carry the hide, got: ${mobile}`);
    assert.ok(!mobile.includes("left:10px"), `ancestor-hidden child must not emit geometry, got: ${mobile}`);
  });
});

// Fix 1 — mobile nav chip-strip overlap. A horizontally-scrollable flex strip (overflow-x:auto
// flex <ul>) holds nowrap chips; the base viewport can report `min-width:0px` on those flex-item
// chips (e.g. a mobile-only strip collapsed to 0 at desktop). Emitting `min-w-0` lets the chips
// compress below their content width instead of overflowing, collapsing the scroll strip so the
// nowrap chip text collides ("Pizza OvenSpiral Mixe…"). The emitter must suppress `min-w-0` for a
// nowrap flex item inside an overflow-x:auto/scroll flex parent.
describe("generateCss scroll-strip chip min-width", () => {
  it("suppresses min-w-0 on a nowrap chip inside an overflow-x:auto flex strip", () => {
    const chip = node("n2", "li", computed({ display: "list-item", minWidth: "0px", whiteSpace: "nowrap" }));
    const ul = node("n1", "ul", computed({ display: "flex", overflowX: "auto", columnGap: "8px" }), [chip]);
    const root = node("n0", "body", computed(), [ul]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(!baseRule(css, "n2").includes("min-width"), `chip must not carry min-width:0 in a scroll strip, got: ${baseRule(css, "n2")}`);
  });

  it("still emits min-w-0 for a nowrap flex item whose parent does NOT scroll horizontally", () => {
    // A truncation/ellipsis flex child (parent overflow-x:visible) legitimately needs min-w-0 to
    // shrink below content — the fix is scoped to overflow-x:auto/scroll parents, so this is kept.
    const item = node("n2", "div", computed({ minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }));
    const row = node("n1", "div", computed({ display: "flex" }), [item]);
    const root = node("n0", "body", computed(), [row]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(baseRule(css, "n2").includes("min-width:0"), `non-scrolling flex row keeps min-w-0, got: ${baseRule(css, "n2")}`);
  });
});

// Fix 3 — scroll-linked text-fill frozen at end state. A scroll/view-timeline animation reports
// its resolved `animation-duration` as `auto`. The clone has no scroll timeline, so emitting the
// animation-* props makes it jump straight to its END keyframe (fill-mode:both + a 0s time-based
// duration), freezing e.g. a text-fill 100% filled at rest. The emitter must suppress the
// animation-* longhands when animation-duration is `auto`, leaving the captured at-rest statics.
describe("generateCss scroll-timeline animation suppression", () => {
  it("drops animation-* props for an animation-duration:auto (scroll-timeline) node", () => {
    const em = node("n1", "em", computed({
      animationName: "fillAnimation", animationDuration: "auto",
      animationTimingFunction: "linear", animationFillMode: "both",
      backgroundClip: "text",
    }));
    const root = node("n0", "body", computed(), [em]);
    const css = generateCss(irWith(root), new Map());
    const rule = baseRule(css, "n1");
    assert.ok(!rule.includes("animation-name"), `scroll-timeline node must not emit animation-name, got: ${rule}`);
    assert.ok(!rule.includes("animation-duration"), `scroll-timeline node must not emit animation-duration, got: ${rule}`);
  });

  it("still emits animation-* for a normal time-based (finite duration) animation", () => {
    const el = node("n1", "div", computed({
      animationName: "fadeInUp", animationDuration: "1.25s",
      animationTimingFunction: "ease", animationFillMode: "both",
    }));
    const root = node("n0", "body", computed(), [el]);
    const css = generateCss(irWith(root), new Map());
    const rule = baseRule(css, "n1");
    assert.ok(rule.includes("animation-name:fadeInUp"), `time-based reveal keeps its animation, got: ${rule}`);
  });
});

// ---------------------------------------------------------------------------
// Per-viewport node builder (independent bbox / computed / sizing per width) plus a matching
// 3-viewport IR wrapper — the fluid/centring/wrap detectors need ≥2 varying widths to run.
const XVPS = [375, 768, 1280];
type XPerVp = { cs?: StyleMap; bbox: BBox; sizing?: RawSizing; visible?: boolean };
function xNode(id: string, tag: string, byVp: Record<number, XPerVp>, children: IRChild[] = []): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  const sizingByVp: Record<number, RawSizing> = {};
  for (const vp of XVPS) {
    const s = byVp[vp]!;
    computedByVp[vp] = computed(s.cs);
    bboxByVp[vp] = s.bbox;
    visibleByVp[vp] = s.visible ?? true;
    if (s.sizing) sizingByVp[vp] = s.sizing;
  }
  const n: IRNode = { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
  if (Object.keys(sizingByVp).length) n.sizingByVp = sizingByVp;
  return n;
}
function xIr(root: IRNode): IR {
  const ir = irWith(root);
  ir.doc.viewports = XVPS;
  ir.doc.sampleViewports = XVPS;
  ir.doc.perViewport = Object.fromEntries(XVPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }]));
  return ir;
}
/** Every `.c<id>{…}` body (base + banded) concatenated, for asserting a value appears at some vp. */
function allRulesX(css: string, id: string): string {
  const re = new RegExp(`\\.c${id}\\{([^}]*)\\}`, "g");
  let out = "", m: RegExpExecArray | null;
  while ((m = re.exec(css))) out += m[1] + ";";
  return out;
}
/** The `.c<id>{…}` body inside the first @media block whose query matches `mediaRe`. */
function xBandRule(css: string, mediaRe: RegExp, id: string): string {
  for (const m of css.matchAll(/@media ([^{]+) \{\n([\s\S]*?)\n\}/g)) {
    if (!mediaRe.test(m[1]!)) continue;
    const r = m[2]!.match(new RegExp(`\\.c${id}\\{([^}]*)\\}`));
    if (r) return r[1]!;
  }
  return "";
}

// BUG A — a padded pill/section with LITERAL equal side margins (a fraction of the viewport, varying
// across widths) must keep those px margins per band. The width-fill sizing probe is what tells the
// centring detector these are load-bearing spacing, not margin-auto centring slack: on a box the
// probe reads as a container-fill (width:100% reproduces it), `margin:auto` resolves to 0 and would
// blow the box out to full-bleed, deleting the real margins.
describe("generateCss literal-margin vs auto-centring", () => {
  const fill = (): RawSizing => ({ wAuto: false, wFill: true, hAuto: true, hFill: true });
  // A flex parent spanning the whole viewport, holding one padded pill child that fills the space
  // BETWEEN its literal side margins (box + 2×margin == container at every width).
  function pill() {
    const child = xNode("n1", "div", {
      375: { cs: { display: "flex", marginLeft: "15px", marginRight: "15px", width: "345px" }, bbox: { x: 15, y: 0, width: 345, height: 62 }, sizing: fill() },
      768: { cs: { display: "flex", marginLeft: "30.7188px", marginRight: "30.7188px", width: "706.562px" }, bbox: { x: 30.72, y: 0, width: 706.56, height: 62 }, sizing: fill() },
      1280: { cs: { display: "flex", marginLeft: "25.5938px", marginRight: "25.5938px", width: "1228.81px" }, bbox: { x: 25.59, y: 0, width: 1228.81, height: 62 }, sizing: fill() },
    });
    const parent = xNode("n0", "body", {
      375: { cs: { display: "flex" }, bbox: { x: 0, y: 0, width: 375, height: 62 } },
      768: { cs: { display: "flex" }, bbox: { x: 0, y: 0, width: 768, height: 62 } },
      1280: { cs: { display: "flex" }, bbox: { x: 0, y: 0, width: 1280, height: 62 } },
    }, [child]);
    return parent;
  }

  it("keeps the literal px side margins on a width-filling pill (no mx-auto)", () => {
    const css = generateCss(xIr(pill()), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(!/margin-left:auto/.test(all), `filling pill must not be centred with auto margins, got: ${all}`);
    assert.ok(baseRule(css, "n1").includes("margin-left:25.5938px"), `base keeps the 1280 literal margin, got: ${baseRule(css, "n1")}`);
    // The narrowest band (a `max-width` query with no `min-width`) carries the 375-vp literal margin.
    const mobile = xBandRule(css, /^\(max-width/, "n1");
    assert.ok(/margin-left:15px/.test(mobile), `mobile band keeps its literal 15px margin, got: ${mobile}`);
  });

  it("still emits margin:auto for a genuinely centred, width-CONSTRAINED block", () => {
    // Content-sized (not a fill): the probe says width:auto re-derives it, width narrower than the
    // container with symmetric slack that varies with width — real margin-auto centring.
    const auto = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false });
    const child = xNode("n1", "div", {
      375: { cs: { display: "block", marginLeft: "15px", marginRight: "15px", width: "345px" }, bbox: { x: 15, y: 0, width: 345, height: 40 }, sizing: auto() },
      768: { cs: { display: "block", marginLeft: "84px", marginRight: "84px", width: "600px" }, bbox: { x: 84, y: 0, width: 600, height: 40 }, sizing: auto() },
      1280: { cs: { display: "block", marginLeft: "340px", marginRight: "340px", width: "600px" }, bbox: { x: 340, y: 0, width: 600, height: 40 }, sizing: auto() },
    });
    const parent = xNode("n0", "body", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 768, height: 40 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 1280, height: 40 } },
    }, [child]);
    const css = generateCss(xIr(parent), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(/margin-left:auto/.test(all), `a constrained centred block should still auto-centre, got: ${all}`);
  });

  // A centred `max-width` container whose cap is FLUID — `max-width: min(1272px, 100vw − 2·gutter)`
  // resolves to a DIFFERENT px at every width (311/673/1145). The block is centred at every sample
  // (symmetric positive gaps that scale with width). It must auto-centre (`mx-auto`) with per-band
  // caps, NOT freeze to literal per-band `margin-left` (which pins it left at non-captured widths).
  it("auto-centres a container with a per-viewport (fluid) max-width cap", () => {
    // border-box block, max-width per vp, box width == cap, symmetric gaps everywhere.
    const child = xNode("n1", "div", {
      375: { cs: { display: "block", boxSizing: "border-box", maxWidth: "311px", marginLeft: "0px", marginRight: "0px", width: "311px" }, bbox: { x: 32, y: 0, width: 311, height: 200 } },
      768: { cs: { display: "block", boxSizing: "border-box", maxWidth: "673.2px", marginLeft: "0px", marginRight: "0px", width: "673.2px" }, bbox: { x: 47.4, y: 0, width: 673.2, height: 200 } },
      1280: { cs: { display: "block", boxSizing: "border-box", maxWidth: "1145.08px", marginLeft: "0px", marginRight: "0px", width: "1145.08px" }, bbox: { x: 67.46, y: 0, width: 1145.08, height: 200 } },
    });
    const parent = xNode("n0", "body", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 375, height: 200 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 768, height: 200 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 1280, height: 200 } },
    }, [child]);
    const css = generateCss(xIr(parent), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(/margin-left:auto/.test(all), `fluid-cap centred container must auto-centre, got: ${all}`);
    assert.ok(!/margin-left:0?67|margin-left:32px|margin-left:47/.test(all), `must NOT bake literal per-band left margins, got: ${all}`);
    // The per-viewport caps survive as banded max-width (the canonical 1145.08 at base, others banded).
    assert.ok(baseRule(css, "n1").includes("max-width:1145.08px"), `base carries the canonical cap, got: ${baseRule(css, "n1")}`);
    const mobile = xBandRule(css, /^\(max-width/, "n1");
    assert.ok(/max-width:311px/.test(mobile), `mobile band carries its own fluid cap, got: ${mobile}`);
  });
});

// BUG C — a single-line text leaf whose unwrapped width nearly fills its column at every width gets
// `white-space:nowrap`, so a sub-pixel column shortfall in the clone can't wrap it to a second line.
describe("generateCss wrap-vulnerable single-line text", () => {
  // Text bbox exactly fills the column (wMax == avail == bbox.width) at every width, single line
  // (height == line-height), and is genuinely wrappable (wMin < wMax).
  function edgeText(wMin: number) {
    const szAt = (w: number): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false, wMin, wMax: w });
    const leaf = xNode("n1", "div", {
      375: { cs: { display: "block", lineHeight: "24px" }, bbox: { x: 0, y: 0, width: 107.81, height: 24 }, sizing: szAt(107.81) },
      768: { cs: { display: "block", lineHeight: "24px" }, bbox: { x: 0, y: 0, width: 107.81, height: 24 }, sizing: szAt(107.81) },
      1280: { cs: { display: "block", lineHeight: "20px" }, bbox: { x: 0, y: 0, width: 107.81, height: 20 }, sizing: szAt(107.81) },
    }, [{ text: "CEO — Academy" }]);
    const parent = xNode("n0", "body", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 107.81, height: 24 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 107.81, height: 24 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 107.81, height: 20 } },
    }, [leaf]);
    return parent;
  }

  it("emits white-space:nowrap for text flush against its column edge", () => {
    const css = generateCss(xIr(edgeText(58.33)), new Map());
    assert.ok(baseRule(css, "n1").includes("white-space:nowrap"), `edge-flush single-line text should get nowrap, got: ${baseRule(css, "n1")}`);
  });

  it("does NOT emit nowrap for a single unbreakable token (wMin == wMax — can't wrap)", () => {
    const css = generateCss(xIr(edgeText(107.81)), new Map());
    assert.ok(!baseRule(css, "n1").includes("white-space:nowrap"), `an unbreakable token needs no nowrap, got: ${baseRule(css, "n1")}`);
  });

  it("does NOT emit nowrap for a genuinely wrapping multi-line paragraph", () => {
    // Two line boxes tall (height ≈ 2×line-height) → already wrapping, must stay wrappable.
    const wMin = 100, wMax = 400;
    const szAt = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false, wMin, wMax });
    const para = xNode("n1", "p", {
      375: { cs: { display: "block", lineHeight: "24px" }, bbox: { x: 0, y: 0, width: 345, height: 72 }, sizing: szAt() },
      768: { cs: { display: "block", lineHeight: "24px" }, bbox: { x: 0, y: 0, width: 700, height: 48 }, sizing: szAt() },
      1280: { cs: { display: "block", lineHeight: "24px" }, bbox: { x: 0, y: 0, width: 400, height: 48 }, sizing: szAt() },
    }, [{ text: "A longer paragraph that wraps across multiple lines depending on the width." }]);
    const parent = xNode("n0", "body", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 345, height: 72 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 700, height: 48 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 400, height: 48 } },
    }, [para]);
    const css = generateCss(xIr(parent), new Map());
    assert.ok(!allRulesX(css, "n1").includes("white-space:nowrap"), `a wrapping paragraph must not be forced nowrap, got: ${allRulesX(css, "n1")}`);
  });

  it("does NOT emit nowrap for text with comfortable slack in its container", () => {
    const szAt = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false, wMin: 60, wMax: 90 });
    const leaf = xNode("n1", "div", {
      375: { cs: { display: "block", lineHeight: "20px" }, bbox: { x: 0, y: 0, width: 90, height: 20 }, sizing: szAt() },
      768: { cs: { display: "block", lineHeight: "20px" }, bbox: { x: 0, y: 0, width: 90, height: 20 }, sizing: szAt() },
      1280: { cs: { display: "block", lineHeight: "20px" }, bbox: { x: 0, y: 0, width: 90, height: 20 }, sizing: szAt() },
    }, [{ text: "Nav link" }]);
    // Wide container (300px+) — the 90px text has plenty of room, no wrap risk.
    const parent = xNode("n0", "body", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 375, height: 20 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 768, height: 20 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 1280, height: 20 } },
    }, [leaf]);
    const css = generateCss(xIr(parent), new Map());
    assert.ok(!baseRule(css, "n1").includes("white-space:nowrap"), `slack text needs no nowrap, got: ${baseRule(css, "n1")}`);
  });
});

// Cross-band transform identity — a node with a NON-identity transform at one band must emit the
// explicit identity `transform:none` at the bands where the source is untransformed, so the
// transform can't cascade across bands and freeze at a width the source left untransformed.
describe("generateCss cross-band transform identity", () => {
  it("emits transform:none at a band where a node with a non-identity transform elsewhere is identity", () => {
    const el = xNode("n1", "div", {
      375: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
      768: { cs: { transform: "matrix(1, 0, 0, 1, 40, 0)" }, bbox: { x: 40, y: 0, width: 375, height: 40 } },
      1280: { cs: { transform: "matrix(1, 0, 0, 1, 40, 0)" }, bbox: { x: 40, y: 0, width: 375, height: 40 } },
    });
    const root = xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 40 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 40 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 40 } } }, [el]);
    const css = generateCss(xIr(root), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(/transform:matrix/.test(all), `the non-identity transform must be emitted, got: ${all}`);
    assert.ok(/transform:none/.test(all), `the identity band must emit transform:none so it can't cascade, got: ${all}`);
  });

  it("does NOT emit transform:none for a node that is identity at every band", () => {
    const el = xNode("n1", "div", {
      375: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
      768: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
      1280: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
    });
    const root = xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 40 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 40 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 40 } } }, [el]);
    const css = generateCss(xIr(root), new Map());
    assert.ok(!allRulesX(css, "n1").includes("transform:none"), `an always-identity node needs no explicit transform, got: ${allRulesX(css, "n1")}`);
  });
});

// BUG 1 — heightFlows must consult the sizing probe. A circular parent/child pair of authored-height
// boxes (two nested viewport-height containers whose only children are absolutely positioned) used to
// "explain each other away": the outer read content-driven (its content IS the inner box) and the
// inner read stretched (it equals the outer's content height) — both dropped, collapsing a hero to
// 0px. The probe now proves each height authored-explicit (hAuto:false, hFill:false); heightFlows
// bails so both survive.
describe("generateCss circular authored-height (probe bail)", () => {
  const authored = (): RawSizing => ({ wAuto: false, wFill: false, hAuto: false, hFill: false });
  function hero(hByVp: Record<number, number>) {
    // an absolutely-positioned decoration inside the inner box (contributes no in-flow content height)
    const abs = xNode("n3", "div", {
      375: { cs: { position: "absolute" }, bbox: { x: 0, y: 0, width: 375, height: hByVp[375]! } },
      768: { cs: { position: "absolute" }, bbox: { x: 0, y: 0, width: 768, height: hByVp[768]! } },
      1280: { cs: { position: "absolute" }, bbox: { x: 0, y: 0, width: 1280, height: hByVp[1280]! } },
    });
    const inner = xNode("n2", "div", {
      375: { cs: { display: "flex", height: `${hByVp[375]}px` }, bbox: { x: 0, y: 0, width: 375, height: hByVp[375]! }, sizing: authored() },
      768: { cs: { display: "flex", height: `${hByVp[768]}px` }, bbox: { x: 0, y: 0, width: 768, height: hByVp[768]! }, sizing: authored() },
      1280: { cs: { display: "flex", height: `${hByVp[1280]}px` }, bbox: { x: 0, y: 0, width: 1280, height: hByVp[1280]! }, sizing: authored() },
    }, [abs]);
    const outer = xNode("n1", "div", {
      375: { cs: { display: "flex", height: `${hByVp[375]}px` }, bbox: { x: 0, y: 0, width: 375, height: hByVp[375]! }, sizing: authored() },
      768: { cs: { display: "flex", height: `${hByVp[768]}px` }, bbox: { x: 0, y: 0, width: 768, height: hByVp[768]! }, sizing: authored() },
      1280: { cs: { display: "flex", height: `${hByVp[1280]}px` }, bbox: { x: 0, y: 0, width: 1280, height: hByVp[1280]! }, sizing: authored() },
    }, [inner]);
    return xNode("n0", "body", {
      375: { bbox: { x: 0, y: 0, width: 375, height: hByVp[375]! } },
      768: { bbox: { x: 0, y: 0, width: 768, height: hByVp[768]! } },
      1280: { bbox: { x: 0, y: 0, width: 1280, height: hByVp[1280]! } },
    }, [outer]);
  }

  it("keeps both heights when the probe proves them authored-explicit", () => {
    const css = generateCss(xIr(hero({ 375: 771, 768: 900, 1280: 800 })), new Map());
    const outer = allRulesX(css, "n1");
    const inner = allRulesX(css, "n2");
    assert.ok(/height:800px/.test(outer), `outer must keep its canonical authored height, got: ${outer}`);
    assert.ok(/height:800px/.test(inner), `inner must keep its canonical authored height, got: ${inner}`);
  });

  it("still flows a genuinely content-sized varying height (probe hAuto:true)", () => {
    // Same shape but the probe says auto reproduces the box — the varying height is real content, safe
    // to drop. Give it an in-flow text child so it reads content-driven.
    const auto = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false });
    const mk = (h: number, w: number): XPerVp => ({ cs: { display: "block", height: `${h}px` }, bbox: { x: 0, y: 0, width: w, height: h }, sizing: auto() });
    const inner = xNode("n2", "div", { 375: mk(200, 375), 768: mk(260, 768), 1280: mk(320, 1280) }, [{ text: "flowing content" } as IRChild]);
    // pad the box so height == content is plausible per contentDriven's text branch
    const root = xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 200 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 260 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 320 } } }, [inner]);
    const css = generateCss(xIr(root), new Map());
    assert.ok(!/height:320px/.test(allRulesX(css, "n2")), `a probe-auto content height should still flow, got: ${allRulesX(css, "n2")}`);
  });
});

// BUG 2 — a space-distributing flex column (justify-content: space-between/around/evenly, or a packed
// center/flex-end) sets the free space its children spread through, so the last child reaching the box
// bottom is NOT content evidence. heightFlows used to read that as content-driven and drop the box's
// authored height, collapsing the distributed gaps.
describe("generateCss space-distributing flex column keeps its height", () => {
  // hAuto:true (auto reproduces the box at capture, because distribution places the last child at the
  // bottom) — so the sizing probe does NOT forbid the drop. Wrappable text inside makes heightProbeDrops
  // abstain, isolating heightFlows' space-distribution disqualification as the sole arbiter.
  const auto = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false });
  const textChild = { text: "a line of distributed content" } as IRChild;
  function distributed(justify: string) {
    // two content-sized blocks; the last sits at the box bottom because the column distributes space
    const top = xNode("n2", "div", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 375, height: 40 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 768, height: 40 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 1280, height: 40 } },
    }, [textChild]);
    const bottomH = (h: number): XPerVp => ({ cs: { display: "block" }, bbox: { x: 0, y: h - 40, width: 375, height: 40 } });
    const bot = xNode("n3", "div", { 375: bottomH(360), 768: bottomH(500), 1280: bottomH(600) }, [textChild]);
    const col = xNode("n1", "div", {
      375: { cs: { display: "flex", flexDirection: "column", justifyContent: justify, height: "360px" }, bbox: { x: 0, y: 0, width: 375, height: 360 }, sizing: auto() },
      768: { cs: { display: "flex", flexDirection: "column", justifyContent: justify, height: "500px" }, bbox: { x: 0, y: 0, width: 768, height: 500 }, sizing: auto() },
      1280: { cs: { display: "flex", flexDirection: "column", justifyContent: justify, height: "600px" }, bbox: { x: 0, y: 0, width: 1280, height: 600 }, sizing: auto() },
    }, [top, bot]);
    return xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 360 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 500 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 600 } } }, [col]);
  }

  for (const j of ["space-between", "space-around", "space-evenly"]) {
    it(`keeps the authored height under justify-content:${j}`, () => {
      const css = generateCss(xIr(distributed(j)), new Map());
      assert.ok(/height:600px/.test(allRulesX(css, "n1")), `${j} column must keep its distributing height, got: ${allRulesX(css, "n1")}`);
    });
  }

  it("still flows a flex-start column whose height truly equals its content", () => {
    // justify-content:flex-start (default) — the last child at the bottom IS content-driven, so the
    // varying height flows (drops) as before.
    const css = generateCss(xIr(distributed("flex-start")), new Map());
    assert.ok(!/height:600px/.test(allRulesX(css, "n1")), `a packed-top column should still flow, got: ${allRulesX(css, "n1")}`);
  });
});

// BUG 3 — a lottie mount pins its captured per-viewport height so the runtime player's aspect-sized
// svg fills a definite box instead of inflating past its neighbours. Threaded via collectNodeRules'
// lottieMounts set (populated from the lottie spec item cids).
describe("collectNodeRules lottie mount height pin", () => {
  const auto = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false });
  function mountFixture() {
    // the mount is a flex box; its only child is a content-sized placeholder svg — without the pin the
    // box height flows/collapses and the runtime svg inflates by aspect.
    const svg = xNode("n2", "svg", {
      375: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 375, height: 94 } },
      768: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 768, height: 195 } },
      1280: { cs: { display: "block" }, bbox: { x: 0, y: 0, width: 1280, height: 227 } },
    });
    const mount = xNode("n1", "div", {
      375: { cs: { display: "flex", height: "94px" }, bbox: { x: 0, y: 0, width: 375, height: 94 }, sizing: auto() },
      768: { cs: { display: "flex", height: "195px" }, bbox: { x: 0, y: 0, width: 768, height: 195 }, sizing: auto() },
      1280: { cs: { display: "flex", height: "227px" }, bbox: { x: 0, y: 0, width: 1280, height: 227 }, sizing: auto() },
    }, [svg]);
    return xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 94 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 195 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 227 } } }, [mount]);
  }

  it("pins the captured height on a mount node", () => {
    const rules = collectNodeRules(xIr(mountFixture()), new Map(), undefined, undefined, undefined, false, new Set(["n1"]));
    const nr = rules.get("n1");
    assert.ok(nr, "mount rule must exist");
    const all = [nr!.base.get("height"), ...nr!.bands.map((b) => b.decls.get("height"))].filter(Boolean).join(";");
    assert.ok(/227px/.test(all), `canonical mount height must be pinned, got: ${all}`);
    assert.ok(/94px/.test(all), `narrow-band mount height must be pinned, got: ${all}`);
  });

  it("leaves a non-mount box unpinned (flows its varying content height)", () => {
    const rules = collectNodeRules(xIr(mountFixture()), new Map(), undefined, undefined, undefined, false, new Set());
    const nr = rules.get("n1")!;
    const all = [nr.base.get("height"), ...nr.bands.map((b) => b.decls.get("height"))].filter(Boolean).join(";");
    assert.ok(!/227px/.test(all), `without the mount flag the varying height should flow, got: ${all}`);
  });
});

// The reset ships a rule that forces the lottie runtime svg/canvas to fit its overlay box. The
// player re-mounts its media into an absolute overlay that fills the host's pinned (per-viewport)
// height; without this rule an aspect-mismatched viewBox (a portrait animation in a shorter,
// letterboxed source box) inflates past that height. Scoped to the runtime-marked host only, so it
// is inert when a page has no lottie.
describe("RESET_CSS lottie runtime-fit rule", () => {
  it("constrains the runtime svg/canvas to the overlay box, scoped to the marked host", () => {
    assert.match(RESET_CSS, /\[data-ditto-lottie\]\s*>\s*div\s*>\s*svg/);
    assert.match(RESET_CSS, /\[data-ditto-lottie\]\s*>\s*div\s*>\s*canvas/);
    // the rule must pin both dimensions so height:100% resolves against the definite overlay
    const m = RESET_CSS.match(/\[data-ditto-lottie\][^{]*\{([^}]*)\}/);
    assert.ok(m, "the data-ditto-lottie rule must be present");
    assert.match(m![1], /width:\s*100%/);
    assert.match(m![1], /height:\s*100%/);
  });

  it("does not affect the pre-swap placeholder (a direct-child svg, not nested under a div)", () => {
    // The selector targets `> div > svg` (the runtime overlay), never a `> svg` placeholder, so the
    // captured placeholder keeps its own pinned classes and pre/post-swap geometry stays identical.
    assert.ok(
      !/\[data-ditto-lottie\]\s*>\s*svg\b/.test(RESET_CSS),
      "the rule must not target a direct-child placeholder svg",
    );
  });
});

// Defect E — a content-sized flex ROW's items are dropped to `width:auto` only when NO shrink fired
// (positive slack ⇒ items at content size). But a WRAPPING text leaf paints at its balanced-wrap
// width, which is BELOW its max-content: `width:auto` on the block child fills the line to
// max-content and left-aligns it, so the narrow right-pushed paragraph blows out to full-width. The
// sizing probe already read `wAuto:false` (auto does NOT reproduce the width); it must veto the
// whole line (the rule is all-or-nothing — dropping a subset shifts siblings via justify-content).
describe("generateCss content-sized flex row (probe veto for wrapping text)", () => {
  // One <p> child, sole item of a `flex; justify-content:flex-end` row, `flex:0 1 auto`, that paints
  // narrower than the container at every width (wraps below max-content) with positive slack.
  function missionRow(pSizing: RawSizing) {
    const p = xNode("n1", "p", {
      375: { cs: { display: "block", flexGrow: "0", flexShrink: "1", flexBasis: "auto", width: "276px" }, bbox: { x: 69, y: 0, width: 276, height: 80 }, sizing: pSizing },
      768: { cs: { display: "block", flexGrow: "0", flexShrink: "1", flexBasis: "auto", width: "529.922px" }, bbox: { x: 176, y: 0, width: 529.92, height: 60 }, sizing: pSizing },
      1280: { cs: { display: "block", flexGrow: "0", flexShrink: "1", flexBasis: "auto", width: "774.141px" }, bbox: { x: 455, y: 0, width: 774.14, height: 40 }, sizing: pSizing },
    }, [{ text: "Our UX staffing and recruiting teams place the best talent from around the world." }]);
    return xNode("n0", "body", {
      375: { cs: { display: "flex", flexDirection: "row", justifyContent: "flex-end" }, bbox: { x: 0, y: 0, width: 375, height: 80 } },
      768: { cs: { display: "flex", flexDirection: "row", justifyContent: "flex-end" }, bbox: { x: 0, y: 0, width: 706.56, height: 60 } },
      1280: { cs: { display: "flex", flexDirection: "row", justifyContent: "flex-end" }, bbox: { x: 0, y: 0, width: 1228.81, height: 40 } },
    }, [p]);
  }

  it("keeps a width on a wrapping paragraph the probe proved is not auto-reproducible", () => {
    // Probe ground truth: width:auto does NOT reproduce (wAuto:false) — the painted width is the
    // balanced-wrap width, below max-content (wMax).
    const notAuto = (): RawSizing => ({ wAuto: false, wFill: false, hAuto: true, hFill: false, wMin: 95.88, wMax: 706.56 });
    const css = generateCss(xIr(missionRow(notAuto())), new Map());
    const all = allRulesX(css, "n1");
    // It must NOT be emitted as content-auto (which drops width entirely and fills the line). The
    // width plan falls to a real width — a fluid percentage or baked px — so the narrow column survives.
    assert.ok(/width:/.test(all), `wrapping paragraph must keep a width, not collapse to auto, got: ${all}`);
    assert.ok(!/width:auto/.test(all), `probe said wAuto:false — must not emit width:auto, got: ${all}`);
  });

  it("still drops width:auto on a genuinely content-sized row item the probe confirms", () => {
    // Probe agrees width:auto reproduces (wAuto:true) — a toolbar/menu item whose width is its
    // content. The content-sized-flex-row law should still fire and emit auto (no baked px band).
    const isAuto = (): RawSizing => ({ wAuto: true, wFill: false, hAuto: true, hFill: false, wMin: 95.88, wMax: 706.56 });
    const css = generateCss(xIr(missionRow(isAuto())), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(!/width:\d/.test(all), `content-sized item must drop its baked px width, got: ${all}`);
  });
});

// Defect C (generate side) — a CSS marquee (infinite `@keyframes` animation) gated to a breakpoint
// (Webflow's `max-lg` logo/text tracks) is `animation:none` at the base but runs at the narrow band.
// The per-band transform delta at the animated width is a FROZEN mid-scroll phase; it must be
// suppressed so the base holds and the runtime keyframes drive the transform (from translateX(0)).
// (The upstream normalize pass zeroes the base residue — see neutralizeAnimatedTransforms; here the
// base is already `none`, and this test covers the band-delta suppression.)
describe("generateCss breakpoint-gated marquee transform band suppression (Defect C)", () => {
  function logoStrip() {
    const strip = xNode("n1", "div", {
      375: { cs: { display: "grid", animationName: "track", animationIterationCount: "infinite", animationDuration: "35s", transform: "matrix(1, 0, 0, 1, -284.025, 0)" }, bbox: { x: 0, y: 0, width: 345, height: 100 } },
      768: { cs: { display: "grid", animationName: "track", animationIterationCount: "infinite", animationDuration: "35s", transform: "matrix(1, 0, 0, 1, -280.982, 0)" }, bbox: { x: 0, y: 0, width: 706, height: 100 } },
      1280: { cs: { display: "grid", animationName: "none", animationIterationCount: "1", transform: "none" }, bbox: { x: 0, y: 0, width: 1228, height: 145 } },
    });
    return xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 100 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 100 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 145 } } }, [strip]);
  }

  it("does not bake the frozen mid-scroll translateX at the animated band", () => {
    const css = generateCss(xIr(logoStrip()), new Map());
    const all = allRulesX(css, "n1");
    assert.ok(!/matrix\(1, ?0, ?0, ?1, ?-\d/.test(all), `frozen marquee translateX must not be emitted at any band, got: ${all}`);
  });

  it("keeps a per-band transform of a NON-animated element", () => {
    // A non-animated element whose transform genuinely varies per band keeps it (no animation owns it).
    const el = xNode("n1", "div", {
      375: { cs: { transform: "matrix(1, 0, 0, 1, -40, 0)" }, bbox: { x: -40, y: 0, width: 345, height: 100 } },
      768: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 706, height: 100 } },
      1280: { cs: { transform: "none" }, bbox: { x: 0, y: 0, width: 1228, height: 100 } },
    });
    const root = xNode("n0", "body", { 375: { bbox: { x: 0, y: 0, width: 375, height: 100 } }, 768: { bbox: { x: 0, y: 0, width: 768, height: 100 } }, 1280: { bbox: { x: 0, y: 0, width: 1280, height: 100 } } }, [el]);
    const css = generateCss(xIr(root), new Map());
    assert.ok(/matrix\(1, ?0, ?0, ?1, ?-40/.test(allRulesX(css, "n1")), `a non-animated per-band offset must be kept, got: ${allRulesX(css, "n1")}`);
  });
});

// text-wrap emission: a heading authored `text-wrap:balance` must survive to the clone, or the
// title wraps differently. The initial `wrap` is elided (it's the default), so only authored
// balance/pretty/nowrap ship.
describe("generateCss text-wrap", () => {
  it("emits an authored text-wrap:balance on a heading", () => {
    const h1 = node("n1", "h1", computed({ textWrap: "balance" }));
    const root = node("n0", "body", computed(), [h1]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(/text-wrap:balance/.test(baseRule(css, "n1")), `text-wrap:balance emitted (got: ${baseRule(css, "n1")})`);
  });

  it("emits text-wrap:pretty", () => {
    const p = node("n1", "p", computed({ textWrap: "pretty" }));
    const root = node("n0", "body", computed(), [p]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(/text-wrap:pretty/.test(baseRule(css, "n1")), `text-wrap:pretty emitted (got: ${baseRule(css, "n1")})`);
  });

  it("elides the default text-wrap:wrap (no noise)", () => {
    const h1 = node("n1", "h1", computed({ textWrap: "wrap" }));
    const root = node("n0", "body", computed(), [h1]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(!/text-wrap/.test(baseRule(css, "n1")), `default text-wrap:wrap must not be emitted (got: ${baseRule(css, "n1")})`);
  });

  it("skips text-wrap on a child when it equals the parent (inherited)", () => {
    // text-wrap is inherited: a child matching the parent's balance relies on inheritance.
    const child = node("n2", "span", computed({ textWrap: "balance" }));
    const h1 = node("n1", "h1", computed({ textWrap: "balance" }), [child]);
    const root = node("n0", "body", computed(), [h1]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(/text-wrap:balance/.test(baseRule(css, "n1")), "parent heading emits balance");
    assert.ok(!/text-wrap/.test(baseRule(css, "n2")), `inherited child does not re-emit (got: ${baseRule(css, "n2")})`);
  });
});

// FIX 4 — a library-sized carousel slide (a shrink-0 flex item with an injected inline `width:Npx`)
// whose only in-flow child is a display:block box. A block box's `width:auto` IS its fill width, so
// the sizing probe reports the child wAuto AND wFill both true. The circular-slide detector must count
// that block-level fill child as width-DERIVING (it never establishes a width) and pin the slide's
// captured px — otherwise the guard misreads the child as a genuine content-width source, bails, and
// the slide content-sizes to a different width (ragged carousel rails).
describe("generateCss circular carousel slide with a block-level fill child (FIX 4)", () => {
  // The slide's child is display:block: its auto width equals the fill width, so BOTH probe bits fire.
  const blockFill = (): RawSizing => ({ wAuto: true, wFill: true, hAuto: true, hFill: true });
  function slideRow() {
    // Uniform 220px slides at every viewport (Splide's inline width) inside a flex track.
    const mkSlide = (id: string, childId: string): IRNode => {
      const child = xNode(childId, "div", {
        375: { cs: { display: "block", position: "static" }, bbox: { x: 0, y: 0, width: 220, height: 357 }, sizing: blockFill() },
        768: { cs: { display: "block", position: "static" }, bbox: { x: 0, y: 0, width: 220, height: 357 }, sizing: blockFill() },
        1280: { cs: { display: "block", position: "static" }, bbox: { x: 0, y: 0, width: 220, height: 357 }, sizing: blockFill() },
      }, [{ text: "Men's Tops & Shirts" } as IRChild]);
      const slideCs = { display: "block", position: "static", flexShrink: "0", width: "220px" };
      return xNode(id, "div", {
        375: { cs: slideCs, bbox: { x: 0, y: 0, width: 220, height: 357 } },
        768: { cs: slideCs, bbox: { x: 0, y: 0, width: 220, height: 357 } },
        1280: { cs: slideCs, bbox: { x: 0, y: 0, width: 220, height: 357 } },
      }, [child]);
    };
    const trackCs = { display: "flex", position: "static" };
    const track = xNode("n1", "ul", {
      375: { cs: trackCs, bbox: { x: 0, y: 0, width: 375, height: 357 } },
      768: { cs: trackCs, bbox: { x: 0, y: 0, width: 768, height: 357 } },
      1280: { cs: trackCs, bbox: { x: 0, y: 0, width: 1280, height: 357 } },
    }, [mkSlide("n2", "n3"), mkSlide("n4", "n5")]);
    return xNode("n0", "body", {
      375: { bbox: { x: 0, y: 0, width: 375, height: 357 } },
      768: { bbox: { x: 0, y: 0, width: 768, height: 357 } },
      1280: { bbox: { x: 0, y: 0, width: 1280, height: 357 } },
    }, [track]);
  }

  it("pins the slide's captured width even though its block child reports wAuto:true", () => {
    const css = generateCss(xIr(slideRow()), new Map());
    const slide = allRulesX(css, "n2");
    assert.ok(/width:220px/.test(slide), `the library-sized slide must keep its 220px width, got: ${slide}`);
  });
});
