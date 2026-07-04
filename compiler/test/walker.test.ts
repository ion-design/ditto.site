import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { collectPage, type RawNode, type RawChild } from "../src/capture/walker.js";

function isText(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

function findByTag(root: RawNode, tag: string): RawNode | null {
  if (root.tag === tag) return root;
  for (const c of root.children) {
    if (isText(c)) continue;
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

function textRun(node: RawNode): string {
  let out = "";
  for (const c of node.children) out += isText(c) ? c.text : textRun(c);
  return out;
}

describe("walker whitespace-only text nodes", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    // tsx/esbuild wraps functions with a __name() helper for stack traces; the
    // serialized collectPage carries those calls, so shim it (same as capture.ts).
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("keeps the lone space that is the only child of an inline element", async () => {
    // Real case (ooni.com): the space between "of" and "the" lives alone inside
    // <strong>; dropping it fuses the adjacent text runs ("ofthe").
    const snap = await capture("<p>Creator of<strong> </strong><em><strong>the world's</strong></em></p>");
    const p = findByTag(snap.root, "p")!;
    const strong = p.children.find((c) => !isText(c) && c.tag === "strong") as RawNode;
    assert.deepEqual(strong.children, [{ text: " " }]);
    assert.equal(textRun(p), "Creator of the world's");
  });

  it("still keeps the single space between inline elements", async () => {
    const snap = await capture("<p><em>a</em> <em>b</em></p>");
    const p = findByTag(snap.root, "p")!;
    assert.equal(textRun(p), "a b");
  });

  it("does not emit a space inside an empty block container", async () => {
    const snap = await capture("<main><section>\n   \n</section></main>");
    const section = findByTag(snap.root, "section")!;
    assert.deepEqual(section.children, []);
  });
});

function findByClass(root: RawNode, cls: string): RawNode | null {
  if ((root.attrs?.class ?? "").split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    if (isText(c)) continue;
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

describe("walker off-screen visibility", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 768 });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("marks a fixed off-screen-left drawer's un-hidden inner content invisible", async () => {
    // Real case (ooni.com): a slide-in search drawer is a position:fixed box parked at
    // x:-375 (right edge at 0) with visibility:hidden; its inner content sets
    // visibility:visible (so getComputedStyle reports it visible) but the whole box is
    // still off the left edge. The drawer must not leak into the clone's DOM text.
    const snap = await capture(`
      <div class="drawer" style="position:fixed;left:0;top:0;width:375px;height:768px;
           transform:translateX(-100%);visibility:hidden;">
        <div class="inner" style="visibility:visible;width:343px;">
          <h2 class="drawer-title">Popular Searches</h2>
        </div>
      </div>
      <p class="onscreen">Hello</p>`);
    const title = findByClass(snap.root, "drawer-title")!;
    assert.equal(title.visible, false, "off-screen-left drawer title should be invisible");
    // The genuinely on-screen paragraph is still visible (sanity that the gate isn't over-broad).
    const onscreen = findByClass(snap.root, "onscreen")!;
    assert.equal(onscreen.visible, true, "on-screen content stays visible");
  });

  it("keeps a partially-overlapping negative-margin decoration visible", async () => {
    // A decoration pulled left by a negative margin so it straddles the left edge
    // (x:-40, width:200 -> right edge +160) still paints and must stay visible.
    const snap = await capture(`
      <div style="overflow:hidden;width:375px;">
        <div class="deco" style="width:200px;height:40px;margin-left:-40px;background:red;">peek</div>
      </div>`);
    const deco = findByClass(snap.root, "deco")!;
    assert.ok(deco.bbox.x < 0, "decoration starts off-screen left");
    assert.ok(deco.bbox.x + deco.bbox.width > 0, "but its right edge is on-screen");
    assert.equal(deco.visible, true, "partially-overlapping decoration stays visible");
  });

  it("keeps normal in-flow content below the fold visible", async () => {
    // The page scrolls vertically, so content below the viewport is reachable and must
    // NOT be marked invisible (only position:fixed boxes are pinned).
    const snap = await capture(`
      <div style="height:2000px;"></div>
      <p class="belowfold" style="height:40px;">Below the fold</p>`);
    const below = findByClass(snap.root, "belowfold")!;
    assert.ok(below.bbox.y > 768, "content is below the 768px viewport");
    assert.equal(below.visible, true, "below-fold in-flow content stays visible");
  });

  it("marks a computed-visibility:hidden subtree invisible", async () => {
    // A subtree whose computed visibility is actually hidden (and does not set
    // visibility:visible on any descendant) is not painted.
    const snap = await capture(`
      <div style="visibility:hidden;width:300px;">
        <span class="hidden-child">secret</span>
      </div>`);
    const child = findByClass(snap.root, "hidden-child")!;
    assert.equal(child.visible, false, "computed-hidden child is invisible");
  });

  it("rejects a fixed box parked entirely below the viewport", async () => {
    // A position:fixed banner pinned below the viewport bottom never scrolls into view.
    const snap = await capture(`
      <div class="fixedlow" style="position:fixed;left:0;top:900px;width:375px;height:60px;">
        <span>hidden banner</span>
      </div>`);
    const fixed = findByClass(snap.root, "fixedlow")!;
    assert.equal(fixed.visible, false, "fixed box below the viewport is invisible");
  });
});

describe("walker font-metric probe tagging (fix 4)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 768 });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("tags a far-off-screen, non-painting measurement scratch node as a probe", async () => {
    // The classic font-metric probe pattern (WordPress/typography libs): absolutely positioned,
    // parked ~100000px off-screen, visibility:hidden, holding measurement text.
    const snap = await capture(`
      <p class="real">Real content</p>
      <div class="probe" style="position:absolute;top:-99999px;left:-99999px;
           visibility:hidden;white-space:nowrap;">Mgy</div>`);
    const probe = findByClass(snap.root, "probe")!;
    assert.equal(probe.probe, true, "far-off-screen hidden scratch node is a probe");
    const real = findByClass(snap.root, "real")!;
    assert.ok(!real.probe, "real content is not a probe");
  });

  it("does NOT tag a near-off-screen hidden drawer (real content) as a probe", async () => {
    // A slide-in drawer parked just off the left edge (x:-375, visibility:hidden) is real
    // content that a controller can reveal — it must NOT be mistaken for a measurement probe.
    const snap = await capture(`
      <div class="drawer" style="position:fixed;left:0;top:0;width:375px;height:768px;
           transform:translateX(-100%);visibility:hidden;">
        <h2 class="dtitle">Menu</h2>
      </div>`);
    const drawer = findByClass(snap.root, "drawer")!;
    assert.ok(!drawer.probe, "a near-off-screen drawer is not a probe");
  });

  it("does NOT tag an sr-only (visible, on-screen-adjacent) accessibility label as a probe", async () => {
    // Screen-reader-only text stays visibility:visible so AT can read it; even parked far off
    // via left:-9999px it must survive (and 9999px is under the 10000px probe threshold anyway).
    const snap = await capture(`
      <a href="/"><span class="sr" style="position:absolute;left:-9999px;">Skip to content</span>Home</a>`);
    const sr = findByClass(snap.root, "sr")!;
    assert.ok(!sr.probe, "sr-only accessible text is not a probe");
  });
});

