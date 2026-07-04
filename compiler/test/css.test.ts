import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import { generateCss } from "../src/generate/css.js";

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
