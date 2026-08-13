import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { tagElements } from "../src/capture/interactions.js";
import { captureJsHovers } from "../src/capture/hoverJs.js";
import { buildHoverSpec } from "../src/generate/hover.js";
import type { IR, IRNode, IRChild } from "../src/normalize/ir.js";
import type { InteractionCapture } from "../src/capture/interactions.js";

describe("captureJsHovers (script-driven hover)", () => {
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

  it("captures a mouseover-driven inline-style hover whose target is a SIBLING of the trigger", async () => {
    // The remento shape: Webflow IX2 listens for mouseover on a role=button trigger and
    // tweens a SIBLING play circle's inline transform. Invisible to CSS.forcePseudoState
    // (no CSS rule) and to any trigger-subtree diff (the target is outside the subtree).
    await setup(`
      <div class="wrap">
        <div class="btn" role="button" aria-label="Play video" style="width:200px;height:120px;"></div>
        <div class="circle" style="width:60px;height:60px;transform:scale(1);"></div>
      </div>
      <script>
        const btn = document.querySelector(".btn");
        const circle = document.querySelector(".circle");
        btn.addEventListener("mouseover", () => { circle.style.transform = "scale(1.1)"; });
        btn.addEventListener("mouseout", () => { circle.style.transform = "scale(1)"; });
      </script>`);
    const hovers = await captureJsHovers(page);
    const hit = hovers.find((h) => h.targets.some((t) => /1\.1/.test(t.on.transform ?? "")));
    assert.ok(hit, "the sibling-target hover is captured");
    const target = hit!.targets.find((t) => /1\.1/.test(t.on.transform ?? ""))!;
    assert.match(target.on.transform!, /matrix\(1\.1, 0, 0, 1\.1, 0, 0\)|scale\(1\.1\)/);
    assert.match(target.off.transform!, /matrix\(1, 0, 0, 1, 0, 0\)|scale\(1\)|none/);
    // the page is left in its resting state
    const resting = await page.evaluate(() => getComputedStyle(document.querySelector(".circle")!).transform);
    assert.match(resting, /matrix\(1, 0, 0, 1, 0, 0\)|none/);
  });

  it("captures a pointerenter-driven WAAPI hover (whileHover) via getAnimations", async () => {
    await setup(`
      <div class="card" style="width:200px;height:120px;cursor:pointer;"></div>
      <script>
        const card = document.querySelector(".card");
        let anim = null;
        card.addEventListener("pointerenter", () => {
          anim = card.animate([{ transform: "scale(1)" }, { transform: "scale(1.05)" }], { duration: 120, fill: "forwards", easing: "ease-out" });
        });
        card.addEventListener("pointerleave", () => {
          if (anim) anim.cancel();
        });
      </script>`);
    const hovers = await captureJsHovers(page);
    const hit = hovers.find((h) => h.targets.some((t) => /1\.05/.test(t.on.transform ?? "")));
    assert.ok(hit, "the WAAPI whileHover scale is captured");
    const target = hit!.targets.find((t) => /1\.05/.test(t.on.transform ?? ""))!;
    assert.equal(target.durationMs, 120, "the WAAPI timing definition (not a measurement) is recorded");
    assert.equal(target.easing, "ease-out");
  });

  it("records nothing for hover-inert elements (no spurious controllers)", async () => {
    await setup(`
      <a href="#" style="display:block;width:200px;height:40px;">Plain link</a>
      <div style="width:200px;height:40px;cursor:pointer;">Pointer div, no JS</div>`);
    const hovers = await captureJsHovers(page);
    assert.equal(hovers.length, 0, "no scripted hover -> empty capture");
  });

  it("drops targets that never settle (looping animation is not a two-state hover)", async () => {
    await setup(`
      <div class="spin" role="button" style="width:100px;height:100px;"></div>
      <script>
        const el = document.querySelector(".spin");
        el.addEventListener("mouseover", () => {
          el.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 300, iterations: Infinity });
        });
      </script>`);
    const hovers = await captureJsHovers(page);
    assert.equal(hovers.length, 0, "an endless loop is dropped rather than sampled mid-frame");
  });
});

// ---- buildHoverSpec (pure) ----

function node(id: string, attrs: Record<string, string>, children: IRChild[] = []): IRNode {
  return { id, tag: "div", attrs, visibleByVp: {}, bboxByVp: {}, computedByVp: {}, children } as IRNode;
}
function irWith(root: IRNode): IR {
  return { doc: {} as IR["doc"], root } as IR;
}
const interactionWith = (over: Partial<InteractionCapture>): InteractionCapture =>
  ({ hover: {}, focus: {}, candidates: 0, patterns: [], ...over });

describe("buildHoverSpec", () => {
  it("maps trigger and target caps to surviving cids", () => {
    const ir = irWith(node("n0", {}, [node("n1", { "data-cid-cap": "10" }, [node("n2", { "data-cid-cap": "11" })])]));
    const spec = buildHoverSpec(ir, interactionWith({
      hoverJs: [{ triggerCap: "10", targets: [{ cap: "11", on: { transform: "scale(1.1)" }, off: { transform: "none" }, durationMs: 250, easing: "ease" }] }],
    }));
    assert.equal(spec.items.length, 1);
    assert.equal(spec.items[0]!.trigger, "n1");
    assert.equal(spec.items[0]!.targets[0]!.target, "n2");
    assert.equal(spec.items[0]!.targets[0]!.durationMs, 250);
  });

  it("drops a trigger whose element was pruned, and prunes missing targets", () => {
    const ir = irWith(node("n0", {}, [node("n1", { "data-cid-cap": "10" })]));
    const spec = buildHoverSpec(ir, interactionWith({
      hoverJs: [
        { triggerCap: "99", targets: [{ cap: "10", on: { opacity: "0" }, off: { opacity: "1" }, durationMs: null, easing: null }] },
        { triggerCap: "10", targets: [{ cap: "98", on: { opacity: "0" }, off: { opacity: "1" }, durationMs: null, easing: null }] },
      ],
    }));
    assert.equal(spec.items.length, 0, "pruned trigger and target-less trigger are both dropped");
  });

  it("is empty when the capture has no hoverJs", () => {
    const ir = irWith(node("n0", {}, []));
    assert.equal(buildHoverSpec(ir, interactionWith({})).items.length, 0);
    assert.equal(buildHoverSpec(ir, undefined).items.length, 0);
  });
});
