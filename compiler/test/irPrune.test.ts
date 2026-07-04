import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawNode, RawChild } from "../src/capture/walker.js";
import { buildIR, isTextChild, neutralizeAnimatedTransforms, type IRNode } from "../src/normalize/ir.js";

const VPS = [375, 1280];

function raw(tag: string, attrs: Record<string, string> = {}, children: RawChild[] = [], visible = true): RawNode {
  return {
    tag, attrs,
    computed: { display: visible ? "block" : "none", position: "static", visibility: "visible" },
    bbox: { x: 0, y: 0, width: visible ? 640 : 0, height: visible ? 360 : 0 },
    visible,
    children,
  };
}

/** Minimal PageSnapshot JSON around a body tree (same tree at every viewport). */
function snapshot(vp: number, root: RawNode): object {
  return {
    doc: {
      url: "https://example.test/page", title: "Fixture",
      head: { description: "", canonical: "", ogTitle: "", ogDescription: "", ogImage: "", ogType: "", ogSiteName: "", twitterCard: "", themeColor: "" },
      lang: "en", charset: "UTF-8", viewportWidth: vp, viewportHeight: 800,
      scrollWidth: vp, scrollHeight: 800, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)",
      bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial", metaViewport: "width=device-width, initial-scale=1",
      nodeCount: 10, truncated: false,
    },
    root, cssVars: {}, fontFaces: [], cssUrls: [], domAssets: [], keyframes: [],
  };
}

function buildFixtureIR(root: RawNode): IRNode {
  const sourceDir = mkdtempSync(join(tmpdir(), "ditto-ir-prune-"));
  mkdirSync(join(sourceDir, "capture"), { recursive: true });
  for (const vp of VPS) {
    writeFileSync(join(sourceDir, "capture", `dom-${vp}.json`), JSON.stringify(snapshot(vp, structuredClone(root))));
  }
  return buildIR(sourceDir, VPS).root;
}

function findByTag(node: IRNode, tag: string): IRNode | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

describe("IR prune keeps <source> media candidates", () => {
  it("keeps invisible source children of <picture> and <video>, still pruning other invisibles", () => {
    // <source> is 0×0 at EVERY viewport (never painted), which the visibility prune
    // reads as unobserved — real case (ooni.com): 47 <source> in dom-1280.json, 0 in
    // ir.json, so the mobile img.src got baked into desktop layouts.
    const picture = raw("picture", {}, [
      raw("source", { srcset: "/img/hero-1280.jpg 1x", media: "(min-width: 768px)" }, [], false),
      raw("img", { src: "/img/hero-375.jpg", alt: "hero" }),
    ]);
    const video = raw("video", { autoplay: "" }, [
      raw("source", { src: "/media/hero.mp4", type: "video/mp4" }, [], false),
    ]);
    const noise = raw("div", {}, [raw("span", {}, [], false)], false); // invisible everywhere → pruned
    const body = raw("body", {}, [picture, video, noise]);

    const root = buildFixtureIR(body);

    const pic = findByTag(root, "picture");
    assert.ok(pic, "picture survives");
    const picTags = pic!.children.filter((c) => !isTextChild(c)).map((c) => (c as IRNode).tag);
    assert.deepEqual(picTags, ["source", "img"]);
    const src = findByTag(pic!, "source")!;
    assert.equal(src.attrs.srcset, "/img/hero-1280.jpg 1x");
    assert.equal(src.attrs.media, "(min-width: 768px)");

    const vid = findByTag(root, "video");
    assert.ok(vid, "video survives");
    const vidTags = vid!.children.filter((c) => !isTextChild(c)).map((c) => (c as IRNode).tag);
    assert.deepEqual(vidTags, ["source"]);

    // The carve-out is scoped: unrelated invisible-everywhere subtrees still prune.
    assert.equal(findByTag(root, "span"), null);
  });

  it("does not keep a <source> outside picture/video, nor resurrect a pruned picture", () => {
    const orphan = raw("div", {}, [raw("source", { srcset: "/x.jpg" }, [], false)]);
    // A picture invisible everywhere with no visible descendants is still pruned whole.
    const ghost = raw("picture", {}, [raw("source", { srcset: "/y.jpg" }, [], false)], false);
    const body = raw("body", {}, [orphan, ghost]);

    const root = buildFixtureIR(body);

    assert.equal(findByTag(root, "source"), null);
    assert.equal(findByTag(root, "picture"), null);
  });
});

