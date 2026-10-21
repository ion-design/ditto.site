import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { collectPage, type RawNode } from "../src/capture/walker.js";

function findById(node: RawNode, id: string): RawNode | undefined {
  if (node.attrs.id === id) return node;
  for (const child of node.children) {
    if ("text" in child) continue;
    const found = findById(child, id);
    if (found) return found;
  }
}

describe("walker sizing probe: positioned text", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  after(async () => { await browser.close(); });

  const capture = async (style: string, content = "Most popular") => {
    await page.setContent(`<style>
      body { font-family: Arial, sans-serif; padding: 80px; }
      .card { position: relative; width: 280px; height: 160px; padding: 28px; }
      #badge { position: absolute; top: -13px; left: 24px; font-size: 12px;
        font-weight: 700; padding: 4px 12px; margin: 0; ${style} }
    </style><div class="card"><p id="badge">${content}</p></div>`);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    const snap = await page.evaluate(collectPage);
    return findById(snap.root, "badge")!;
  };

  for (const position of ["absolute", "fixed"]) {
    for (const boxSizing of ["content-box", "border-box"]) {
      it(`recognizes a shrink-to-fit ${position} label with ${boxSizing}`, async () => {
        const badge = await capture(`position:${position}; box-sizing:${boxSizing};`);
        assert.equal(badge.sizing?.wAuto, true, "auto width reproduces the captured label");
        assert.equal(badge.sizing?.wFill, false, "the label does not fill its containing block");
        assert.ok(badge.sizing!.wMin! < badge.sizing!.wMax! - 2, "intrinsic widths record wrappable text");
        assert.ok(Math.abs(badge.sizing!.wMax! - badge.bbox.width) < 0.5);
        assert.equal(badge.sizing?.insetDrop?.left, false, "the authored left anchor is preserved");
        assert.equal(badge.sizing?.insetDrop?.right, true, "the resolved right inset remains droppable");
      });
    }
  }

  it("probes text inside an inline wrapper", async () => {
    const badge = await capture("", "<span>Most popular</span>");
    assert.equal(badge.sizing?.wAuto, true);
    assert.ok(badge.sizing!.wMax! > badge.sizing!.wMin!);
  });

  it("keeps an authored width even when it happens to match the intrinsic width", async () => {
    await capture("");
    await page.evaluate(() => {
      const badge = document.getElementById("badge")!;
      badge.style.setProperty("width", getComputedStyle(badge).width, "important");
    });
    const before = await page.locator("#badge").evaluate((el) => ({
      style: el.getAttribute("style"), box: el.getBoundingClientRect().toJSON(),
    }));
    const snap = await page.evaluate(collectPage);
    const badge = findById(snap.root, "badge")!;
    assert.equal(badge.sizing?.wAuto, false, "authored width is not treated as content sizing");
    assert.equal(badge.sizing?.wFill, false);
    assert.deepEqual(await page.locator("#badge").evaluate((el) => ({
      style: el.getAttribute("style"), box: el.getBoundingClientRect().toJSON(),
    })), before, "the probe restores inline values, priority and geometry");
  });

  it("leaves empty positioned boxes on the existing inset-only path", async () => {
    const badge = await capture("width:80px; height:20px;", "");
    assert.equal(badge.sizing?.wAuto, false);
    assert.equal(badge.sizing?.wMin, undefined);
    assert.ok(badge.sizing?.insetDrop);
  });
});
