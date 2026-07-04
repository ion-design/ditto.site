import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { collectPage, type RawNode, type RawChild } from "../src/capture/walker.js";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import { generateCss } from "../src/generate/css.js";
import { buildTailwind } from "../src/generate/tailwind.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function isText(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

function findBy(root: RawNode, pred: (n: RawNode) => boolean): RawNode | null {
  if (pred(root)) return root;
  for (const c of root.children) {
    if (isText(c)) continue;
    const hit = findBy(c, pred);
    if (hit) return hit;
  }
  return null;
}

describe("walker ::placeholder capture", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  after(async () => {
    await browser.close();
  });

  it("captures the styled ::placeholder color/font of input and textarea", async () => {
    await page.setContent(readFileSync(join(FIXTURES, "placeholder.html"), "utf8"));
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    const snap = await page.evaluate(collectPage);

    const input = findBy(snap.root, (n) => n.tag === "input" && n.attrs.class === "styled")!;
    assert.ok(input.placeholder, "styled input carries a placeholder style");
    assert.equal(input.placeholder!.color, "rgb(120, 30, 200)");
    assert.equal(input.placeholder!.fontSize, "14px");

    const textarea = findBy(snap.root, (n) => n.tag === "textarea")!;
    assert.ok(textarea.placeholder, "styled textarea carries a placeholder style");
    assert.equal(textarea.placeholder!.color, "rgb(5, 100, 5)");
  });

  it("does not attach placeholder style to a control without placeholder text", async () => {
    await page.setContent(readFileSync(join(FIXTURES, "placeholder.html"), "utf8"));
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    const snap = await page.evaluate(collectPage);
    const plain = findBy(snap.root, (n) => n.tag === "input" && n.attrs.class === "plain")!;
    assert.equal(plain.placeholder, undefined);
  });
});

// ---- Generated CSS ----

const VPS = [375, 1280];
const CANONICAL = 1280;

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", ...over };
}

function node(id: string, tag: string, cs: StyleMap, children: IRChild[] = []): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { ...cs };
    bboxByVp[vp] = { x: 0, y: 0, width: 200, height: 40 };
    visibleByVp[vp] = true;
  }
  return { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/placeholder",
      title: "Placeholder Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: CANONICAL,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
      nodeCount: 2,
      keyframes: [],
    },
    root,
  };
}

describe("generateCss ::placeholder emission", () => {
  it("emits a ::placeholder rule with the captured color", () => {
    const input = node("n1", "input", computed({ color: "rgb(10, 20, 30)", fontSize: "16px" }));
    input.placeholderByVp = {
      375: { color: "rgb(120, 30, 200)", fontSize: "14px" },
      1280: { color: "rgb(120, 30, 200)", fontSize: "14px" },
    };
    const root = node("n0", "body", computed(), [input]);
    const css = generateCss(irWith(root), new Map());
    const m = css.match(/\.cn1::placeholder\{([^}]*)\}/);
    assert.ok(m, "a .cn1::placeholder rule is emitted");
    assert.ok(m![1]!.includes("color:rgb(120, 30, 200)"));
    // fontSize differs from the host's own 16px, so it must be emitted too.
    assert.ok(m![1]!.includes("font-size:14px"));
  });

  it("omits font props the placeholder inherits from the input itself", () => {
    const input = node("n1", "input", computed({ color: "rgb(10, 20, 30)", fontSize: "16px", fontFamily: "Arial" }));
    input.placeholderByVp = {
      375: { color: "rgb(200, 150, 100)", fontSize: "16px", fontFamily: "Arial" },
      1280: { color: "rgb(200, 150, 100)", fontSize: "16px", fontFamily: "Arial" },
    };
    const root = node("n0", "body", computed(), [input]);
    const css = generateCss(irWith(root), new Map());
    const m = css.match(/\.cn1::placeholder\{([^}]*)\}/);
    assert.ok(m);
    assert.ok(m![1]!.includes("color:rgb(200, 150, 100)"));
    assert.ok(!m![1]!.includes("font-size"), "inherited font-size is not re-declared");
    assert.ok(!m![1]!.includes("font-family"), "inherited font-family is not re-declared");
  });

  it("bands a placeholder color that changes across viewports", () => {
    const input = node("n1", "input", computed({ color: "rgb(10, 20, 30)" }));
    input.placeholderByVp = {
      375: { color: "rgb(1, 2, 3)" },
      1280: { color: "rgb(120, 30, 200)" },
    };
    const root = node("n0", "body", computed(), [input]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(/\.cn1::placeholder\{[^}]*rgb\(120, 30, 200\)/.test(css), "base carries the canonical color");
    assert.ok(/@media \(max-width: \d+px\)[\s\S]*\.cn1::placeholder\{[^}]*rgb\(1, 2, 3\)/.test(css), "mobile band overrides the color");
  });

  it("emits no ::placeholder rule for nodes without placeholder styles", () => {
    const input = node("n1", "input", computed({ color: "rgb(10, 20, 30)" }));
    const root = node("n0", "body", computed(), [input]);
    const css = generateCss(irWith(root), new Map());
    assert.ok(!css.includes("::placeholder"));
  });

  it("tailwind mode (the default pipeline) carries the rule in ditto.css keyed by data-cid", () => {
    const input = node("n1", "input", computed({ color: "rgb(10, 20, 30)" }));
    input.placeholderByVp = {
      375: { color: "rgb(120, 30, 200)" },
      1280: { color: "rgb(120, 30, 200)" },
    };
    const root = node("n0", "body", computed(), [input]);
    const tw = buildTailwind(irWith(root), new Map());
    assert.ok(/\[data-cid="n1"\]::placeholder\s*\{[^}]*color:\s*rgb\(120, 30, 200\)/.test(tw.pseudoCss),
      `pseudoCss carries the placeholder rule:\n${tw.pseudoCss}`);
  });
});