describe("walker sizing probe: circular authored-height guard", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("keeps an explicit 100vh height (circular hero/fill-child pair)", async () => {
    // A hero authored `height:100vh` with a `height:100%` fill child: setting the hero to
    // `height:auto` still reproduces its box because the child pins it back, so the raw probe
    // would read hAuto:true and the authored 100vh would be dropped — hero collapses to 0.
    const snap = await capture(`
      <style>
        .hero { height: 100vh; display: flex; }
        .fill { height: 100%; width: 100%; }
      </style>
      <section class="hero"><div class="fill"><p>content</p></div></section>`);
    const hero = findByClass(snap.root, "hero")!;
    assert.ok(hero.sizing, "hero was probed");
    assert.equal(hero.sizing!.hAuto, false, "explicit 100vh is not content-sized");
    assert.equal(hero.sizing!.hFill, false, "explicit 100vh is authored, not a parent fill");
    // Box actually equals the viewport height (720), proving the circular reproduction.
    assert.ok(Math.abs(hero.bbox.height - 720) <= 1, "hero rendered at 100vh");
  });

  it("keeps an explicit px height whose fill child reproduces it", async () => {
    const snap = await capture(`
      <style>
        .section { height: 400px; display: flex; }
        .fill { height: 100%; width: 100%; }
      </style>
      <div class="section"><div class="fill"><p>content</p></div></div>`);
    const section = findByClass(snap.root, "section")!;
    assert.ok(section.sizing, "section was probed");
    assert.equal(section.sizing!.hAuto, false, "explicit 400px is not content-sized");
    assert.equal(section.sizing!.hFill, false, "explicit 400px is authored, not a fill");
    assert.ok(Math.abs(section.bbox.height - 400) <= 1, "section rendered at 400px");
  });

  it("keeps an explicit height authored via inline style", async () => {
    const snap = await capture(`
      <style>.fill { height: 100%; width: 100%; }</style>
      <div class="box" style="height: 300px; display: flex;">
        <div class="fill"><p>content</p></div>
      </div>`);
    const box = findByClass(snap.root, "box")!;
    assert.ok(box.sizing, "box was probed");
    assert.equal(box.sizing!.hAuto, false, "inline explicit height is kept");
    assert.equal(box.sizing!.hFill, false, "inline explicit height is not a fill");
  });

  it("resolves the mutual parent/child pair without disturbing the fill child", async () => {
    // The child is a GENUINE fill (height:100%) and must keep hFill:true / hAuto:false so the
    // generator emits h-full for it; only the parent's circular verdict is corrected.
    const snap = await capture(`
      <style>
        .outer { height: 500px; display: flex; }
        .inner { height: 100%; width: 100%; }
      </style>
      <div class="outer"><div class="inner"><p>content</p></div></div>`);
    const outer = findByClass(snap.root, "outer")!;
    const inner = findByClass(snap.root, "inner")!;
    assert.equal(outer.sizing!.hAuto, false, "parent explicit height kept");
    assert.equal(outer.sizing!.hFill, false, "parent is authored, not a fill");
    // The child authors only `height:100%` (a fill), so the explicit-height guard must NOT fire on
    // it — hFill stays true so the generator can still emit h-full for the genuine fill child.
    assert.equal(inner.sizing!.hFill, true, "child still fills the definite parent");
  });

  it("still detects a genuinely content-sized (auto) height as hAuto", async () => {
    // No authored height anywhere: the box is content-sized and must stay droppable.
    const snap = await capture(`
      <style>.wrap { display: block; }</style>
      <div class="wrap"><p>just some flowing text content</p></div>`);
    const wrap = findByClass(snap.root, "wrap")!;
    assert.ok(wrap.sizing, "wrap was probed");
    assert.equal(wrap.sizing!.hAuto, true, "content-sized height is still auto");
  });

  it("does not treat a percentage or zero authored height as explicit", async () => {
    // height:100% is the FILL case (handled by hFill), and height:0 is not definite; neither
    // should trip the explicit-height override.
    const snap = await capture(`
      <style>
        .pct-parent { height: 300px; }
        .pct { height: 100%; }
      </style>
      <div class="pct-parent"><div class="pct"><p>x</p></div></div>`);
    const pct = findByClass(snap.root, "pct")!;
    assert.ok(pct.sizing, "pct was probed");
    // A true fill child: hFill true, hAuto false — untouched by the explicit-height guard.
    assert.equal(pct.sizing!.hFill, true, "percentage height stays a fill");
    assert.equal(pct.sizing!.hAuto, false, "percentage fill is not content-sized");
  });
});

