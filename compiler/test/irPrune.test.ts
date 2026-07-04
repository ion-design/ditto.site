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
