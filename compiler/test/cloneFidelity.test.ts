import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import type { RawSizing } from "../src/capture/walker.js";
import { generateCss } from "../src/generate/css.js";

// Two-plus viewports so the per-vp fluid detectors (grid-template solve, width probe) can run.
const VPS = [375, 768, 1280];
const CANONICAL = 1280;

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", listStyleType: "disc", listStylePosition: "outside", ...over };
}

type PerVp = { cs?: StyleMap; bbox: BBox; sizing?: RawSizing; visible?: boolean };

/** Build a node with independent per-viewport computed style / bbox / sizing probe. */
function vpNode(id: string, tag: string, byVp: Record<number, PerVp>, children: IRChild[] = []): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  const sizingByVp: Record<number, RawSizing> = {};
  for (const vp of VPS) {
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

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/fidelity",
      title: "Fidelity Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: CANONICAL,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 4000, scrollWidth: vp, htmlBg: "rgb(255,255,255)", bodyBg: "rgb(255,255,255)", bodyColor: "rgb(0,0,0)", bodyFont: "Arial" }])),
      nodeCount: 8,
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
/** Every `.c<id>{…}` body (base + banded) concatenated, for asserting a value appears at some vp. */
function allRules(css: string, id: string): string {
  const re = new RegExp(`\\.c${id}\\{([^}]*)\\}`, "g");
  let out = "", m: RegExpExecArray | null;
  while ((m = re.exec(css))) out += m[1] + ";";
  return out;
}

const fills = (): RawSizing => ({ wAuto: false, wFill: true, hAuto: false, hFill: true });

// ---------------------------------------------------------------------------
// FIX 1 — circular shrink-0 carousel slide keeps a definite width
// ---------------------------------------------------------------------------
describe("FIX 1: circular carousel slide width pinning", () => {
  // Track (flex) → slide <a> (shrink-0, probe says fill/auto) → inner (w-full h-full).
  // The probe would drop the slide width; with an all-fill child it must instead be pinned.
  function build(slideChildSizing: RawSizing, slideShrink = "0"): IR {
    const slideW = { 375: 300, 768: 400, 1280: 566 } as Record<number, number>;
    const inner = vpNode("n486", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", width: `${slideW[vp]}px`, height: "640px", aspectRatio: "1 / 1" },
      bbox: { x: 0, y: 0, width: slideW[vp]!, height: 640 },
      sizing: slideChildSizing,
    }])) as Record<number, PerVp>);
    const slide = vpNode("n485", "a", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", width: `${slideW[vp]}px`, height: "640px", flexShrink: slideShrink },
      bbox: { x: 0, y: 0, width: slideW[vp]!, height: 640 },
      // probe reads the slide as fill+content (Splide inline px looks derivable)
      sizing: { wAuto: true, wFill: true, hAuto: true, hFill: false },
    }])) as Record<number, PerVp>, [inner]);
    const track = vpNode("n484", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "flex", position: "static", width: `${vp}px`, height: "640px" },
      bbox: { x: 0, y: 0, width: vp, height: 640 },
    }])) as Record<number, PerVp>, [slide]);
    return irWith(track);
  }

  it("pins the captured px width on a shrink-0 slide whose only child fills it", () => {
    const css = generateCss(build(fills()), new Map());
    const rules = allRules(css, "n485");
    // The captured canonical width (566px) must be emitted somewhere — not dropped to 100%/auto.
    assert.match(rules, /width:\s*566px/, `slide should keep its captured width; got: ${rules}`);
    assert.doesNotMatch(baseRule(css, "n485"), /width:\s*100%/);
  });

  it("does NOT pin when the child is a real in-flow content box (genuine width source)", () => {
    // Child sizes to its own content (wAuto true, wFill false) → not the circular case.
    const contentChild: RawSizing = { wAuto: true, wFill: false, hAuto: true, hFill: false };
    const css = generateCss(build(contentChild), new Map());
    const rules = allRules(css, "n485");
    // With a genuine width source, the probe verdict is honored — no forced 566px pin.
    assert.doesNotMatch(baseRule(css, "n485"), /width:\s*566px/, `content-child slide must not be force-pinned; got: ${rules}`);
  });

  it("does NOT pin a shrinkable (shrink:1) item even with a fill child", () => {
    const css = generateCss(build(fills(), "1"), new Map());
    assert.doesNotMatch(baseRule(css, "n485"), /width:\s*566px/);
  });
});

