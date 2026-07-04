import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildColorPalette, colorClusterKey } from "../src/infer/semanticTokens.js";
import { planSections, nameFromSourceToken } from "../src/generate/sectionSplit.js";
import type { IR, IRNode, IRChild, StyleMap } from "../src/normalize/ir.js";

const CW = 1280;

type Box = { x?: number; y: number; width?: number; height: number };
function el(tag: string, box: Box, computed: StyleMap, children: IRChild[] = [], attrs: Record<string, string> = {}, srcClass?: string): IRNode {
  const n: IRNode = {
    id: "", tag, attrs,
    visibleByVp: { [CW]: true },
    bboxByVp: { [CW]: { x: box.x ?? 0, y: box.y, width: box.width ?? CW, height: box.height } },
    computedByVp: { [CW]: { display: "block", ...computed } },
    children,
  };
  if (srcClass) n.srcClass = srcClass;
  return n;
}
function text(t: string): IRChild { return { text: t }; }

function page(children: IRNode[], pageH: number, body?: { bodyBg?: string; bodyColor?: string }): IR {
  // The body carries its own bg/fg computed style (as a real capture does), so the palette's
  // usage histogram actually sees the page background/foreground colours it will name.
  const root = el("body", { y: 0, height: pageH }, {
    ...(body?.bodyBg ? { backgroundColor: body.bodyBg } : {}),
    ...(body?.bodyColor ? { color: body.bodyColor } : {}),
  }, children);
  let i = 0;
  const assign = (n: IRNode): void => { n.id = `n${i++}`; for (const c of n.children) if ((c as IRNode).tag) assign(c as IRNode); };
  assign(root);
  return {
    doc: {
      sourceUrl: "https://example.test/", title: "Fixture", lang: "en", charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: [CW], sampleViewports: [CW], canonicalViewport: CW,
      perViewport: { [CW]: { scrollHeight: pageH, scrollWidth: CW, htmlBg: "", bodyBg: body?.bodyBg ?? "", bodyColor: body?.bodyColor ?? "", bodyFont: "" } },
      nodeCount: i, keyframes: [],
    },
    root,
  } as IR;
}

// ----------------------------------------------------------------------------
// 1) Semantic role assignment — a fixture IR with known roles must produce the
//    expected named tokens (deterministically), leftovers only for role-less colours.
// ----------------------------------------------------------------------------
describe("semantic color palette: role assignment", () => {
  // page bg = cream; body text = near-black; a saturated red brand used on buttons/links;
  // a light-gray surface used as several card backgrounds; a border gray; one odd accent.
  function siteIr(): IR {
    const kids: IRNode[] = [];
    // Body text (near-black) x8
    for (let k = 0; k < 8; k++) kids.push(el("p", { y: 100 + k * 30, height: 20 }, { color: "rgb(20, 20, 19)" }, [text("copy")]));
    // Brand red on buttons/links x6 (interactive → --primary)
    for (let k = 0; k < 6; k++) kids.push(el("a", { y: 400 + k * 30, height: 40 }, { backgroundColor: "rgb(188, 0, 0)", color: "rgb(255,255,255)" }, [text("Buy")]));
    // Light-gray card surfaces x5 (bg, light, low-sat → --surface)
    for (let k = 0; k < 5; k++) kids.push(el("div", { y: 800 + k * 60, height: 50 }, { backgroundColor: "rgb(240, 238, 230)" }));
    // Border gray x4 (border only → --border)
    for (let k = 0; k < 4; k++) kids.push(el("div", { y: 1200 + k * 30, height: 20 }, { borderTopColor: "rgb(200, 200, 200)", borderTopWidth: "1px" }));
    return page(kids, 1600, { bodyBg: "rgb(252, 251, 246)", bodyColor: "rgb(20, 20, 19)" });
  }

  it("names background / foreground / primary / surface / border from usage evidence", () => {
    const p = buildColorPalette(siteIr());
    const byName = new Map(p.tokens.map((t) => [t.name, t.value]));
    assert.equal(byName.get("--background"), "rgb(252, 251, 246)");
    assert.equal(byName.get("--foreground"), "rgb(20, 20, 19)");
    assert.equal(byName.get("--primary"), "rgb(188, 0, 0)");
    assert.equal(byName.get("--surface"), "rgb(240, 238, 230)");
    assert.equal(byName.get("--border"), "rgb(200, 200, 200)");
    // Every named token resolves back to itself.
    assert.equal(p.varForColor("rgb(188, 0, 0)"), "var(--primary)");
  });

  it("is deterministic: same IR → byte-identical token list", () => {
    const a = buildColorPalette(siteIr()).css;
    const b = buildColorPalette(siteIr()).css;
    assert.equal(a, b);
  });

  it("resolves oklab/oklch forms of a named colour to the SAME semantic token (±2 sRGB)", () => {
    // oklch(0.987… 97°) ≈ rgb(252,251,246) — the page background. Reached only via a
    // gradient/decoration property, it must still map to --background, not a fresh --clr-N.
    const p = buildColorPalette(page([
      ...Array.from({ length: 4 }, (_, k) => el("p", { y: 100 + k * 30, height: 20 }, { color: "rgb(20, 20, 19)" }, [text("x")])),
    ], 400, { bodyBg: "oklch(0.987472 0.00667657 97.3497)", bodyColor: "rgb(20, 20, 19)" }));
    const bg = p.tokens.find((t) => t.name === "--background");
    assert.ok(bg, "background named");
    // The rgb() equivalent within tolerance resolves to --background via the ±2 fallback.
    assert.equal(p.varForColor("rgb(252, 251, 246)"), "var(--background)");
  });
});

