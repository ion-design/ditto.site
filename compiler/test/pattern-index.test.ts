import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode } from "../src/normalize/ir.js";
import {
  assertPinnedCatalog,
  loadPatternIndex,
  matchCatalogNode,
  resolvePatternHints,
} from "../src/knowledge/patternIndex.js";

function el(id: string, tag: string, opts?: { srcClass?: string; attrs?: Record<string, string>; children?: IRNode[] }): IRNode {
  return {
    id,
    tag,
    attrs: opts?.attrs ?? {},
    srcClass: opts?.srcClass,
    visibleByVp: { 1280: true },
    bboxByVp: { 1280: { x: 0, y: 0, w: 100, h: 100 } },
    computedByVp: { 1280: {} },
    children: opts?.children ?? [],
  } as IRNode;
}

function fixtureIr(root: IRNode, nodeCount: number): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/",
      title: "Pattern Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: [1280],
      sampleViewports: [1280],
      canonicalViewport: 1280,
      perViewport: { 1280: { scrollHeight: 800, scrollWidth: 1280, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" } },
      nodeCount,
      keyframes: [],
    },
    root,
  } as IR;
}

describe("pattern catalog", () => {
  it("loads and is pinned by the lock file", () => {
    const idx = loadPatternIndex();
    assert.ok(idx.catalog.patterns.length >= 40, "catalog should carry the seeded pattern set");
    assert.equal(assertPinnedCatalog({ strict: true }), null);
  });

  it("has unique pattern ids", () => {
    const ids = loadPatternIndex().catalog.patterns.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("resolvePatternHints", () => {
  it("matches class tokens, prefixes, tags, attrs and id prefixes", () => {
    const root = el("n0", "body", {
      children: [
        el("n1", "div", { srcClass: "slick-slider hero" }),
        el("n2", "div", { srcClass: "slick-track" }),
        el("n3", "section", { srcClass: "elementor-section elementor-top-section" }),
        el("n4", "div", { attrs: { "data-aos": "fade-up" } }),
        el("n5", "lottie-player", {}),
        el("n6", "div", { attrs: { id: "shopify-section-header" } }),
      ],
    });
    const hints = resolvePatternHints(fixtureIr(root, 7));

    const byId = Object.fromEntries(hints.matches.map((m) => [m.id, m]));
    assert.equal(byId.carousel_slick?.count, 2);
    assert.deepEqual(byId.carousel_slick?.cids, ["n1", "n2"]);
    assert.equal(byId.platform_elementor?.count, 1);
    assert.equal(byId.anim_aos?.count, 1);
    assert.equal(byId.lottie_widget?.count, 1);
    assert.equal(byId.platform_shopify?.count, 1);
    assert.deepEqual(hints.platforms, ["elementor", "shopify"]);
    assert.equal(hints.simpleStatic, false, "carousel/motion signatures block the static fast path");
  });

  it("counts a node once per pattern even when several signatures hit", () => {
    const root = el("n0", "body", {
      children: [el("n1", "div", { srcClass: "swiper swiper-wrapper swiper-slide" })],
    });
    const hints = resolvePatternHints(fixtureIr(root, 2));
    assert.equal(hints.matches.find((m) => m.id === "carousel_swiper")?.count, 1);
  });

  it("flags small unmatched pages as simpleStatic", () => {
    const root = el("n0", "body", {
      children: [el("n1", "main", { srcClass: "prose container", children: [el("n2", "p", {})] })],
    });
    const hints = resolvePatternHints(fixtureIr(root, 3));
    assert.deepEqual(hints.matches, []);
    assert.equal(hints.simpleStatic, true);
  });

  it("matchCatalogNode classifies a single node (recipe evidence bridge)", () => {
    const embla = matchCatalogNode(el("n1", "div", { srcClass: "embla__container" }));
    assert.deepEqual(embla.map((d) => d.id), ["carousel_embla"]);
    assert.equal(embla[0]?.kind, "carousel");
    const shopify = matchCatalogNode(el("n2", "div", { attrs: { id: "shopify-section-hero" } }));
    assert.ok(shopify.some((d) => d.id === "platform_shopify"));
    const marquee = matchCatalogNode(el("n3", "div", { srcClass: "rfm-marquee" }));
    assert.ok(marquee.some((d) => d.kind === "marquee"));
    assert.deepEqual(matchCatalogNode(el("n4", "p", { srcClass: "prose" })), []);
  });

  it("is deterministic: identical IR yields byte-identical hints", () => {
    const build = () =>
      el("n0", "body", {
        children: [
          el("n1", "div", { srcClass: "owl-carousel" }),
          el("n2", "div", { srcClass: "wp-block-columns aos-init", attrs: { "data-aos": "zoom" } }),
        ],
      });
    const a = resolvePatternHints(fixtureIr(build(), 3));
    const b = resolvePatternHints(fixtureIr(build(), 3));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