// T4 — symmetric circular-WIDTH guard: an authored `width:24px` inside a SHRINK-TO-FIT parent makes
// both width:auto and width:100% reproduce the box (the parent's width still holds), so the raw probe
// reads wAuto/wFill and the width is dropped — collapsing the swatch in the clone. When the element
// authors an explicit definite width (cascade or inline), the probe must trust that and clear both.
describe("walker sizing probe: circular authored-width guard (T4)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("keeps an explicit px width inside a shrink-wrap parent (cascade rule)", async () => {
    // The wrapper is an inline-block that shrink-wraps to the swatch; width:auto on the swatch still
    // reads 24px because the parent width holds → the raw verdict would be wAuto:true (dropped).
    const snap = await capture(`
      <style>
        .wrapper { display: inline-block; border: 1px solid #000; }
        .swatch { width: 24px; height: 24px; display: block; background: red; }
      </style>
      <span class="wrapper"><a class="swatch"></a></span>`);
    const swatch = findByClass(snap.root, "swatch")!;
    assert.ok(swatch.sizing, "swatch was probed");
    assert.equal(swatch.sizing!.wAuto, false, "explicit 24px width is not content-sized (auto)");
    assert.equal(swatch.sizing!.wFill, false, "explicit 24px width is authored, not a parent fill");
  });

  it("keeps an explicit width authored via inline style", async () => {
    const snap = await capture(`
      <span style="display:inline-block;border:1px solid #000;">
        <a class="swatch2" style="width:24px;height:24px;display:block;background:blue;"></a>
      </span>`);
    const swatch = findByClass(snap.root, "swatch2")!;
    assert.ok(swatch.sizing, "swatch was probed");
    assert.equal(swatch.sizing!.wAuto, false, "inline explicit width is kept (not auto)");
    assert.equal(swatch.sizing!.wFill, false, "inline explicit width is not a fill");
  });

  it("still detects a genuinely content-sized (auto) width as wAuto", async () => {
    // No authored width: an inline-block sizing to its text must stay droppable (wAuto:true).
    const snap = await capture(`
      <div style="display:block;"><span class="cw" style="display:inline-block;">hello content</span></div>`);
    const cw = findByClass(snap.root, "cw")!;
    assert.ok(cw.sizing, "cw was probed");
    assert.equal(cw.sizing!.wAuto, true, "content-sized width is still auto");
  });

  it("harvests an explicit-width rule from a custom element's SHADOW ROOT stylesheet", async () => {
    // The width:24px rule lives inside the custom element's shadow root (a <style> in the shadow tree),
    // never in document.styleSheets. Without walking shadow-root sheets the harvest misses it and the
    // circular-width guard can't fire for the swatch link. Verify the shadow swatch keeps its width.
    const snap = await capture(`
      <script>
        customElements.define('color-swatch', class extends HTMLElement {
          constructor() {
            super();
            const r = this.attachShadow({ mode: 'open' });
            r.innerHTML = '<style>.wrap{display:inline-block;border:1px solid #000}.pin{width:24px;height:24px;display:block;background:green}</style><span class="wrap"><a class="pin"></a></span>';
          }
        });
      </script>
      <color-swatch></color-swatch>`);
    const pin = findByClass(snap.root, "pin")!;
    assert.ok(pin.sizing, "shadow swatch was probed");
    assert.equal(pin.sizing!.wAuto, false, "shadow-root explicit 24px width is kept (not auto)");
    assert.equal(pin.sizing!.wFill, false, "shadow-root explicit width is not a fill");
  });
});