// ----------------------------------------------------------------------------
// 2) colorClusterKey — visually identical literals share a key; distinct colours don't.
// ----------------------------------------------------------------------------
describe("colorClusterKey (interner visual dedup)", () => {
  it("collapses oklab forms that round to the same sRGB", () => {
    // Both oklab(0.988…) whites → rgb(251,251,251).
    const a = colorClusterKey("oklab(0.988242 -0.0000812355 0.00000757745)");
    const b = colorClusterKey("oklab(0.988371 -0.0000803481 0.00000749468)");
    assert.ok(a);
    assert.equal(a, b);
  });
  it("keeps genuinely different colours on different keys", () => {
    assert.notEqual(colorClusterKey("rgb(0,0,0)"), colorClusterKey("rgb(255,255,255)"));
    assert.notEqual(colorClusterKey("rgb(188,0,0)"), colorClusterKey("rgb(0,0,188)"));
  });
  it("separates alpha variants", () => {
    assert.notEqual(colorClusterKey("rgba(0,0,0,0.5)"), colorClusterKey("rgba(0,0,0,0.75)"));
  });
  it("returns null for unparseable values (keeps raw-literal keying)", () => {
    assert.equal(colorClusterKey("var(--x)"), null);
    assert.equal(colorClusterKey("currentColor"), null);
  });
});

// ----------------------------------------------------------------------------
// 3) Name sanitization — hashy-suffix stripping + generic-word filtering.
// ----------------------------------------------------------------------------
describe("nameFromSourceToken (source-id sanitization)", () => {
  it("strips Shopify template prefix + trailing hash → semantic slug", () => {
    assert.equal(nameFromSourceToken("shopify-section-template--19797275672650__split_callout_JtTWTt"), "SplitCallout");
    // `grid` is a generic structural word (dropped); the hash `RbEALJ` is stripped.
    assert.equal(nameFromSourceToken("shopify-section-template--19797275672650__media_card_grid_RbEALJ"), "MediaCard");
  });
  it("strips mixed-case build hashes (JtTWTt / dDMm2q / RbEALJ)", () => {
    assert.equal(nameFromSourceToken("split_callout_JtTWTt"), "SplitCallout");
    assert.equal(nameFromSourceToken("hero_hD9krx"), "Hero");
  });
  it("drops generic structural words entirely", () => {
    assert.equal(nameFromSourceToken("g_section_wrap"), "");
    assert.equal(nameFromSourceToken("section-inner-content"), "");
    assert.equal(nameFromSourceToken("shopify-section-group-header"), "Header");
  });
  it("handles js-* hooks and long numeric ids", () => {
    assert.equal(nameFromSourceToken("js-media-banner-section"), "MediaBanner");
    assert.equal(nameFromSourceToken("template--19797275672650"), "");
  });
});

