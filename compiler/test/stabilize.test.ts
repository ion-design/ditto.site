import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  promoteLazyMediaInPage,
  settleCarouselsInPage,
  forceRevealForShot,
  restoreRevealForShot,
} from "../src/capture/stabilize.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
// tsx/esbuild wraps functions with a __name() helper for stack traces; the serialized
// page functions carry those calls, so shim it (same as capture.ts's init script).
const ESBUILD_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

describe("stabilize: lazy-media promotion", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.goto(pathToFileURL(join(FIXTURES, "lazy.html")).href);
  });
  after(async () => {
    await browser.close();
  });

  it("promotes data-lazy-src/data-src/data-srcset/data-bg and measures the loaded size", async () => {
    const count = await page.evaluate(promoteLazyMediaInPage);
    // lazy1 (src), lazy2 (src), lazysource (srcset), lazy3 (src), lazybg (background)
    assert.equal(count, 5);

    const state = await page.evaluate(() => {
      const attr = (id: string, name: string) => document.getElementById(id)?.getAttribute(name) ?? null;
      const img = (id: string) => document.getElementById(id) as HTMLImageElement;
      return {
        lazy1Src: attr("lazy1", "src"),
        lazy1Loading: attr("lazy1", "loading"),
        lazy1Width: img("lazy1").naturalWidth,
        lazy2Src: attr("lazy2", "src"),
        lazy2Sizes: attr("lazy2", "sizes"), // data-sizes="auto" is a flag, not a value
        sourceSrcset: attr("lazysource", "srcset"),
        lazy3Src: attr("lazy3", "src"),
        bg: (document.getElementById("lazybg") as HTMLElement).style.backgroundImage,
        notaurlSrc: attr("notaurl", "src"),
      };
    });
    assert.equal(state.lazy1Src, "og-image.png");
    assert.equal(state.lazy1Loading, "eager");
    assert.ok(state.lazy1Width > 1, "promoted image decoded to its real size");
    assert.equal(state.lazy2Src, "seo-icon.png");
    assert.equal(state.lazy2Sizes, null);
    assert.equal(state.sourceSrcset, "og-image.png 1x");
    assert.equal(state.lazy3Src, "og-image.png");
    assert.ok(state.bg.includes("brand.svg"), `background promoted (got ${state.bg})`);
    assert.equal(state.notaurlSrc, null, "non-URL data attr must not be promoted");
  });

  it("is idempotent and never clobbers an src that already equals the target", async () => {
    const again = await page.evaluate(promoteLazyMediaInPage);
    assert.equal(again, 0);
    const alreadySrc = await page.evaluate(() => document.getElementById("already")?.getAttribute("src"));
    assert.equal(alreadySrc, "seo-icon.png");
  });
});

describe("stabilize: carousel settling", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.goto(pathToFileURL(join(FIXTURES, "carousel-autoplay.html")).href);
  });
  after(async () => {
    await browser.close();
  });

  const txOf = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s)!;
      return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    }, sel);

  it("returns an autoplaying carousel to its home slide and pauses autoplay", async () => {
    // let autoplay advance at least one slide so there is something to settle
    await page.waitForFunction("window.__autoplayTicks >= 2", null, { timeout: 5000 });
    assert.notEqual(await txOf(".splide__list"), 0);

    const res = await page.evaluate(settleCarouselsInPage);
    assert.equal(res.roots, 2);
    assert.equal(res.normalized, 2);

    assert.equal(await txOf(".splide__list"), 0, "track back at the home slide");
    const bulletActive = await page.evaluate(() =>
      document.querySelector(".splide__pagination__bullet")!.classList.contains("is-active"));
    assert.ok(bulletActive, "first bullet re-activated");

    // paused: no further autoplay ticks, and the track holds its home transform
    const ticks = await page.evaluate("window.__autoplayTicks");
    await page.waitForTimeout(700); // > 2 autoplay intervals
    assert.equal(await page.evaluate("window.__autoplayTicks"), ticks, "autoplay latched paused");
    assert.equal(await txOf(".splide__list"), 0, "track still at home after the autoplay window");
  });

  it("pins a control-less non-loop track left mid-offset back to translateX(0)", async () => {
    assert.equal(await txOf("#stuck .swiper-wrapper"), 0);
  });

  it("cancels a mid-flight track transition instead of freezing it", async () => {
    // Start a slide transition and settle while it is still running: pausing the
    // CSSTransition would disassociate it from style and HOLD the frozen mid-flight
    // transform over the home navigation — the settled track must still land at 0.
    await page.evaluate(`(async () => {
      const bullets = document.querySelectorAll(".splide__pagination__bullet");
      bullets[2].click(); // transition toward slide 3 begins (0.2s)
      return await (${settleCarouselsInPage.toString()})();
    })()`);
    assert.equal(await txOf(".splide__list"), 0, "track settled at home, not a frozen mid-flight offset");
  });
});

describe("stabilize: force-reveal for element screenshots", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(
      '<div id="wrap" style="visibility:hidden">' +
      '<video id="v" style="width:320px;height:180px;background:#000"></video>' +
      "</div>",
    );
  });
  after(async () => {
    await browser.close();
  });

  it("reveals the hidden ancestor chain so the screenshot succeeds, then restores exactly", async () => {
    const vis = () => page.evaluate(() => getComputedStyle(document.getElementById("v")!).visibility);
    assert.equal(await vis(), "hidden");

    const forced = await page.evaluate(forceRevealForShot, "#v");
    assert.equal(forced, 2); // the video (inherited hidden) + the wrapping div
    assert.equal(await vis(), "visible");

    const buf = await page.locator("#v").screenshot({ type: "jpeg", quality: 82, timeout: 2000, animations: "disabled" });
    assert.ok(buf.length > 0, "screenshot captured while revealed");

    await page.evaluate(restoreRevealForShot);
    assert.equal(await vis(), "hidden");
    const after = await page.evaluate(() => ({
      wrapInline: (document.getElementById("wrap") as HTMLElement).style.visibility,
      videoInline: (document.getElementById("v") as HTMLElement).style.visibility,
      markers: document.querySelectorAll("[data-clone-vis-restore]").length,
    }));
    assert.equal(after.wrapInline, "hidden", "original inline value restored");
    assert.equal(after.videoInline, "", "no inline visibility left on the video");
    assert.equal(after.markers, 0, "restore markers removed");
  });
});