describe("FIX 1b: full-width shrink-0 carousel slide gets flex-basis:100%", () => {
  // Flex list → shrink-0 slide whose border box FILLS the list (a full-viewport hero slide).
  function build(): IR {
    const slide = vpNode("n200", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", width: `${vp}px`, flexShrink: "0" },
      bbox: { x: 0, y: 0, width: vp, height: 462 },
      sizing: { wAuto: false, wFill: true, hAuto: true, hFill: false },
    }])) as Record<number, PerVp>);
    const list = vpNode("n199", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "flex", position: "static", flexDirection: "row", width: `${vp}px` },
      bbox: { x: 0, y: 0, width: vp, height: 462 },
    }])) as Record<number, PerVp>, [slide]);
    return irWith(list);
  }

  it("emits flex-basis:100% + flex-shrink:0 (not width:100%) for a container-filling shrink-0 slide", () => {
    const rules = allRules(generateCss(build(), new Map()), "n200");
    assert.match(rules, /flex-basis:\s*100%/, `full-width slide should get flex-basis:100%; got: ${rules}`);
    assert.doesNotMatch(rules, /(?<!max-)width:\s*100%/, "should not use width:100% (flex max-content over-widening)");
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — fixed-track scroll grid keeps its px template; fluid grid still fr
// ---------------------------------------------------------------------------
describe("FIX 2: fixed-track scroll grid vs fluid equal-track grid", () => {
  // N equal tracks. `content` is the container content width; `sum` is total track+gap extent.
  function gridNode(id: string, perVp: Record<number, { count: number; track: number; gap: number; content: number }>): IRNode {
    return vpNode(id, "div", Object.fromEntries(VPS.map((vp) => {
      const g = perVp[vp]!;
      const cols = new Array(g.count).fill(`${g.track}px`).join(" ");
      return [vp, {
        cs: { display: "grid", position: "static", gridTemplateColumns: cols, columnGap: `${g.gap}px`, width: `${g.content}px`, overflowX: "auto" },
        bbox: { x: 0, y: 0, width: g.content, height: 300 },
      }];
    })) as Record<number, PerVp>);
  }

  it("keeps the baked px template for a scrolling grid whose tracks overflow the container", () => {
    // 50 tracks of 173.5px in a ~1066px container = 8675px of scrolling content.
    const css = generateCss(irWith(gridNode("n550", {
      375: { count: 50, track: 132.9, gap: 0, content: 326 },
      768: { count: 50, track: 106.2, gap: 0, content: 662 },
      1280: { count: 50, track: 173.5, gap: 0, content: 1066 },
    })), new Map());
    const rules = allRules(css, "n550");
    assert.doesNotMatch(rules, /repeat\(50,/, `scrolling grid must not be rewritten as repeat(50,1fr); got: ${rules.slice(0, 200)}`);
    assert.match(rules, /173\.5px/, "scrolling grid should keep its baked fixed-px tracks");
  });

  it("rewrites a single fixed-px full-bleed track as minmax(0,1fr) even on a custom-element grid", () => {
    // uwp-carousel: one track == viewport width, baked per breakpoint. Must become a fill track.
    const carousel = vpNode("n196", "uwp-carousel", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "grid", position: "relative", gridTemplateColumns: `${vp}px`, columnGap: "normal", width: `${vp}px`, paddingLeft: "0px", paddingRight: "0px" },
      bbox: { x: 0, y: 0, width: vp, height: 462 },
    }])) as Record<number, PerVp>);
    const rules = allRules(generateCss(irWith(carousel), new Map()), "n196");
    assert.match(rules, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, `single full-bleed track should fill: ${rules.slice(0, 200)}`);
    assert.doesNotMatch(rules, /grid-template-columns:\s*\d/, "should not keep a baked px single track");
  });

  it("still rewrites a genuinely fluid equal-track grid as repeat(N, 1fr)", () => {
    // 3 equal tracks that FILL the container (sum+gaps == content) at every width.
    const css = generateCss(irWith(gridNode("n700", {
      375: { count: 3, track: (375 - 2 * 16) / 3, gap: 16, content: 375 },
      768: { count: 3, track: (768 - 2 * 16) / 3, gap: 16, content: 768 },
      1280: { count: 3, track: (1280 - 2 * 16) / 3, gap: 16, content: 1280 },
    })), new Map());
    const rules = allRules(css, "n700");
    assert.match(rules, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/, `filling equal-track grid should become repeat(3,1fr); got: ${rules.slice(0, 200)}`);
  });
});

