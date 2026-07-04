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
