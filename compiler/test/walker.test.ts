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