describe("IR drops font-metric probe nodes (fix 4)", () => {
  it("excludes a walker-tagged probe node from the IR, keeping its siblings", () => {
    const probe: RawNode = {
      ...raw("div", { class: "font-probe" }, [{ text: "Mgy" }]),
      probe: true,
    };
    const real = raw("h1", { class: "title" }, [{ text: "Heading" }]);
    const body = raw("body", {}, [real, probe]);

    const root = buildFixtureIR(body);

    const kept = root.children.filter((c) => !isTextChild(c)).map((c) => (c as IRNode).tag);
    assert.deepEqual(kept, ["h1"], "probe div is dropped, the real heading survives");
    // Its text must not leak into the tree either.
    assert.equal(findByTag(root, "div"), null);
  });
});

describe("IR drops popup-vendor OVERLAY containers, keeps inline embedded forms", () => {
  it("drops an email-capture popup overlay container (vendor overlay id) but keeps a real section", () => {
    const overlay = raw("div", { id: "attentive_overlay" }, [
      raw("iframe", { id: "attentive_creative", src: "https://creatives.attn.tv/x" }),
    ]);
    const real = raw("section", { class: "hero" }, [raw("h1", {}, [{ text: "Real content" }])]);
    const body = raw("body", {}, [real, overlay]);

    const root = buildFixtureIR(body);
    const kept = root.children.filter((c) => !isTextChild(c)).map((c) => (c as IRNode).tag);
    assert.deepEqual(kept, ["section"], "the attentive overlay subtree is dropped");
    assert.equal(findByTag(root, "iframe"), null, "the popup creative iframe never reaches the IR");
  });

  it("does NOT drop an INLINE embedded signup form that merely carries a vendor name (feature, not popup)", () => {
    // A deliberately-grafted inline Klaviyo form: a real, sized form embedded in page content. Its
    // class names the vendor but is NOT an overlay-container marker, so it must survive.
    const inlineForm = raw("div", { class: "klaviyo-form klaviyo-form-inline" }, [
      raw("form", { id: "email-signup" }, [raw("input", { type: "email" })]),
    ]);
    const body = raw("body", {}, [inlineForm]);

    const root = buildFixtureIR(body);
    assert.ok(findByTag(root, "form"), "the inline signup form survives the prune");
    assert.ok(findByTag(root, "input"), "its input survives too");
  });
});

// Defect C (normalize side) — an infinite CSS animation gated to a breakpoint (a Webflow `max-lg`
// marquee) is `animation:none` at the widths it does not run, but the browser still reports the last
// FROZEN translateX there. `neutralizeAnimatedTransforms` zeroes the transform at EVERY viewport
// once a genuine infinite animation is present at some width, so no frozen mid-scroll offset (the
// base residue or the animated phases) is banded and clips the strip offscreen at rest.
describe("neutralizeAnimatedTransforms (Defect C)", () => {
  it("zeroes the transform at every viewport when an infinite animation runs at some width", () => {
    const byVp = {
      375: { animationName: "track", animationIterationCount: "infinite", transform: "matrix(1, 0, 0, 1, -284.025, 0)" } as any,
      768: { animationName: "track", animationIterationCount: "infinite", transform: "matrix(1, 0, 0, 1, -280.982, 0)" } as any,
      1280: { animationName: "none", animationIterationCount: "1", transform: "matrix(1, 0, 0, 1, -9.94731, 0)" } as any,
    };
    neutralizeAnimatedTransforms(byVp as any);
    assert.equal(byVp[375].transform, "none");
    assert.equal(byVp[768].transform, "none");
    assert.equal(byVp[1280].transform, "none", "the non-animated base residue is neutralized too");
  });

  it("leaves a static transform untouched when NO viewport carries an infinite animation", () => {
    const byVp = {
      375: { animationName: "none", animationIterationCount: "1", transform: "matrix(1, 0, 0, 1, -40, 0)" } as any,
      1280: { animationName: "none", animationIterationCount: "1", transform: "matrix(1, 0, 0, 1, -40, 0)" } as any,
    };
    neutralizeAnimatedTransforms(byVp as any);
    assert.equal(byVp[375].transform, "matrix(1, 0, 0, 1, -40, 0)", "a deliberate static offset is preserved");
    assert.equal(byVp[1280].transform, "matrix(1, 0, 0, 1, -40, 0)");
  });

  it("does not fire for a FINITE animation (a one-shot entrance, not a perpetual marquee)", () => {
    const byVp = {
      375: { animationName: "slideIn", animationIterationCount: "1", transform: "matrix(1, 0, 0, 1, -100, 0)" } as any,
      1280: { animationName: "slideIn", animationIterationCount: "1", transform: "matrix(1, 0, 0, 1, -100, 0)" } as any,
    };
    neutralizeAnimatedTransforms(byVp as any);
    assert.equal(byVp[375].transform, "matrix(1, 0, 0, 1, -100, 0)", "finite animations own a settled end state, not a perpetual phase");
  });
});

