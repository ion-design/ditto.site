import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlEntities, svgInnerToJsx } from "../src/generate/app.js";

const SOURCE = "https://example.com/course/story.html";
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// The asset map as buildAssetMap() produces it: absolute source URL AND the
// origin-relative path both alias the materialized local copy.
const assetMap = new Map<string, string>([
  ["https://example.com/course/media/hero.png", "/assets/cloned/images/ab12.png"],
  ["/course/media/hero.png", "/assets/cloned/images/ab12.png"],
]);

describe("decodeHtmlEntities", () => {
  it("decodes the entities a DOM serializer emits", () => {
    assert.equal(decodeHtmlEntities("A&nbsp;BOUNTY&nbsp;HUNTER"), "A BOUNTY HUNTER");
    assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(decodeHtmlEntities("&lt;tag&gt;"), "<tag>");
    assert.equal(decodeHtmlEntities("say &quot;hi&quot;"), 'say "hi"');
  });

  it("decodes numeric and hex character references", () => {
    assert.equal(decodeHtmlEntities("&#160;"), " ");
    assert.equal(decodeHtmlEntities("&#xA0;"), " ");
    assert.equal(decodeHtmlEntities("&#8217;"), "’");
  });

  it("leaves unknown or malformed entities untouched", () => {
    assert.equal(decodeHtmlEntities("&bogus;"), "&bogus;");
    assert.equal(decodeHtmlEntities("100% & rising"), "100% & rising");
    assert.equal(decodeHtmlEntities("no entities here"), "no entities here");
  });

  it("decodes exactly one level (an escaped entity stays visible)", () => {
    assert.equal(decodeHtmlEntities("&amp;nbsp;"), "&nbsp;");
  });
});

describe("svgInnerToJsx — text", () => {
  it("emits real characters, not literal entity text", () => {
    // Regression: a JSX string literal does NOT decode entities, so emitting the
    // raw serialized text painted `&nbsp;` on screen as six characters.
    const jsx = svgInnerToJsx("<tspan>A&nbsp;BOUNTY&nbsp;HUNTER&#8217;S</tspan>", "");
    assert.ok(!jsx.includes("&nbsp;"), `entity leaked into JSX: ${jsx}`);
    assert.ok(jsx.includes("A BOUNTY HUNTER’S"), jsx);
  });

  it("decodes entities inside attribute values too", () => {
    const jsx = svgInnerToJsx('<text aria-label="Tom &amp; Jerry">x</text>', "");
    assert.ok(jsx.includes('aria-label="Tom & Jerry"'), jsx);
  });
});

describe("svgInnerToJsx — <image> href rewriting", () => {
  it("rewrites xlink:href to the materialized local asset", () => {
    const jsx = svgInnerToJsx('<image xlink:href="/course/media/hero.png" />', "", assetMap, SOURCE);
    assert.ok(jsx.includes('xlinkHref="/assets/cloned/images/ab12.png"'), jsx);
    assert.ok(!jsx.includes("/course/media/hero.png"), `source path shipped: ${jsx}`);
  });

  it("rewrites a plain SVG2 href the same way", () => {
    const jsx = svgInnerToJsx('<image href="https://example.com/course/media/hero.png" />', "", assetMap, SOURCE);
    assert.ok(jsx.includes('href="/assets/cloned/images/ab12.png"'), jsx);
  });

  it("falls back to the transparent GIF when nothing materialized (never a remote ref)", () => {
    const jsx = svgInnerToJsx('<image xlink:href="/course/media/missing.png" />', "", assetMap, SOURCE);
    assert.ok(jsx.includes(TRANSPARENT_GIF), jsx);
    assert.ok(!jsx.includes("missing.png"), `remote/404 ref shipped: ${jsx}`);
  });

  it("leaves in-document fragment refs alone (<use href=\"#id\">)", () => {
    const jsx = svgInnerToJsx('<use xlink:href="#glyph-7" />', "", assetMap, SOURCE);
    assert.ok(jsx.includes('xlinkHref="#glyph-7"'), jsx);
  });

  it("leaves an <image> data: URI alone", () => {
    const jsx = svgInnerToJsx(`<image xlink:href="${TRANSPARENT_GIF}" />`, "", assetMap, SOURCE);
    assert.ok(jsx.includes(TRANSPARENT_GIF), jsx);
  });

  it("does not touch href on non-asset elements (<a href>)", () => {
    const jsx = svgInnerToJsx('<a href="/pricing"><text>Buy</text></a>', "", assetMap, SOURCE);
    assert.ok(jsx.includes('href="/pricing"'), jsx);
  });
});

describe("svgInnerToJsx — attribute quoting", () => {
  it("emits a quote-bearing value as an expression, not a broken JSX string", () => {
    // Regression: decoding `font-family="&quot;Some Font&quot;"` yields a value
    // containing real quotes. A JSX attribute string has no backslash escapes, so
    // `fontFamily="\"Some Font\""` is a syntax error that fails the build.
    const jsx = svgInnerToJsx('<text font-family="&quot;Mandalore Charset1&quot;">x</text>', "");
    assert.ok(jsx.includes('fontFamily={"\\"Mandalore Charset1\\""}'), jsx);
    assert.ok(!/fontFamily="\\"/.test(jsx), `emitted an unparseable JSX string: ${jsx}`);
  });

  it("keeps the plain string form for ordinary values", () => {
    const jsx = svgInnerToJsx('<path d="M0,0L5,5" fill="#fff" />', "");
    assert.ok(jsx.includes('d="M0,0L5,5"'), jsx);
    assert.ok(jsx.includes('fill="#fff"'), jsx);
  });
});
