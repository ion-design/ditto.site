import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import type { FontGraph } from "../src/infer/fonts.js";
import { generatePreviewHtml } from "../src/generate/preview.js";
import { generateCss, collectNodeRules, assembleCss, computeBands } from "../src/generate/css.js";

const VPS = [375, 1280];
const CANONICAL = 1280;

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", listStyleType: "disc", listStylePosition: "outside", ...over };
}

function node(id: string, tag: string, cs: StyleMap, children: IRChild[] = [], attrs: Record<string, string> = {}): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { ...cs };
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = true;
  }
  return { id, tag, attrs, visibleByVp, bboxByVp, computedByVp, children };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/preview",
      title: "Preview Fixture",
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

// A @font-face block whose src points at a root-absolute cloned asset path — exactly the
// shape buildFontGraph emits. The preview must relativize the /assets/ prefix.
const FONT_GRAPH: FontGraph = {
  entries: [],
  css: `@font-face {\n  font-family: "Demo";\n  src: url("/assets/cloned/fonts/abc123.woff2") format("woff2");\n}`,
};

/** Build a small page IR: body → heading (with own styles) + <img> (asset) + text. */
function fixtureIr(): IR {
  const heading = node("n1", "h1", computed({ color: "rgb(10, 20, 30)", fontSize: "40px" }), [{ text: "Hello preview" }]);
  const img = node("n2", "img", computed(), [], { src: "https://example.test/logo.png", alt: "logo" });
  const root = node("n0", "body", computed(), [heading, img]);
  return irWith(root);
}

/** Asset map keyed as buildAssetMap keys it (source URL + pathname) → root-absolute local path. */
function assetMap(): Map<string, string> {
  return new Map([
    ["https://example.test/logo.png", "/assets/cloned/images/logo.png"],
    ["/logo.png", "/assets/cloned/images/logo.png"],
  ]);
}

function emit(ir: IR, am: Map<string, string>): string {
  return generatePreviewHtml({ ir, assetMap: am, fontGraph: FONT_GRAPH, tokensCss: ":root { --x: 1; }", sourceUrl: ir.doc.sourceUrl });
}

describe("preview.html static artifact", () => {
  it("emits a self-contained HTML document with an inline <style> and no runtime scripts", () => {
    const html = emit(fixtureIr(), assetMap());
    assert.ok(html.startsWith("<!doctype html>"), "starts with doctype");
    assert.ok(/<style>[\s\S]*<\/style>/.test(html), "carries an inline <style> block");
    assert.ok(/<title>Preview Fixture<\/title>/.test(html), "carries the doc title");
    // Static preview: NO Ditto runtime scripts, no <script> at all.
    assert.ok(!/<script/i.test(html), "emits no <script> tags (runtime-free)");
    assert.ok(!/DittoWire|DittoLottie|DittoMotion/.test(html), "no Ditto runtime references");
    // The tree renders as real HTML with the per-node c<id> class + data-cid.
    assert.ok(/<body class="cn0" data-cid="n0">/.test(html), "body carries its c<id> class + cid");
    assert.ok(/<h1 class="cn1" data-cid="n1">/.test(html), "heading rendered as <h1> with class");
    assert.ok(/Hello preview/.test(html), "text content rendered");
  });

  it("references assets with RELATIVE paths (public/assets/...), never root-absolute /assets", () => {
    const html = emit(fixtureIr(), assetMap());
    // The <img> src and the @font-face url() both resolve relative to public/.
    assert.ok(/src="public\/assets\/cloned\/images\/logo\.png"/.test(html), "img src relativized to public/assets");
    assert.ok(/url\("public\/assets\/cloned\/fonts\/abc123\.woff2"\)/.test(html), "font url relativized to public/assets");
    // No leading-slash /assets refs survive (they'd break when opened at the app-dir root).
    assert.ok(!/["(]\/assets\//.test(html), "no root-absolute /assets references remain");
  });

  it("is byte-stable across repeated emission from the same IR (determinism)", () => {
    const a = emit(fixtureIr(), assetMap());
    const b = emit(fixtureIr(), assetMap());
    assert.equal(a, b, "two emissions of the same IR are byte-identical");
  });

  it("SHARES the css.ts rule collector — the inline CSS is the collectNodeRules/assembleCss output, not a re-derived path", () => {
    const ir = fixtureIr();
    const am = assetMap();
    const html = emit(ir, am);

    // Independently produce the per-node CSS the same way generateCss does (both go through
    // collectNodeRules → assembleCss with `.c<id>` selectors). If the preview shared the
    // collector, this exact block must appear verbatim inside its <style>.
    const rules = collectNodeRules(ir, am);
    const bands = computeBands(ir.doc.viewports, ir.doc.canonicalViewport);
    const sharedNodeCss = assembleCss([...rules.keys()], (cid) => rules.get(cid)!, (cid) => `.c${cid}`, bands, "");

    const styleBody = /<style>([\s\S]*)<\/style>/.exec(html)![1]!;
    assert.ok(styleBody.includes(sharedNodeCss.trim()), "preview inline CSS contains the exact collectNodeRules/assembleCss output");

    // Concretely: the heading's own base rule (color + font-size from collectNodeRules) is present
    // exactly once — proving it's the shared collector's rule, not a duplicated re-emission.
    const headingRule = /\.cn1\s*\{[^}]*\}/.exec(sharedNodeCss)![0];
    assert.ok(headingRule.includes("color:rgb(10, 20, 30)") && headingRule.includes("font-size:40px"), "shared rule carries the node's decls");
    const occurrences = styleBody.split(headingRule).length - 1;
    assert.equal(occurrences, 1, "the shared per-node rule appears exactly once (no duplicated emission path)");
  });

  it("mirrors generateCss's `.c<id>` selectors so the preview and the css-mode app resolve identical rules", () => {
    const ir = fixtureIr();
    const am = assetMap();
    // The legacy per-node css-mode emitter (generateCss) is the ground truth for `.c<id>` rules.
    const appCss = generateCss(ir, am);
    const styleBody = /<style>([\s\S]*)<\/style>/.exec(emit(ir, am))![1]!;
    // Every `.c<id>{…}` base rule generateCss emits must be present verbatim in the preview.
    for (const m of appCss.matchAll(/\.cn\d+\s*\{[^}]*\}/g)) {
      assert.ok(styleBody.includes(m[0]), `preview carries app rule ${m[0].slice(0, 40)}…`);
    }
  });
});