/** A RawNode with an explicit computed style and bbox (same at every viewport). Unlike `raw()` this
 *  lets a test author invisible-but-laid-out boxes, transforms, margins, and positions directly. */
function rawS(
  tag: string,
  computed: Record<string, string>,
  bbox: { x: number; y: number; width: number; height: number },
  children: RawChild[] = [],
  visible = true,
  attrs: Record<string, string> = {},
): RawNode {
  return { tag, attrs, computed, bbox, visible, children };
}

// FIX 2 — an in-flow `visibility:hidden` box with a nonzero border box is load-bearing geometry: it
// reserves the row height its absolutely-positioned siblings paint into. It is invisible (so the plain
// visibility prune would drop it), but dropping it collapses the column. It must survive as a sized
// placeholder; a genuinely empty display:none-everywhere box must still prune.
describe("IR prune keeps sized invisible (visibility:hidden) spacers (FIX 2)", () => {
  it("keeps an in-flow visibility:hidden ghost column with a nonzero bbox", () => {
    const ghost = rawS(
      "div",
      { display: "flex", position: "static", visibility: "hidden" },
      { x: 0, y: 0, width: 650, height: 723 },
      // its children are themselves invisible (they set no visibility:visible) — the box is a spacer
      [rawS("img", { display: "block", position: "static", visibility: "hidden" }, { x: 0, y: 0, width: 650, height: 240 }, [], false)],
      false,
    );
    // the real content is an absolutely-positioned sibling layered over the ghost's reserved space
    const painted = rawS("img", { display: "block", position: "absolute", visibility: "visible" }, { x: 0, y: 0, width: 650, height: 723 }, [], true);
    const column = rawS("div", { display: "block", position: "relative", visibility: "visible" }, { x: 0, y: 0, width: 650, height: 723 }, [ghost, painted], true);
    const body = raw("body", {}, [column]);

    const root = buildFixtureIR(body);
    const kept = findByTag(root, "div");
    assert.ok(kept, "the column survives");
    // The ghost div (a second nested div) must still be present as a sized placeholder.
    const divs: IRNode[] = [];
    const collect = (n: IRNode): void => { if (n.tag === "div") divs.push(n); for (const c of n.children) if (!isTextChild(c)) collect(c as IRNode); };
    collect(root);
    // column + ghost = 2 divs (body is not a div)
    assert.equal(divs.length, 2, "the visibility:hidden ghost column is retained, not pruned");
    const ghostIR = divs.find((d) => d.computedByVp[1280]?.visibility === "hidden");
    assert.ok(ghostIR, "the retained ghost carries visibility:hidden");
    assert.ok(ghostIR!.bboxByVp[1280]!.height > 0, "the ghost keeps its load-bearing height");
  });

  it("still prunes a display:none-everywhere empty box (no resurrection)", () => {
    const hidden = rawS("div", { display: "none", position: "static", visibility: "visible" }, { x: 0, y: 0, width: 0, height: 0 }, [], false);
    const body = raw("body", {}, [rawS("section", { display: "block", position: "static", visibility: "visible" }, { x: 0, y: 0, width: 640, height: 100 }, [hidden], true)]);
    const root = buildFixtureIR(body);
    assert.equal(findByTag(root, "div"), null, "a display:none-everywhere box stays pruned");
  });

  it("does not keep an out-of-flow (absolute) visibility:hidden box as a spacer", () => {
    // Absolute boxes take no space in flow, so an invisible absolute box is not load-bearing geometry.
    const absHidden = rawS("div", { display: "block", position: "absolute", visibility: "hidden" }, { x: 0, y: 0, width: 300, height: 300 }, [], false);
    const body = raw("body", {}, [rawS("section", { display: "block", position: "static", visibility: "visible" }, { x: 0, y: 0, width: 640, height: 100 }, [absHidden], true)]);
    const root = buildFixtureIR(body);
    assert.equal(findByTag(root, "div"), null, "an out-of-flow invisible box is not kept as a spacer");
  });
});