// ----------------------------------------------------------------------------
// 4) planSections — a Shopify-id section beats a heading slug; noisy classes don't.
// ----------------------------------------------------------------------------
describe("planSections: source-id naming precedence", () => {
  it("names a section from its CMS section id (hash stripped) over generic evidence", () => {
    const nav = el("nav", { y: 0, height: 62 }, {});
    const hero = el("section", { y: 62, height: 800 }, {}, [el("h1", { y: 120, height: 60, x: 120, width: 900 }, {}, [text("Welcome")])]);
    // A one-off band with NO heading but a clean Shopify id → SplitCalloutSection.
    const callout = el("div", { y: 862, height: 600 }, {}, [
      el("p", { y: 900, height: 40, x: 120, width: 600 }, {}, [text("Some marketing copy here")]),
    ], { id: "shopify-section-template--19797275672650__split_callout_JtTWTt" }, "shopify-section js-split-callout-section");
    const b2 = el("section", { y: 1462, height: 500 }, {}, [el("h2", { y: 1500, height: 40, x: 120, width: 600 }, {}, [text("Everything you need today")]), el("p", { y: 1560, height: 24, x: 120, width: 600 }, {}, [text("extra")])]);
    const b3 = el("section", { y: 1962, height: 500 }, {}, [el("h2", { y: 2000, height: 40, x: 120, width: 600 }, {}, [text("What customers say now")]), el("p", { y: 2060, height: 24, x: 120, width: 600 }, {}, [text("a")]), el("p", { y: 2090, height: 24, x: 120, width: 600 }, {}, [text("b")])]);
    const footer = el("footer", { y: 2462, height: 400 }, {}, [el("a", { y: 2500, height: 20, x: 120, width: 200 }, {}, [text("Privacy")], {}, undefined)]);
    const ir = page([nav, hero, callout, b2, b3, footer], 2862);
    const names = [...planSections(ir).roots.values()];
    assert.ok(names.includes("SplitCalloutSection"), `expected SplitCalloutSection in ${names.join(", ")}`);
  });

  it("does NOT mine arbitrary utility classes (falls back to heading slug)", () => {
    const nav = el("nav", { y: 0, height: 62 }, {});
    const hero = el("section", { y: 62, height: 800 }, {}, [el("h1", { y: 120, height: 60, x: 120, width: 900 }, {}, [text("Welcome home")])]);
    // Heading present, but the only source class is a noisy Webflow utility → use the heading.
    const band = el("section", { y: 862, height: 600 }, {}, [
      el("h2", { y: 900, height: 40, x: 120, width: 600 }, {}, [text("Latest releases from us")]),
    ], {}, "g_section_space duraldar-cta_section w-variant-60a7ad7d");
    const b2 = el("section", { y: 1462, height: 500 }, {}, [el("h2", { y: 1500, height: 40, x: 120, width: 600 }, {}, [text("Everything you need")]), el("p", { y: 1560, height: 24, x: 120, width: 600 }, {}, [text("x")])]);
    const footer = el("footer", { y: 1962, height: 400 }, {}, [el("a", { y: 2000, height: 20, x: 120, width: 200 }, {}, [text("Privacy")])]);
    const ir = page([nav, hero, band, b2, footer], 2362);
    const names = [...planSections(ir).roots.values()];
    assert.ok(names.some((n) => /^LatestReleases/.test(n)), `expected heading slug, got ${names.join(", ")}`);
    assert.ok(!names.some((n) => /Duraldar|Space/.test(n)), `must not mine utility classes: ${names.join(", ")}`);
  });
});
