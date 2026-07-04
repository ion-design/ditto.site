import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { finalizeOverlaysInPage, clickDismissInPage } from "../src/capture/capture.js";
import { irContentExtent, type IRNode, type BBox, type StyleMap } from "../src/normalize/ir.js";
import { gatePollution } from "../src/validate/gates.js";
import type { CaptureResult } from "../src/capture/capture.js";
import type { IR } from "../src/normalize/ir.js";

// tsx/esbuild wraps serialized page functions with __name()/__defProp; shim so page.evaluate works.
const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

const VW = 1280, VH = 800;

// ---------------------------------------------------------------------------
// finalizeOverlaysInPage — effective-z resolution, overlay-unit grouping,
// lock-relaxed z gate, shadow-root traversal, loud-failure blocking.
// ---------------------------------------------------------------------------
describe("capture: finalizeOverlaysInPage overlay detection", () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  const newPage = async (html: string): Promise<Page> => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: VW, height: VH });
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(html);
    await page.evaluate(ESBUILD_SHIM);
    return page;
  };

  it("groups a 0-height max-z wrapper + its full-viewport z:auto iframe as ONE overlay and removes both (scroll-locked)", async () => {
    // Mirrors the Attentive structure: body scroll-locked; a fixed z=INT_MAX wrapper of height 0
    // whose child is a fixed full-viewport iframe with z-index:auto. Neither passes the naive
    // per-element area+z gate alone (wrapper: area 0; iframe: z parses to 0).
    const page = await newPage(`
      <style>
        html,body{margin:0}
        body{position:absolute;top:0;left:0;right:0;height:${VH}px;overflow:hidden}
        #wrap{position:fixed;top:${VH}px;left:0;width:${VW}px;height:0;z-index:2147483647}
        #creative{position:fixed;top:0;left:0;width:${VW}px;height:${VH}px;z-index:auto;background:#000}
      </style>
      <main>real page content</main>
      <div id="wrap"><iframe id="creative"></iframe></div>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 1, "the wrapper+iframe unit is removed as one node");
    assert.ok(res.removedLabels.some((l) => l.includes("wrap")), `removed the max-z wrapper (got ${JSON.stringify(res.removedLabels)})`);
    const gone = await page.evaluate(() => !document.getElementById("wrap") && !document.getElementById("creative"));
    assert.ok(gone, "both the wrapper and its inner iframe are gone");
    await page.close();
  });

  it("detects a z=50 full-viewport fixed dialog ONLY because the page is scroll-locked (lock relaxes the z>=100 gate)", async () => {
    const page = await newPage(`
      <style>
        html,body{margin:0}
        body{overflow:hidden}
        #ccpa{position:fixed;inset:0;width:${VW}px;height:${VH}px;z-index:50;background:rgba(0,0,0,.7)}
      </style>
      <main>content</main>
      <div id="ccpa">California Residents Privacy Rights</div>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 1, "the z=50 dialog is removed on a locked page");
    await page.close();
  });

  it("does NOT remove a z=50 full-viewport fixed layer when the page is NOT scroll-locked (z floor preserved)", async () => {
    const page = await newPage(`
      <style>
        html,body{margin:0}
        #hero{position:fixed;inset:0;width:${VW}px;height:${VH}px;z-index:50;background:#eee}
      </style>
      <div id="hero">a legit fixed hero, page scrolls normally</div>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 0, "no removal off a locked page — the z>=100 floor guards legit fixed content");
    assert.equal(res.blocking, false);
    await page.close();
  });

  it("removes a promo popup mounted inside an OPEN shadow root and reports the host label", async () => {
    const page = await newPage(`
      <style>html,body{margin:0}body{overflow:hidden}</style>
      <main>content</main>
      <div id="recart-popup-root"></div>
      <script>
        const host = document.getElementById("recart-popup-root");
        const root = host.attachShadow({ mode: "open" });
        const layer = document.createElement("div");
        layer.style.cssText = "position:fixed;inset:0;width:${VW}px;height:${VH}px;z-index:999;background:rgba(0,0,0,.6)";
        layer.textContent = "Enjoy 15% off";
        root.appendChild(layer);
      </script>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 1, "the shadow-hosting popup element is removed as one unit");
    const gone = await page.evaluate(() => !document.getElementById("recart-popup-root"));
    assert.ok(gone, "the shadow host is gone from the light DOM");
    await page.close();
  });

  it("reports blocking=true when the scroll-lock persists even with NO overlay detected (loud failure)", async () => {
    // Body is scroll-locked but there is no fixed full-viewport layer to find (e.g. a closed
    // shadow root we cannot pierce). A silently-locked capture is polluted → surface it.
    const page = await newPage(`
      <style>html,body{margin:0}body{overflow:hidden;position:absolute;height:${VH}px}</style>
      <main>content</main>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 0);
    assert.equal(res.blocking, true, "a persistent lock with nothing removable still reports blocking");
    await page.close();
  });

  it("reports blocking=false and removes nothing on an ordinary unlocked page", async () => {
    const page = await newPage(`
      <style>html,body{margin:0}</style>
      <header>nav</header><main>lots of content</main><footer>footer</footer>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    assert.equal(res.removed, 0);
    assert.equal(res.blocking, false);
    assert.equal(res.overlaysRemaining, 0);
    await page.close();
  });

  it("protects real sticky page chrome (header/nav) from removal even when detected", async () => {
    // A scroll-locked page with a sticky header that happens to be tall — the header is PROTECTED,
    // and it isn't full-viewport, so it never even qualifies. Assert nothing is stripped.
    const page = await newPage(`
      <style>
        html,body{margin:0}body{overflow:hidden}
        #masthead{position:sticky;top:0;width:${VW}px;height:80px;z-index:1000;background:#fff}
      </style>
      <header id="masthead">site chrome</header>
      <main>content</main>
    `);
    const res = await page.evaluate(finalizeOverlaysInPage);
    const present = await page.evaluate(() => !!document.getElementById("masthead"));
    assert.ok(present, "the header survives");
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// clickDismissInPage — decline/close matchers, shadow-root traversal.
// ---------------------------------------------------------------------------
describe("capture: clickDismissInPage matchers", () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  const run = async (html: string): Promise<string[]> => {
    const page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(html);
    await page.evaluate(ESBUILD_SHIM);
    const res = await page.evaluate(clickDismissInPage);
    await page.close();
    return res;
  };

  it("clicks a Decline button inside an overlay container (email-capture opt-out)", async () => {
    const dismissed = await run(`
      <div class="signup-overlay" style="position:fixed;inset:0;width:400px;height:400px">
        <button onclick="window.__declined=true">Decline</button>
      </div>
    `);
    assert.ok(dismissed.includes("text:decline"), `clicked Decline (got ${JSON.stringify(dismissed)})`);
  });

  it("clicks an aria-label close (×) inside an overlay container when no accept/decline text matches", async () => {
    const dismissed = await run(`
      <div id="promo-popup" style="position:fixed;inset:0;width:400px;height:400px">
        <button aria-label="Close dialog">×</button>
      </div>
    `);
    assert.ok(dismissed.some((d) => d.startsWith("close:")), `clicked the aria close (got ${JSON.stringify(dismissed)})`);
  });

  it("matches an overlay/ccpa/privacy container id/class (extended container selector)", async () => {
    const dismissed = await run(`
      <div id="ccpaPop" style="position:fixed;inset:0;width:400px;height:400px">
        <button>Accept</button>
      </div>
    `);
    assert.ok(dismissed.includes("text:accept"), `matched the ccpa container (got ${JSON.stringify(dismissed)})`);
  });

  it("traverses an open shadow root to find the close control", async () => {
    const page = await browser.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(`<div id="host"></div>`);
    await page.evaluate(ESBUILD_SHIM);
    await page.evaluate(() => {
      const host = document.getElementById("host")!;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<div class="popup-modal" style="position:fixed;inset:0;width:400px;height:400px"><button aria-label="close">×</button></div>`;
    });
    const dismissed = await page.evaluate(clickDismissInPage);
    await page.close();
    assert.ok(dismissed.some((d) => d.startsWith("close:")), `found the shadow-root close (got ${JSON.stringify(dismissed)})`);
  });

  it("never clicks an ordinary page button outside any overlay container", async () => {
    const dismissed = await run(`<main><button>Accept</button><a>Continue</a></main>`);
    assert.deepEqual(dismissed, [], "no overlay container ⇒ no clicks");
  });
});

// ---------------------------------------------------------------------------
// irContentExtent — pure geometry (unclamp / pollution trigger).
// ---------------------------------------------------------------------------
describe("normalize: irContentExtent", () => {
  const bbox = (x: number, y: number, w: number, h: number): BBox => ({ x, y, width: w, height: h });
  const style = (over: Partial<StyleMap> = {}): StyleMap => ({ position: "static", ...over } as StyleMap);
  const node = (over: Partial<IRNode>): IRNode => ({
    id: "n", tag: "div", attrs: {},
    visibleByVp: { 1280: true }, bboxByVp: { 1280: bbox(0, 0, 100, 100) },
    computedByVp: { 1280: style() }, children: [], ...over,
  });

  it("returns the max in-flow descendant border-box bottom", () => {
    const root = node({
      tag: "body",
      children: [
        node({ bboxByVp: { 1280: bbox(0, 0, 1280, 800) } }),
        node({ bboxByVp: { 1280: bbox(0, 800, 1280, 4398) } }), // footer bottom = 5198
      ],
    });
    assert.equal(irContentExtent(root, 1280), 5198);
  });

  it("excludes out-of-flow (fixed/absolute) and floated boxes", () => {
    const root = node({
      tag: "body",
      children: [
        node({ bboxByVp: { 1280: bbox(0, 0, 1280, 900) } }),
        node({ computedByVp: { 1280: style({ position: "fixed" }) }, bboxByVp: { 1280: bbox(0, 0, 1280, 9999) } }),
        node({ computedByVp: { 1280: style({ float: "left" } as Partial<StyleMap>) }, bboxByVp: { 1280: bbox(0, 0, 1280, 8888) } }),
      ],
    });
    assert.equal(irContentExtent(root, 1280), 900, "fixed + float extents ignored");
  });

  it("descends into nested in-flow subtrees", () => {
    const root = node({
      tag: "body",
      children: [node({ children: [node({ bboxByVp: { 1280: bbox(0, 0, 500, 3000) } })] })],
    });
    assert.equal(irContentExtent(root, 1280), 3000);
  });

  it("ignores nodes invisible at the queried viewport", () => {
    const root = node({
      tag: "body",
      children: [node({ visibleByVp: { 1280: false }, bboxByVp: { 1280: bbox(0, 0, 100, 5000) } })],
    });
    assert.equal(irContentExtent(root, 1280), 0);
  });
});

// ---------------------------------------------------------------------------
// gatePollution — scroll-locked-capture contradiction.
// ---------------------------------------------------------------------------
describe("validate: pollution gate scroll-locked contradiction", () => {
  const bbox = (x: number, y: number, w: number, h: number): BBox => ({ x, y, width: w, height: h });
  const st = (over: Partial<StyleMap> = {}): StyleMap => ({ position: "static", ...over } as StyleMap);
  // A body with plenty of text and a footer at y=5198 (content extent ~6.4 viewports @800).
  const mkIr = (): IR => ({
    doc: {
      sourceUrl: "https://x.test", title: "t", lang: "en", charset: "UTF-8", metaViewport: "",
      viewports: [1280], sampleViewports: [1280], canonicalViewport: 1280,
      perViewport: { 1280: { scrollHeight: 800, scrollWidth: 1280, htmlBg: "", bodyBg: "", bodyColor: "", bodyFont: "" } },
      nodeCount: 200, keyframes: [],
    },
    root: {
      id: "n0", tag: "body", attrs: {}, visibleByVp: { 1280: true },
      bboxByVp: { 1280: bbox(0, 0, 1280, 800) }, computedByVp: { 1280: st() },
      children: [
        { id: "n1", tag: "section", attrs: {}, visibleByVp: { 1280: true }, bboxByVp: { 1280: bbox(0, 0, 1280, 800) }, computedByVp: { 1280: st() },
          children: [{ text: "hero copy ".repeat(20) }] },
        { id: "n2", tag: "footer", attrs: {}, visibleByVp: { 1280: true }, bboxByVp: { 1280: bbox(0, 4074, 1280, 1124) }, computedByVp: { 1280: st() },
          children: [{ text: "footer copy ".repeat(20) }] },
      ],
    },
  });
  const mkCapture = (scrollHeight: number): CaptureResult => ({
    perViewport: [
      { viewport: 375, height: 812, scrollHeight: 812, nodeCount: 200, truncated: false },
      { viewport: 1280, height: 800, scrollHeight, nodeCount: 200, truncated: false },
    ],
    dismissal: { dismissed: [], overlaysRemaining: 0, removed: 0, videoStills: 0, blocking: false },
  } as unknown as CaptureResult);

  it("FAILS when scrollHeight is pinned to ~1 viewport at every width but IR content spans multiple viewports", () => {
    const res = gatePollution(mkIr(), mkCapture(800), [1280]);
    assert.equal(res.pass, false, "the scroll-locked contradiction is caught");
    assert.ok(res.issues.some((i) => i.includes("scroll-locked capture")), `issue reported (got ${JSON.stringify(res.issues)})`);
  });

  it("PASSES when scrollHeight matches the tall content (a genuinely scrollable page)", () => {
    const res = gatePollution(mkIr(), mkCapture(5198), [1280]);
    assert.ok(!res.issues.some((i) => i.includes("scroll-locked capture")), "no false positive when the page really scrolled");
  });
});
