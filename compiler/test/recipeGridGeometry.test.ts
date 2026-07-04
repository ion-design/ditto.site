import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import type { RecipeReport, RecipeCandidate, RecipeResponsiveRegime } from "../src/infer/recipes.js";
import { recipeResponsiveClassCleaner } from "../src/generate/app.js";

// The recipe pass infers a container's column count by grouping item bounding boxes into rows and
// taking the widest row. When an item spans multiple tracks that under-reports the real track count,
// so the synthesized column plan must NOT override the authored/computed grid geometry that the
// Tailwind emitter already baked into the className. These fixtures build a 3-track grid whose main
// card spans 2 columns (heuristic reports 2 columns) and assert the emitted classes keep 3 tracks
// and the span.

const VPS = [768, 1280];

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", whiteSpace: "normal", ...over };
}

function node(id: string, tag: string, byVp: Record<number, StyleMap>, children: IRChild[] = []): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { ...computed(), ...(byVp[vp] ?? {}) };
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = true;
  }
  return { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/",
      title: "Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: 1280,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255,255,255)", bodyBg: "rgb(255,255,255)", bodyColor: "rgb(0,0,0)", bodyFont: "Arial" }])),
      nodeCount: 4,
      keyframes: [],
    },
    root,
  };
}

function regime(viewport: number, columns: number, visibleItems: number): RecipeResponsiveRegime {
  return { viewport, layout: "grid", rootBox: { x: 0, y: 0, width: viewport, height: 400 }, visibleItems, columns, rows: 1 };
}

function candidate(over: Partial<RecipeCandidate>): RecipeCandidate {
  return {
    id: "r0",
    kind: "product-grid",
    confidence: 0.89,
    risk: "low",
    rootCid: "n0",
    rootTag: "section",
    itemParentCid: "n1",
    componentName: "ProductGridSection",
    itemCount: 2,
    repeatedItems: [],
    responsiveRegimes: [regime(768, 2, 2), regime(1280, 2, 2)],
    sourceHints: [],
    signals: [],
    emissionStatus: "report-only",
    fallbackReason: "",
    ...over,
  };
}

function report(candidates: RecipeCandidate[]): RecipeReport {
  return {
    version: 1,
    sourceUrl: "https://example.test/",
    canonicalViewport: 1280,
    viewports: VPS,
    sampledViewports: VPS,
    summary: { totalCandidates: candidates.length, highConfidence: candidates.length, byKind: {}, templateReadyKinds: [] },
    candidates,
  };
}

// A 3-track grid: the main card spans 2 tracks (`grid-column: 1 / 3`) and a photo occupies track 3.
// The item-count heuristic groups the two items into one row → columns = 2, which disagrees with the
// computed 3 tracks.
function spanningGridIr(): IR {
  const threeTracks = "284px 284px 284px";
  const card = node("n2", "article", {
    768: { gridColumnStart: "1", gridColumnEnd: "3" },
    1280: { gridColumnStart: "1", gridColumnEnd: "3" },
  });
  const photo = node("n3", "img", {
    768: { gridColumnStart: "3", gridColumnEnd: "4" },
    1280: { gridColumnStart: "3", gridColumnEnd: "4" },
  });
  const parent = node("n1", "div", {
    768: { display: "grid", gridTemplateColumns: threeTracks },
    1280: { display: "grid", gridTemplateColumns: threeTracks },
  }, [card, photo]);
  return irWith(node("n0", "section", {}, [parent]));
}

