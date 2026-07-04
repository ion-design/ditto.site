import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import { buildTailwind } from "../src/generate/tailwind.js";

const VPS = [375, 1280];
const CANONICAL = 1280;

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", listStyleType: "disc", listStylePosition: "outside", ...over };
}

/** Per-viewport node: distinct computed style per width so a band delta is produced. */
function pvNode(id: string, tag: string, byVp: Record<number, StyleMap>, children: IRChild[] = [], srcClass?: string): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = computed(byVp[vp]);
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = true;
  }
  const n: IRNode = { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
  if (srcClass) n.srcClass = srcClass;
  return n;
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/banding",
      title: "Banding Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: CANONICAL,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
      nodeCount: 3,
      keyframes: [],
    },
    root,
  };
}

// C3 — a base RAW value (gradient) with a band that RESETS the same prop to a NON-raw value
// (`background-image: none` → utility `bg-[none]`) must keep the base gradient in ditto.css, not
// inline. An inline style out-specifies the @media reset, painting the gradient where the source
// turned it off (the mobile shimmer-blob defect). The banded-props set must count ALL band-touched
// props, not just the raw ones.
describe("buildTailwind banded non-raw override keeps base gradient in ditto.css (C3)", () => {
  it("does not inline a base gradient when a band resets background-image to none", () => {
    const grad = "linear-gradient(90deg, rgb(1, 2, 3), rgb(4, 5, 6))";
    // 1280 (canonical/base): gradient painted; 375 (mobile band): background-image none.
    const el = pvNode("n1", "span", {
      375: { backgroundImage: "none" },
      1280: { backgroundImage: grad },
    }, [{ text: "Grepping" } as IRChild]);
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const inline = tw.styleOf.get("n1");
    const inlineHasGrad = !!inline && [...inline.values()].some((v) => v.includes("gradient("));
    assert.ok(!inlineHasGrad, `banded gradient must NOT be inlined, got inline: ${inline ? JSON.stringify([...inline]) : "none"}`);
    // It must instead live in ditto.css (extraCss folded into pseudoCss) as a [data-cid] rule.
    assert.ok(/\[data-cid="n1"\][\s\S]*gradient\(/.test(tw.pseudoCss), `base gradient must be a ditto.css rule, got:\n${tw.pseudoCss}`);
  });

  it("still inlines a base gradient with NO band touching background-image (unchanged path)", () => {
    const grad = "linear-gradient(90deg, rgb(1, 2, 3), rgb(4, 5, 6))";
    const el = pvNode("n1", "span", {
      375: { backgroundImage: grad },
      1280: { backgroundImage: grad },
    }, [{ text: "static gradient" } as IRChild]);
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const inline = tw.styleOf.get("n1");
    const inlineHasGrad = !!inline && [...inline.values()].some((v) => v.includes("gradient("));
    assert.ok(inlineHasGrad, `a truly static (un-banded) gradient is still inlined, got inline: ${inline ? JSON.stringify([...inline]) : "none"}`);
  });
});

// C1 (tailwind intent side) — a variant-only `max-lg:grid-rows-subgrid` covers only a subset of
// viewports (the axis resolves to explicit tracks at ≥lg). The partial-coverage bail must let subgrid
// through as a banded variant instead of discarding it.
describe("buildTailwind partial-coverage subgrid intent (C1)", () => {
  it("emits grid-rows-subgrid from a variant-only source class", () => {
    // Grid at both widths; subgrid computed at the mobile band (375) and explicit tracks at 1280.
    // Source authored `max-lg:grid-rows-subgrid`.
    const el = pvNode("n1", "div", {
      375: { display: "grid", gridTemplateRows: "subgrid" },
      1280: { display: "grid", gridTemplateRows: "340px 340px" },
    }, [{ text: "card" } as IRChild], "max-lg:grid-rows-subgrid");
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const cls = tw.classOf.get("n1") || "";
    assert.ok(/grid-rows-subgrid/.test(cls), `subgrid must survive the partial-intent path, got class: "${cls}"`);
  });
});

// FIX 1 (source-intent side) — an authored banded FIXED height (`h-[4rem] md:h-[6.25rem]`) must be
// recoverable through source intent even though sourceFluidLengthSuffix rejects fixed rem/px lengths.
// The recovered value is re-emitted as the CAPTURED computed px (root-font-size independent), and the
// generated `h-full`/`h-auto` on that axis is dropped in its favour.
describe("buildTailwind recovers authored banded fixed height as computed px (FIX 1)", () => {
  // A per-vp node with distinct computed height + matching bbox on each axis, so geometry corroborates.
  function fixedHNode(id: string, tag: string, hByVp: Record<number, number>, srcClass: string): IRNode {
    const computedByVp: Record<number, StyleMap> = {};
    const bboxByVp: Record<number, BBox> = {};
    const visibleByVp: Record<number, boolean> = {};
    for (const vp of VPS) {
      computedByVp[vp] = computed({ display: "flex", height: `${hByVp[vp]}px` });
      bboxByVp[vp] = { x: 0, y: 0, width: vp, height: hByVp[vp]! };
      visibleByVp[vp] = true;
    }
    const n: IRNode = { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children: [] };
    n.srcClass = srcClass;
    // Probe reads the fill↔content cycle (a grid/flex item whose child fills it): hAuto:false but
    // hFill:true, so the generator would otherwise emit h-full. Source intent must still recover.
    n.sizingByVp = Object.fromEntries(VPS.map((vp) => [vp, { wAuto: false, wFill: true, hAuto: false, hFill: true }]));
    return n;
  }

  it("emits banded computed px (h-[60px]/h-[100px]) and no h-full", () => {
    // Source authors `h-[4rem]` (base) and `md:h-[6.25rem]`; the source root is 15px so 4rem→60px @375
    // and 6.25rem→100px @1280. Emitted as px so the clone's root font-size can't mis-size it.
    const el = fixedHNode("n1", "div", { 375: 60, 1280: 100 }, "flex h-[4rem] w-full md:h-[6.25rem]");
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const cls = tw.classOf.get("n1") || "";
    assert.ok(!/\bh-full\b/.test(cls), `authored fixed height must not stay h-full, got class: "${cls}"`);
    // The captured px must appear (as an arbitrary px value or a clean rem token equivalent). Accept the
    // px form or its 16px-root rem equivalent (100px→6.25rem, 60px→3.75rem) since the pretty-printer may
    // fold clean px back to rem — both resolve to the captured px at the clone's 16px root.
    assert.ok(/h-\[100px\]|h-\[6\.25rem\]/.test(cls), `desktop height (100px/6.25rem@16root) must appear, got class: "${cls}"`);
    assert.ok(/h-\[60px\]|h-\[3\.75rem\]/.test(cls), `mobile height (60px/3.75rem@16root) must appear, got class: "${cls}"`);
  });
});

// FIX 2 (source-intent named-token validation) — a source built on an OLDER Tailwind authored
// `max-w-md`, whose scale resolved `md` to 640px; the clone's Tailwind v4 resolves `max-w-md` to
// 448px. Re-emitting the name verbatim silently re-sizes the box (640→448). The source-intent pass
// must validate the modern named-token px against the captured computed px and, on mismatch, emit
// the captured px as an arbitrary value instead of the mis-resolving name.
describe("buildTailwind validates named length tokens against captured px (FIX 2)", () => {
  // A max-width node whose computed maxWidth is `capPx` at every viewport, carrying `srcClass`.
  function maxWNode(capPx: number, srcClass: string): IRNode {
    const computedByVp: Record<number, StyleMap> = {};
    const bboxByVp: Record<number, BBox> = {};
    const visibleByVp: Record<number, boolean> = {};
    for (const vp of VPS) {
      computedByVp[vp] = computed({ maxWidth: `${capPx}px` });
      bboxByVp[vp] = { x: 0, y: 0, width: Math.min(vp, capPx), height: 100 };
      visibleByVp[vp] = true;
    }
    const n: IRNode = { id: "n1", tag: "div", attrs: {}, visibleByVp, bboxByVp, computedByVp, children: [{ text: "col" } as IRChild] };
    n.srcClass = srcClass;
    return n;
  }

  it("re-emits max-w-md as the captured px when the modern token value disagrees (640 ≠ 448)", () => {
    // Modern max-w-md = 28rem = 448px, but the source computed a 640px cap → arbitrary px, not the name.
    const el = maxWNode(640, "max-w-md");
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const cls = tw.classOf.get("n1") || "";
    assert.ok(!/\bmax-w-md\b/.test(cls), `mis-resolving max-w-md name must not survive, got class: "${cls}"`);
    assert.ok(/max-w-\[640px\]|max-w-\[40rem\]/.test(cls), `captured 640px cap must be emitted arbitrarily, got class: "${cls}"`);
  });

  it("keeps max-w-lg verbatim when the modern token value matches the captured px (512 == 512)", () => {
    // Modern max-w-lg = 32rem = 512px, and the source computed a 512px cap → the authored name is faithful.
    const el = maxWNode(512, "max-w-lg");
    const root = pvNode("n0", "body", { 375: {}, 1280: {} }, [el]);
    const tw = buildTailwind(irWith(root), new Map());
    const cls = tw.classOf.get("n1") || "";
    assert.ok(/\bmax-w-lg\b/.test(cls), `matching max-w-lg name must survive, got class: "${cls}"`);
    assert.ok(!/max-w-\[/.test(cls), `no arbitrary max-w should be emitted when the name matches, got class: "${cls}"`);
  });
});

// FIX 3 (source-intent breakpoint specificity) — an authored gallery grid
// `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` (both `md:` and `lg:` are min-width variants, so BOTH
// are active at 1280). Tailwind emits its rules sorted by breakpoint, so `lg:` wins there — the base
// (canonical=1280) is grid-cols-3. Choosing the LAST active token in class-attribute order instead
// (`… lg:grid-cols-3 md:grid-cols-2`) wrongly takes md's grid-cols-2 as base and drops the desktop
// grid-cols-3 band entirely. The pass must pick the highest-min-width active variant per viewport.
describe("buildTailwind source-intent picks the highest active breakpoint per viewport (FIX 3)", () => {
  const GVPS = [375, 768, 1280, 1920];
  function gridIr(srcClass: string): IR {
    const gtc: Record<number, string> = {
      375: "343px", 768: "348px 348px",
      1280: "346.66px 346.66px 346.66px", 1920: "346.66px 346.66px 346.66px",
    };
    const gridW: Record<number, number> = { 375: 343, 768: 720, 1280: 1064, 1920: 1064 };
    const mk = (id: string, byVp: Record<number, StyleMap>, w: Record<number, number>, kids: IRChild[] = [], sc?: string): IRNode => {
      const computedByVp: Record<number, StyleMap> = {};
      const bboxByVp: Record<number, BBox> = {};
      const visibleByVp: Record<number, boolean> = {};
      for (const vp of GVPS) {
        computedByVp[vp] = computed(byVp[vp]);
        bboxByVp[vp] = { x: 0, y: 0, width: w[vp]!, height: 100 };
        visibleByVp[vp] = true;
      }
      const n: IRNode = { id, tag: "div", attrs: {}, visibleByVp, bboxByVp, computedByVp, children: kids };
      if (sc) n.srcClass = sc;
      return n;
    };
    const items = [0, 1, 2].map((i) => mk(`c${i}`, Object.fromEntries(GVPS.map((vp) => [vp, { display: "block" }])), Object.fromEntries(GVPS.map((vp) => [vp, 340])), [{ text: "x" } as IRChild]));
    const grid = mk("n123", Object.fromEntries(GVPS.map((vp) => [vp, { display: "grid", gridTemplateColumns: gtc[vp], columnGap: "24px", rowGap: "24px", gap: "24px" }])), gridW, items, srcClass);
    const root = mk("n0", Object.fromEntries(GVPS.map((vp) => [vp, {}])), Object.fromEntries(GVPS.map((vp) => [vp, vp])), [grid]);
    return {
      doc: {
        sourceUrl: "https://example.test/grid", title: "Grid", lang: "en", charset: "UTF-8",
        metaViewport: "width=device-width, initial-scale=1", viewports: GVPS, sampleViewports: GVPS, canonicalViewport: 1280,
        perViewport: Object.fromEntries(GVPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
        nodeCount: 5, keyframes: [],
      },
      root,
    };
  }

  it("emits base grid-cols-3 (lg wins at 1280) even when md: follows lg: in the class string", () => {
    const tw = buildTailwind(gridIr("grid grid-cols-1 gap-6 lg:grid-cols-3 md:grid-cols-2"), new Map());
    const cls = tw.classOf.get("n123") || "";
    const toks = cls.split(/\s+/);
    assert.ok(toks.includes("grid-cols-3"), `desktop base must be grid-cols-3 (lg wins at 1280), got class: "${cls}"`);
    assert.ok(!toks.some((t) => /(?:^|:)grid-cols-2$/.test(t) && !t.includes("md:max-lg:")), `md's grid-cols-2 must not become the base, got class: "${cls}"`);
    assert.ok(toks.includes("md:max-lg:grid-cols-2"), `tablet band must be grid-cols-2, got class: "${cls}"`);
    assert.ok(toks.includes("max-md:grid-cols-1"), `mobile band must be grid-cols-1, got class: "${cls}"`);
  });
});
