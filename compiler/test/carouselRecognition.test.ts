import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { captureInteractions, tagElements } from "../src/capture/interactions.js";

// Regression coverage for Elementor/Swiper carousel recognition. Two real-world
// misses on a WordPress+Elementor site: (1) Swiper loop mode appends
// .swiper-slide-duplicate clones, so the index-aligned bullet check compared
// against the raw slide count and always failed; (2) Elementor's nested
// carousel renders arrows/bullets OUTSIDE the matched .swiper root (as
// siblings), so the root-scoped control query never found them.
describe("carousel recognition (Elementor/Swiper shapes)", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
  });

  const setup = async (html: string): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await tagElements(page);
    return page;
  };

  it("recognizes a loop carousel whose arrows/bullets sit outside the .swiper root", async () => {
    const page = await setup(`
      <style>
        .widget { position: relative; width: 300px; }
        .swiper { overflow: hidden; }
        .swiper-wrapper { display: flex; }
        .swiper-slide { width: 300px; height: 100px; flex: 0 0 auto; background: #ccc; }
        .swiper-pagination-bullet { width: 6px; height: 6px; display: inline-block; margin: 0 6px; background: #333; border-radius: 50%; cursor: pointer; }
      </style>
      <div class="widget">
        <div class="swiper">
          <div class="swiper-wrapper" id="swiper-wrapper-test">
            <div class="swiper-slide">A</div>
            <div class="swiper-slide">B</div>
            <div class="swiper-slide">C</div>
            <div class="swiper-slide swiper-slide-duplicate">A</div>
          </div>
        </div>
        <button id="prev" aria-controls="swiper-wrapper-test" aria-label="Previous slide">p</button>
        <button id="next" aria-controls="swiper-wrapper-test" aria-label="Next slide">n</button>
        <span class="swiper-pagination-bullet"></span>
        <span class="swiper-pagination-bullet"></span>
        <span class="swiper-pagination-bullet"></span>
      </div>
      <script>
        const track = document.getElementById("swiper-wrapper-test");
        let idx = 0;
        const apply = () => { track.style.transform = "matrix(1, 0, 0, 1, " + (-idx * 300) + ", 0)"; };
        document.getElementById("next").onclick = () => { idx = (idx + 1) % 3; apply(); };
        document.getElementById("prev").onclick = () => { idx = (idx + 2) % 3; apply(); };
        document.querySelectorAll(".swiper-pagination-bullet").forEach((b, i) => {
          b.onclick = () => { idx = i; apply(); };
        });
      </script>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const car = cap.patterns.find((p) => p.kind === "carousel");
    assert.ok(car, "carousel recognized despite external controls and loop clones");
    if (car?.kind === "carousel") {
      assert.ok(car.nextCap, "next control resolved via aria-controls wiring");
      assert.ok(car.prevCap, "prev control resolved via aria-controls wiring");
      assert.equal(car.bulletCaps.length, 3, "index-aligned bullets kept (loop clones excluded from the count)");
      assert.ok(car.transforms.length >= 2, "track transforms captured per index");
    }
    await page.close();
  });

  it("still recognizes a plain carousel with controls inside the root", async () => {
    const page = await setup(`
      <style>
        .swiper { overflow: hidden; position: relative; width: 300px; }
        .swiper-wrapper { display: flex; }
        .swiper-slide { width: 300px; height: 100px; flex: 0 0 auto; background: #ccc; }
      </style>
      <div class="swiper">
        <div class="swiper-wrapper" id="swiper-wrapper-inner">
          <div class="swiper-slide">A</div>
          <div class="swiper-slide">B</div>
        </div>
        <button class="swiper-button-prev" aria-label="Previous slide">p</button>
        <button class="swiper-button-next" aria-label="Next slide">n</button>
      </div>
      <script>
        const track = document.getElementById("swiper-wrapper-inner");
        let idx = 0;
        const apply = () => { track.style.transform = "matrix(1, 0, 0, 1, " + (-idx * 300) + ", 0)"; };
        document.querySelector(".swiper-button-next").onclick = () => { idx = (idx + 1) % 2; apply(); };
        document.querySelector(".swiper-button-prev").onclick = () => { idx = (idx + 1) % 2; apply(); };
      </script>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const car = cap.patterns.find((p) => p.kind === "carousel");
    assert.ok(car, "in-root controls keep working");
    if (car?.kind === "carousel") assert.ok(car.transforms.length >= 2, "track transforms captured per index");
    await page.close();
  });
});