describe("walker text-wrap capture", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("captures text-wrap:balance on a heading (modern line-balancing)", async () => {
    // Real case: a hero heading authored `text-wrap:balance` wraps its two lines evenly; without
    // capturing the prop the clone wraps it lopsidedly.
    const snap = await capture(`<h1 style="text-wrap:balance">BUILT RUGGED. WORN DAILY.</h1>`);
    const h1 = findByTag(snap.root, "h1")!;
    assert.equal(h1.computed.textWrap, "balance", "text-wrap:balance is captured");
  });

  it("captures text-wrap:pretty", async () => {
    const snap = await capture(`<p style="text-wrap:pretty">Some flowing paragraph text here.</p>`);
    const p = findByTag(snap.root, "p")!;
    assert.equal(p.computed.textWrap, "pretty", "text-wrap:pretty is captured");
  });
});

describe("walker shadow-DOM composed-tree serialization (FIX 1)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => {
    await browser.close();
  });

  // Attach an OPEN shadow root to any host carrying data-shadow, injecting its data-shadow value as
  // the shadow tree HTML. Runs in-page before collectPage so getComputedStyle/bbox see the composed tree.
  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate(() => {
      for (const host of Array.from(document.querySelectorAll("[data-shadow]"))) {
        const markup = host.getAttribute("data-shadow") || "";
        const sr = (host as HTMLElement).attachShadow({ mode: "open" });
        sr.innerHTML = markup;
      }
    });
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("serializes an open custom element's shadow tree as the host's children", async () => {
    // A `<product-info>` web component renders its swatches/title/price INSIDE its shadow root; a
    // childNodes-only walk captured it empty. The composed walk must surface the shadow content.
    const snap = await capture(`
      <product-info data-shadow="
        <div class='pi-title'>Magnolia Shirt</div>
        <span class='pi-price'>$78.00</span>
      "></product-info>`);
    const host = findByTag(snap.root, "product-info")!;
    assert.ok(host, "the custom element host is present");
    assert.equal(host.shadowHost, true, "the host is tagged as a shadow host");
    assert.equal(textRun(host).replace(/\s+/g, " ").trim(), "Magnolia Shirt $78.00", "the shadow tree text is captured");
    const title = findByClass(host, "pi-title")!;
    assert.ok(title, "a shadow descendant node is serialized");
    assert.equal(title.inShadow, true, "shadow descendants are tagged inShadow");
    assert.ok(title.bbox.width > 0, "shadow nodes get real bboxes via getBoundingClientRect");
  });

  it("renders the FLATTENED tree: a <slot> is replaced by its assigned light-DOM nodes", async () => {
    // The host's light child (the assigned node) renders at the slot position — once, and NOT tagged
    // inShadow (it is the author's real content). Shadow chrome around the slot still appears.
    const snap = await capture(`
      <my-card data-shadow="
        <div class='card-frame'><slot></slot></div>
      "><h2 class='slotted'>Vintage Sunset T-Shirt</h2></my-card>`);
    const host = findByTag(snap.root, "my-card")!;
    const frame = findByClass(host, "card-frame")!;
    assert.ok(frame, "the shadow frame around the slot is serialized");
    assert.equal(frame.inShadow, true, "the shadow frame is tagged inShadow");
    const slotted = findByClass(host, "slotted")!;
    assert.ok(slotted, "the slotted light child renders at the slot position");
    assert.equal(textRun(slotted).trim(), "Vintage Sunset T-Shirt");
    assert.ok(!slotted.inShadow, "the slotted light child is NOT tagged inShadow (author content)");
    // No double-serialization: exactly one node carries the slotted text.
    let count = 0;
    const countText = (n: RawNode): void => {
      if (n.children.some((c) => isText(c) && c.text.includes("Vintage Sunset T-Shirt"))) count++;
      for (const c of n.children) if (!isText(c)) countText(c as RawNode);
    };
    countText(host);
    assert.equal(count, 1, "the slotted child is serialized exactly once");
  });

  it("uses <slot> fallback content when nothing is assigned", async () => {
    const snap = await capture(`
      <my-badge data-shadow="
        <span class='badge'><slot>Default Label</slot></span>
      "></my-badge>`);
    const host = findByTag(snap.root, "my-badge")!;
    assert.equal(textRun(host).replace(/\s+/g, " ").trim(), "Default Label", "unfilled slot falls back to its own content");
  });

  it("does not tag ordinary light-DOM nodes as shadow", async () => {
    const snap = await capture(`<div class="plain"><p>light</p></div>`);
    const plain = findByClass(snap.root, "plain")!;
    assert.ok(!plain.shadowHost, "a plain div is not a shadow host");
    assert.ok(!plain.inShadow, "plain light DOM is not tagged inShadow");
  });
});