describe("recipe grid geometry: computed tracks/spans are ground truth", () => {
  it("does not override a 3-track grid with a heuristic 2-column plan (span-2 item present)", () => {
    const ir = spanningGridIr();
    const c = candidate({ itemParentCid: "n1", repeatedItems: [
      { cid: "n2", tag: "article", textSample: "", mediaCount: 1, headingCount: 1, bbox: { x: 0, y: 0, width: 568, height: 300 } },
      { cid: "n3", tag: "img", textSample: "", mediaCount: 1, headingCount: 0, bbox: { x: 584, y: 0, width: 284, height: 300 } },
    ] });
    const clean = recipeResponsiveClassCleaner(ir, report([c]), { tailwind: true });

    // The Tailwind emitter has already put the authored 3-track grid on the container className.
    const containerIn = "grid grid-cols-3 gap-4";
    const containerOut = clean("n1", containerIn)!.split(/\s+/);
    assert.ok(containerOut.includes("grid-cols-3"), "authored 3-track grid-cols-3 survives");
    assert.ok(!containerOut.some((t) => /(?:^|:)grid-cols-2$/.test(t)), "no synthesized grid-cols-2 override");
    // No responsive column-plan tokens are appended (the plan was rejected as untrustworthy).
    assert.ok(!containerOut.some((t) => /^(?:md|lg|2xl):grid-cols-/.test(t)), "no responsive grid-cols plan appended");

    // The span-2 item keeps its authored column span (emitter tokens pass through untouched).
    const itemOut = clean("n2", "col-start-1 col-end-3 flex flex-col")!;
    assert.equal(itemOut, "col-start-1 col-end-3 flex flex-col", "span-2 item className is unchanged");
  });

  it("does not override an ASYMMETRIC 2-track sidebar grid with a grid-cols-2 plan", () => {
    // A sidebar layout: `grid-template-columns: 260px 1020px` (authored `260px 1fr`). The item-count
    // heuristic sees 2 items in one row → 2 columns, which agrees with the 2 computed tracks by COUNT.
    // But `grid-cols-2` = two EQUAL 640px tracks, which destroys the 260/1020 geometry. The plan must be
    // rejected and the authored template kept.
    const sidebar = node("n2", "aside", {
      768: { gridColumnStart: "auto", gridColumnEnd: "auto" },
      1280: { gridColumnStart: "auto", gridColumnEnd: "auto" },
    });
    const main = node("n3", "div", {
      768: { gridColumnStart: "auto", gridColumnEnd: "auto" },
      1280: { gridColumnStart: "auto", gridColumnEnd: "auto" },
    });
    const parent = node("n1", "div", {
      768: { display: "grid", gridTemplateColumns: "220px 500px" },
      1280: { display: "grid", gridTemplateColumns: "260px 1020px" },
    }, [sidebar, main]);
    const ir = irWith(node("n0", "section", {}, [parent]));
    const c = candidate({
      itemParentCid: "n1",
      itemCount: 2,
      responsiveRegimes: [regime(768, 2, 2), regime(1280, 2, 2)],
      repeatedItems: [
        { cid: "n2", tag: "aside", textSample: "", mediaCount: 0, headingCount: 0, bbox: { x: 0, y: 0, width: 260, height: 300 } },
        { cid: "n3", tag: "div", textSample: "", mediaCount: 0, headingCount: 1, bbox: { x: 276, y: 0, width: 1020, height: 300 } },
      ],
    });
    const clean = recipeResponsiveClassCleaner(ir, report([c]), { tailwind: true });
    // The emitter baked the authored asymmetric template as an arbitrary grid-template-columns utility.
    const containerIn = "grid grid-cols-[260px_1020px] gap-6";
    const out = clean("n1", containerIn)!.split(/\s+/);
    assert.ok(out.includes("grid-cols-[260px_1020px]"), `authored asymmetric template must survive, got: ${out.join(" ")}`);
    assert.ok(!out.some((t) => /(?:^|:)grid-cols-2$/.test(t)), `no equal-halves grid-cols-2 override, got: ${out.join(" ")}`);
    assert.ok(!out.some((t) => /^(?:md|lg|2xl):grid-cols-/.test(t)), `no responsive grid-cols plan appended, got: ${out.join(" ")}`);
  });

  it("still re-flows a genuinely uniform grid whose computed tracks match the heuristic", () => {
    // 2-track grid at 768, 3-track at 1280, no spanning items → heuristic agrees with computed.
    const item = (id: string): IRNode => node(id, "article", {
      768: { gridColumnStart: "auto", gridColumnEnd: "auto" },
      1280: { gridColumnStart: "auto", gridColumnEnd: "auto" },
    });
    const parent = node("n1", "div", {
      768: { display: "grid", gridTemplateColumns: "300px 300px" },
      1280: { display: "grid", gridTemplateColumns: "284px 284px 284px" },
    }, [item("n2"), item("n3"), item("n4")]);
    const ir = irWith(node("n0", "section", {}, [parent]));
    const c = candidate({
      itemParentCid: "n1",
      itemCount: 3,
      responsiveRegimes: [regime(768, 2, 3), regime(1280, 3, 3)],
      repeatedItems: [
        { cid: "n2", tag: "article", textSample: "", mediaCount: 1, headingCount: 1, bbox: { x: 0, y: 0, width: 300, height: 300 } },
        { cid: "n3", tag: "article", textSample: "", mediaCount: 1, headingCount: 1, bbox: { x: 316, y: 0, width: 300, height: 300 } },
        { cid: "n4", tag: "article", textSample: "", mediaCount: 1, headingCount: 1, bbox: { x: 0, y: 316, width: 300, height: 300 } },
      ],
    });
    const clean = recipeResponsiveClassCleaner(ir, report([c]), { tailwind: true });
    const out = clean("n1", "grid grid-cols-2 gap-4")!.split(/\s+/);
    // Geometry agreed → the responsive plan is applied: base 2 columns, lg:3 at the wider viewport.
    assert.ok(out.includes("grid-cols-2"), "base column count applied");
    assert.ok(out.includes("lg:grid-cols-3"), "responsive column bump applied");
  });
});
