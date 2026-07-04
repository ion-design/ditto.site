import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { captureInteractions, tagElements, diffStyle } from "../src/capture/interactions.js";

describe("diffStyle", () => {
  it("returns only the changed keys, with the b-side value", () => {
    const a = { color: "rgb(0, 0, 0)", opacity: "1", transform: "none" };
    const b = { color: "rgb(255, 0, 0)", opacity: "1", transform: "scale(1.1)" };
    assert.deepEqual(diffStyle(a, b), { color: "rgb(255, 0, 0)", transform: "scale(1.1)" });
  });
  it("is empty when nothing changed", () => {
    const a = { color: "rgb(0, 0, 0)", opacity: "1" };
    assert.deepEqual(diffStyle(a, { ...a }), {});
  });
  it("only reports keys present in b (b drives the comparison)", () => {
    // a resting style that carries an extra key does not fabricate a delta.
    assert.deepEqual(diffStyle({ color: "red", extra: "x" }, { color: "red" }), {});
  });
});

describe("captureInteractions hover capture (occlusion-immune)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => {
    await browser.close();
  });

  const setup = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await tagElements(page);
  };

  it("captures an authored :hover state even when a transparent full-viewport overlay covers the target", async () => {
    // Exact regression for the empty-hover-capture bug: a modern builder stack parks a
    // transparent fixed layer over the whole page. page.hover moves the real cursor to the
    // link's centre, the point lands on the overlay, and `:hover` never reaches the link — so
    // pointer-based probing captured ZERO hover states. Forcing the pseudo-class fixes it.
    await setup(`
      <style>
        a.cta { color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); }
        a.cta:hover { color: rgb(255, 0, 0); background-color: rgb(0, 0, 255); }
        .overlay { position: fixed; inset: 0; z-index: 9999; background: transparent; }
      </style>
      <a class="cta" href="#">Shop now</a>
      <div class="overlay"></div>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const hoverCaps = Object.keys(cap.hover);
    assert.ok(hoverCaps.length >= 1, "at least one hover state is captured through the overlay");
    const delta = cap.hover[hoverCaps[0]!]!;
    assert.equal(delta.color, "rgb(255, 0, 0)", "hover color change is captured");
    assert.equal(delta.backgroundColor, "rgb(0, 0, 255)", "hover background change is captured");
  });

  it("captures :hover on a cursor:pointer element that is not a native interactive", async () => {
    await setup(`
      <style>
        .card { cursor: pointer; border: 2px solid rgb(1, 1, 1); }
        .card:hover { border-color: rgb(9, 9, 9); }
      </style>
      <div class="card" style="width:200px;height:120px;">Card</div>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    const found = Object.values(cap.hover).some((d) => d.borderTopColor === "rgb(9, 9, 9)");
    assert.ok(found, "a cursor:pointer card's authored :hover border change is captured");
  });

  it("records no hover delta for an element with no authored :hover (self-limiting)", async () => {
    await setup(`
      <a class="plain" href="#" style="color:rgb(0,0,0);">No hover</a>`);
    const cap = await captureInteractions(page, { maxCandidates: 50 });
    assert.equal(Object.keys(cap.hover).length, 0, "no authored hover -> empty hover map");
  });

  it("restores the resting state after probing (forced pseudo-state cleared)", async () => {
    await setup(`
      <style>
        a.cta { color: rgb(0, 0, 0); }
        a.cta:hover { color: rgb(255, 0, 0); }
      </style>
      <a class="cta" href="#">Link</a>`);
    await captureInteractions(page, { maxCandidates: 50 });
    const resting = await page.evaluate(() => getComputedStyle(document.querySelector("a.cta")!).color);
    assert.equal(resting, "rgb(0, 0, 0)", "the page is left in its resting (non-hover) state");
  });
});
