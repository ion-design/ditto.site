import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { captureFullPageViaCDP } from "../src/capture/capture.js";

const ESBUILD_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

// A STATIC page (no scroll-linked animation) several viewports tall: a few full-width
// colored bands. Both capture paths should render the identical at-rest picture, so any
// difference is purely a capture-mechanism artifact (scrollbar gutter, off-by-one), which
// is exactly what this test measures.
const BANDS_HTML =
  "<!doctype html><html><head><style>" +
  "*{margin:0;padding:0;box-sizing:border-box}" +
  "html,body{width:100%}" +
  ".band{width:100%;height:600px;display:flex;align-items:center;justify-content:center;" +
  "font:bold 48px sans-serif;color:#fff}" +
  ".b0{background:#c0392b}.b1{background:#27ae60}.b2{background:#2980b9}" +
  ".b3{background:#8e44ad}.b4{background:#d35400}" +
  "</style></head><body>" +
  "<div class='band b0'>1</div><div class='band b1'>2</div>" +
  "<div class='band b2'>3</div><div class='band b3'>4</div>" +
  "<div class='band b4'>5</div>" +
  "</body></html>";

describe("CDP full-page capture vs Playwright fullPage stitch (static fixture)", () => {
  let browser: Browser;
  let page: Page;
  let tmp: string;

  before(async () => {
    browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    // A viewport SHORTER than the content so fullPage must span multiple bands: this is
    // where Playwright would scroll-stitch and CDP renders in one shot.
    const context = await browser.newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    await page.addInitScript(ESBUILD_SHIM);
    await page.setContent(BANDS_HTML, { waitUntil: "load" });
    tmp = mkdtempSync(join(tmpdir(), "cdp-shot-"));
  });

  after(async () => {
    await browser.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("produces a valid PNG of the full content height (not just the viewport)", async () => {
    const cdpPath = join(tmp, "cdp.png");
    await captureFullPageViaCDP(page, cdpPath);
    const cdp = PNG.sync.read(readFileSync(cdpPath));
    // 5 bands * 600px = 3000px tall, well beyond the 700px viewport.
    assert.ok(cdp.height >= 2900, `CDP shot spans full content (got ${cdp.height})`);
    assert.ok(cdp.width >= 780 && cdp.width <= 800, `CDP width ~= content width (got ${cdp.width})`);
    assert.ok(readFileSync(cdpPath).length > 1000, "CDP PNG is non-trivial in size");
  });

  it("is pixel-equivalent to Playwright's fullPage screenshot on a static page", async () => {
    const cdpPath = join(tmp, "cdp2.png");
    const pwPath = join(tmp, "pw.png");
    await captureFullPageViaCDP(page, cdpPath);
    await page.screenshot({ path: pwPath, fullPage: true, animations: "disabled" });

    const cdp = PNG.sync.read(readFileSync(cdpPath));
    const pw = PNG.sync.read(readFileSync(pwPath));

    // Dimensions must match (a scrollbar-gutter difference would show up here first).
    assert.equal(cdp.width, pw.width, `width match (cdp ${cdp.width} vs pw ${pw.width})`);
    assert.equal(cdp.height, pw.height, `height match (cdp ${cdp.height} vs pw ${pw.height})`);

    const { width, height } = cdp;
    const diff = new PNG({ width, height });
    const mismatched = pixelmatch(cdp.data, pw.data, diff.data, width, height, { threshold: 0.1 });
    const pct = (mismatched / (width * height)) * 100;
    // On a static page the two mechanisms should be near-identical. Allow a tiny tolerance
    // for antialiasing at band seams; assert well under 0.5% differing pixels.
    assert.ok(pct < 0.5, `pixel delta ${pct.toFixed(4)}% (${mismatched} px) must be < 0.5%`);
  });
});