// ---------------------------------------------------------------------------
// FIX 3b — inset-spanned absolute box with an aspect-ratio fills (width:100%)
// instead of width:auto (which back-computes width from height × aspect and
// over-widens at unsampled probe widths — the full-bleed responsive violations).
// ---------------------------------------------------------------------------
describe("FIX 3b: inset-spanned + aspect-ratio full-bleed box", () => {
  // Positioned parent → absolute child (inset-x-0) that stretches to the parent width at every vp.
  function bleed(childAspect?: string): IR {
    const child = vpNode("n202", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: {
        display: "block", position: "absolute", top: "0px", left: "0px", right: "0px",
        minHeight: "462px", ...(childAspect ? { aspectRatio: childAspect } : {}),
      },
      bbox: { x: 0, y: 0, width: vp, height: 462 },
    }])) as Record<number, PerVp>);
    const parent = vpNode("n201", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", width: `${vp}px` },
      bbox: { x: 0, y: 0, width: vp, height: 462 },
    }])) as Record<number, PerVp>, [child]);
    return irWith(parent);
  }

  it("emits width:100% for an inset-spanned absolute box that carries an aspect-ratio", () => {
    const css = generateCss(bleed("16 / 9"), new Map());
    assert.match(baseRule(css, "n202"), /width:\s*100%/, `aspect full-bleed box should fill: ${baseRule(css, "n202")}`);
  });

  it("keeps width:auto for an inset-spanned box with NO aspect-ratio (unchanged behaviour)", () => {
    const css = generateCss(bleed(undefined), new Map());
    assert.doesNotMatch(baseRule(css, "n202"), /width:\s*100%/, `plain inset-spanned box must not be forced to fill: ${baseRule(css, "n202")}`);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — authored height kept when the only in-flow child fills it
// ---------------------------------------------------------------------------
describe("FIX 3: authored height with a fill-only child", () => {
  // Hero (authored, height VARIES per vp — a responsive header) → child (h-full aspect-video). The
  // child extent equals the parent's height at every vp ONLY because it fills. The varying height also
  // exercises heightFlows' "varies" gate, which is the path that was wrongly dropping the height.
  const HERO_H = { 375: 324.8, 768: 409.6, 1280: 240 } as Record<number, number>;
  function hero(childSizing: RawSizing, parentSizing: RawSizing): IR {
    const child = vpNode("n290", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", height: `${HERO_H[vp]}px`, overflow: "hidden", aspectRatio: "16 / 9" },
      bbox: { x: 0, y: 176, width: vp, height: HERO_H[vp]! },
      sizing: childSizing,
    }])) as Record<number, PerVp>);
    const h = vpNode("n289", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", height: `${HERO_H[vp]}px`, overflow: "visible" },
      bbox: { x: 0, y: 176, width: vp, height: HERO_H[vp]! },
      sizing: parentSizing,
    }])) as Record<number, PerVp>, [child]);
    return irWith(h);
  }

  it("keeps the authored height when the sole in-flow child is a fill child (height derives from parent)", () => {
    const css = generateCss(hero(
      { wAuto: false, wFill: true, hAuto: false, hFill: true },  // child fills (h-full)
      { wAuto: true, wFill: true, hAuto: false, hFill: false },  // parent authored height (auto does NOT reproduce)
    ), new Map());
    assert.match(baseRule(css, "n289"), /height:\s*240px/, `authored height must survive when child only fills it: ${baseRule(css, "n289")}`);
  });

  it("still drops the height when the child is real content flow (its extent IS the evidence)", () => {
    // Child sizes to its own content (hAuto true, not a fill) AND the parent auto-height reproduces.
    // Height varies per-vp so the heightFlows path is exercised — it must STILL flow (drop) here.
    const child = vpNode("n290b", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", height: `${HERO_H[vp]}px` },
      bbox: { x: 0, y: 176, width: vp, height: HERO_H[vp]! },
      sizing: { wAuto: true, wFill: true, hAuto: true, hFill: false },  // content-sized child
    }])) as Record<number, PerVp>);
    const h = vpNode("n289b", "div", Object.fromEntries(VPS.map((vp) => [vp, {
      cs: { display: "block", position: "relative", height: `${HERO_H[vp]}px`, overflow: "visible" },
      bbox: { x: 0, y: 176, width: vp, height: HERO_H[vp]! },
      sizing: { wAuto: true, wFill: true, hAuto: true, hFill: false },  // parent auto-height reproduces → drop
    }])) as Record<number, PerVp>, [child]);
    const css = generateCss(irWith(h), new Map());
    assert.doesNotMatch(baseRule(css, "n289b"), /height:\s*(?:240|324\.8|409\.6)px/, `content-flow parent should let height drop: ${baseRule(css, "n289b")}`);
  });
});
