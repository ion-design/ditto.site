import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { captureCanvasStillsInPage } from "../src/capture/capture.js";
import type { IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import { propsList, resolveTag, renderChildrenJsx } from "../src/generate/app.js";

// tsx/esbuild wraps functions with a __name() helper for stack traces; the serialized
// page functions carry those calls, so shim it (same as capture.ts's init script).
const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

describe("capture: canvas raster fallback (in-page)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(`
      <canvas id="big" width="200" height="100"></canvas>
      <canvas id="tiny" width="20" height="20"></canvas>
      <canvas id="ghost" width="300" height="150" style="visibility:hidden"></canvas>
      <script>
        const ctx = document.getElementById("big").getContext("2d");
        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(10, 10, 180, 80);
      </script>
    `);
    // setContent replaces the document without a navigation, so the init script may
    // not have applied — evaluate the shim directly (same as capture.ts's frame path).
    await page.evaluate(ESBUILD_SHIM);
  });
  after(async () => {
    await browser.close();
  });

  it("rasterizes a meaningful 2D canvas to a PNG data URL under a synthetic clone-canvas URL", async () => {
    const plan = await page.evaluate(captureCanvasStillsInPage);
    assert.equal(plan.stills.length, 1, "exactly one canvas qualifies");
    assert.equal(plan.shots.length, 0, "readable 2D canvas needs no element-screenshot fallback");
    const still = plan.stills[0]!;
    assert.ok(still.dataUrl.startsWith("data:image/png"), `PNG data URL (got ${still.dataUrl.slice(0, 30)})`);
    assert.match(still.url, /^https:\/\/clone-canvas\.local\/0-[0-9a-z]+\.png$/);
    assert.equal(still.sel, 'canvas[data-clone-canvas="0"]');
    const bytes = Buffer.from(still.dataUrl.slice(still.dataUrl.indexOf(",") + 1), "base64");
    assert.ok(bytes.length > 0, "still decodes to non-empty bytes");

    const stamped = await page.evaluate(() => ({
      big: document.getElementById("big")?.getAttribute("data-clone-canvas") ?? null,
      tiny: document.getElementById("tiny")?.getAttribute("data-clone-canvas") ?? null,
      ghost: document.getElementById("ghost")?.getAttribute("data-clone-canvas") ?? null,
    }));
    assert.equal(stamped.big, "0", "qualifying canvas gets the stable marker");
    assert.equal(stamped.tiny, null, "a 20x20 canvas is below the meaningful-size gate");
    assert.equal(stamped.ghost, null, "a hidden canvas is skipped");
  });
});

const VPS = [375, 1280];
const SOURCE = "https://example.test/page";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function el(id: string, tag: string, attrs: Record<string, string> = {}, children: IRChild[] = [], visible = true): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { display: "block", position: "static", visibility: "visible" };
    bboxByVp[vp] = { x: 0, y: 0, width: visible ? 640 : 0, height: visible ? 360 : 0 };
    visibleByVp[vp] = visible;
  }
  return { id, tag, attrs, visibleByVp, bboxByVp, computedByVp, children };
}

describe("generate: canvas-still emission", () => {
  const STILL_URL = "https://clone-canvas.local/0-abc.png";
  const LOCAL = "/assets/cloned/images/ab.png";
  const assetMap = new Map([[STILL_URL, LOCAL]]);
  const canvas = () => el("7", "canvas", { src: STILL_URL, width: "200", height: "100" });

  it("retags a canvas carrying a captured still to <img>; a bare canvas stays canvas", () => {
    assert.equal(resolveTag(canvas(), false), "img");
    assert.equal(resolveTag(el("8", "canvas", { width: "200", height: "100" }), false), "canvas");
  });

  it("resolves the synthetic still URL through the asset map and emits data-cid + alt", () => {
    const p = new Map(propsList(canvas(), assetMap, SOURCE));
    assert.equal(p.get("src"), JSON.stringify(LOCAL));
    assert.equal(p.get('"data-cid"'), JSON.stringify("7"));
    assert.equal(p.get("alt"), JSON.stringify(""), "decorative alt is injected for the raster still");
    assert.equal(p.get("width"), JSON.stringify("200"));
    assert.equal(p.get("height"), JSON.stringify("100"));
  });

  it("renders a self-closing <img> in place of the canvas", () => {
    const jsx = renderChildrenJsx([canvas()], assetMap, SOURCE, 0);
    assert.match(jsx, /<img[^>]*data-cid="7"[^>]*\/>/);
    assert.match(jsx, new RegExp(`src="${LOCAL.replace(/[/]/g, "\\/")}"`));
    assert.ok(!jsx.includes("<canvas"), "no canvas element remains");
  });

  it("falls back to the transparent GIF when the still missed the asset map (never a remote URL)", () => {
    const p = new Map(propsList(canvas(), new Map(), SOURCE));
    assert.equal(p.get("src"), JSON.stringify(GIF));
  });
});
