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
