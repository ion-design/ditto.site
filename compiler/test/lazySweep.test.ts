import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { discoverLazyAssetsInPage } from "../src/capture/capture.js";

const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

const VW = 1280, VH = 800;
const BASE = "https://example.com/page/";

// ---------------------------------------------------------------------------
// Item 2: extended lazy-asset discovery sweep (in-page discovery function).
// ---------------------------------------------------------------------------
describe("lazySweep: discoverLazyAssetsInPage", () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  const discover = async (bodyHtml: string): Promise<string[]> => {
    const page: Page = await browser.newPage();
    await page.setViewportSize({ width: VW, height: VH });
    await page.addInitScript(ESBUILD_SHIM);
    // A <base> gives relative refs a stable absolute form to assert against.
    await page.setContent(`<!doctype html><html><head><base href="${BASE}"></head><body>${bodyHtml}</body></html>`);
    await page.evaluate(ESBUILD_SHIM);
    const refs = await page.evaluate(discoverLazyAssetsInPage);
    await page.close();
    return refs;
  };

  it("discovers img/source src + srcset inside <noscript> fallback markup", async () => {
    const refs = await discover(`
      <noscript>
        <img src="hero.jpg" srcset="hero-2x.jpg 2x, hero-3x.jpg 3x">
        <picture><source srcset="alt.webp 1x, alt-2x.webp 2x"></picture>
      </noscript>
    `);
    assert.ok(refs.includes(BASE + "hero.jpg"), "noscript img src");
    assert.ok(refs.includes(BASE + "hero-2x.jpg"), "first srcset variant from noscript img");
    assert.ok(refs.includes(BASE + "alt.webp"), "first srcset variant from noscript source");
  });

  it("discovers url(...) values from an element's inline style attribute", async () => {
    const refs = await discover(`
      <div style="background-image: url('bg.png'); color: red"></div>
      <span style='background: url("sprite.svg") no-repeat'></span>
    `);
    assert.ok(refs.includes(BASE + "bg.png"), "inline background-image url()");
    assert.ok(refs.includes(BASE + "sprite.svg"), "inline background shorthand url()");
  });

  it("discovers data-background / data-background-image (raw URL and url(...) forms)", async () => {
    const refs = await discover(`
      <div data-background="lazybg.jpg"></div>
      <div data-background-image="url('lazybg2.png')"></div>
    `);
    assert.ok(refs.includes(BASE + "lazybg.jpg"), "raw data-background URL");
    assert.ok(refs.includes(BASE + "lazybg2.png"), "url()-wrapped data-background-image");
  });

  it("discovers the resolved src of an img[loading=lazy]", async () => {
    const refs = await discover(`<img loading="lazy" src="belowfold.jpg">`);
    assert.ok(refs.includes(BASE + "belowfold.jpg"));
  });

  it("drops data: URIs and dedupes + sorts", async () => {
    const refs = await discover(`
      <div style="background: url('dup.png')"></div>
      <div data-background="dup.png"></div>
      <img loading="lazy" src="data:image/gif;base64,R0lGOD">
    `);
    assert.equal(refs.filter((u) => u.endsWith("dup.png")).length, 1, "deduped across channels");
    assert.equal(refs.some((u) => u.startsWith("data:")), false, "data: URIs dropped");
    assert.deepEqual(refs, [...refs].sort(), "sorted");
  });

  it("returns nothing for a page with no lazy references", async () => {
    const refs = await discover(`<div><p>hello</p><img src="eager.jpg"></div>`);
    // The eager <img src> is the walker's job, not this sweep — the sweep only harvests
    // the channels the walker misses.
    assert.deepEqual(refs, []);
  });
});