// FIX 3 — a settled loop carousel parks its track with a baked translateX and prepends invisible clone
// slides that occupy exactly [translateX, 0]; the first REAL slide paints at x=0. Pruning drops the
// off-screen clones, but the baked translateX would survive verbatim and push every real slide
// offscreen-left. Re-anchor the track's translateX by the aggregate outer width of the dropped leading
// clones so the first kept slide lands at its captured position.
describe("IR prune re-anchors a translated track after dropping leading clones (FIX 3)", () => {
  it("re-anchors translateX toward 0 by the dropped leading clone width", () => {
    // Three off-screen leading loop clones, each 200px wide (translateX = -600 = -(3×200)); two reals.
    // The clones are OFF-SCREEN (visible:false via the off-screen test), NOT visibility:hidden — so
    // they prune and the FIX-2 sized-invisible-spacer carve-out (which requires visibility:hidden) does
    // not resurrect them. This mirrors a real settled Splide loop's leading clones.
    const clone = (i: number): RawNode =>
      rawS("li", { display: "block", position: "static", visibility: "visible" }, { x: -600 + i * 200, y: 0, width: 200, height: 100 }, [], false);
    const real = (i: number): RawNode =>
      rawS("li", { display: "block", position: "static", visibility: "visible" }, { x: i * 200, y: 0, width: 200, height: 100 }, [{ text: `real${i}` }], true);
    const track = rawS(
      "ul",
      { display: "flex", position: "relative", visibility: "visible", transform: "matrix(1, 0, 0, 1, -600, 0)" },
      { x: 0, y: 0, width: 1000, height: 100 },
      [clone(0), clone(1), clone(2), real(0), real(1)],
      true,
    );
    const body = raw("body", {}, [track]);
    const root = buildFixtureIR(body);
    const ul = findByTag(root, "ul")!;
    // The clones are pruned (invisible everywhere), leaving the two real slides.
    const slides = ul.children.filter((c) => !isTextChild(c));
    assert.equal(slides.length, 2, "only the real slides survive");
    // The baked -600 translate is re-anchored to 0 (−600 + 3×200).
    assert.equal(ul.computedByVp[1280]!.transform, "matrix(1, 0, 0, 1, 0, 0)", "track translateX re-anchored to origin");
    assert.equal(ul.computedByVp[375]!.transform, "matrix(1, 0, 0, 1, 0, 0)", "re-anchored at every viewport");
  });

  it("leaves a track untouched when no leading children are dropped", () => {
    const real = (i: number): RawNode =>
      rawS("li", { display: "block", position: "static", visibility: "visible" }, { x: i * 200, y: 0, width: 200, height: 100 }, [{ text: `real${i}` }], true);
    const track = rawS(
      "ul",
      { display: "flex", position: "relative", visibility: "visible", transform: "matrix(1, 0, 0, 1, -120, 0)" },
      { x: 0, y: 0, width: 400, height: 100 },
      [real(0), real(1)],
      true,
    );
    const body = raw("body", {}, [track]);
    const root = buildFixtureIR(body);
    const ul = findByTag(root, "ul")!;
    assert.equal(ul.computedByVp[1280]!.transform, "matrix(1, 0, 0, 1, -120, 0)", "a track with no dropped leading children keeps its offset");
  });

  it("does not re-anchor when the dropped leading siblings are out of flow", () => {
    const absClone = (i: number): RawNode =>
      rawS("li", { display: "block", position: "absolute", visibility: "hidden" }, { x: -400 + i * 200, y: 0, width: 200, height: 100 }, [], false);
    const real = (i: number): RawNode =>
      rawS("li", { display: "block", position: "static", visibility: "visible" }, { x: i * 200, y: 0, width: 200, height: 100 }, [{ text: `real${i}` }], true);
    const track = rawS(
      "ul",
      { display: "flex", position: "relative", visibility: "visible", transform: "matrix(1, 0, 0, 1, -80, 0)" },
      { x: 0, y: 0, width: 400, height: 100 },
      [absClone(0), absClone(1), real(0), real(1)],
      true,
    );
    const body = raw("body", {}, [track]);
    const root = buildFixtureIR(body);
    const ul = findByTag(root, "ul")!;
    assert.equal(ul.computedByVp[1280]!.transform, "matrix(1, 0, 0, 1, -80, 0)", "out-of-flow clones don't advance the track, so no re-anchor");
  });
});
