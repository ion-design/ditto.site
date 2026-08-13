import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { tagElements } from "../src/capture/interactions.js";
import { captureVideoPlayers } from "../src/capture/video.js";
import { buildVideoSpec, withAutoplayParam } from "../src/generate/video.js";
import type { IR, IRNode, IRChild } from "../src/normalize/ir.js";
import type { InteractionCapture } from "../src/capture/interactions.js";

describe("captureVideoPlayers (poster + play mockup)", () => {
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

  it("recognizes an overlay + play-button + player-iframe mockup and captures the flip, then undoes it", async () => {
    // The remento macbook shape: a poster overlay (with a play button) covers an embed
    // iframe; clicking the button hides the overlay so the player shows inline.
    await setup(`
      <div class="frame" style="position:relative;width:780px;height:440px;">
        <div class="overlay" style="position:absolute;inset:0;background:#eee;">
          <div class="play-button" role="button" aria-label="Play video" style="width:100%;height:100%;cursor:pointer;"></div>
        </div>
        <iframe src="https://player.vimeo.com/video/12345?h=abc" style="width:780px;height:440px;"></iframe>
      </div>
      <script>
        document.querySelector(".play-button").addEventListener("click", () => {
          document.querySelector(".overlay").style.display = "none";
        });
      </script>`);
    const players = await captureVideoPlayers(page);
    assert.equal(players.length, 1, "the poster+play mockup is recognized");
    const p = players[0]!;
    assert.equal(p.media.kind, "iframe");
    assert.equal(p.media.embedUrl, "https://player.vimeo.com/video/12345?h=abc");
    assert.ok(p.overlays.length >= 1, "the hidden overlay set is captured");
    assert.equal(p.overlays[0]!.hide.display, "none");
    // drive-and-undo: the overlay is visible again after capture
    const overlayVisible = await page.evaluate(() => {
      const el = document.querySelector(".overlay") as HTMLElement;
      return getComputedStyle(el).display !== "none";
    });
    assert.ok(overlayVisible, "the click was undone — the page is back in its base state");
  });

  it("ignores an autoplaying background loop with no play affordance", async () => {
    await setup(`
      <div style="width:600px;height:400px;">
        <video autoplay loop muted poster="poster.jpg" style="width:600px;height:400px;"></video>
      </div>`);
    const players = await captureVideoPlayers(page);
    assert.equal(players.length, 0, "background art is not a click-to-play player");
  });

  it("rejects a candidate whose click reveals nothing (dead play button)", async () => {
    await setup(`
      <div class="frame" style="position:relative;width:600px;height:400px;">
        <div class="overlay" style="position:absolute;inset:0;background:#eee;">
          <div class="play-button" role="button" aria-label="Play" style="width:100%;height:100%;cursor:pointer;"></div>
        </div>
        <iframe src="https://player.vimeo.com/video/99" style="width:600px;height:400px;"></iframe>
      </div>`);
    const players = await captureVideoPlayers(page);
    assert.equal(players.length, 0, "no overlay flip -> stays static (no spurious controller)");
  });
});

// ---- pure helpers ----

describe("withAutoplayParam", () => {
  it("appends autoplay=1 with the right separator", () => {
    assert.equal(withAutoplayParam("https://x/v/1"), "https://x/v/1?autoplay=1");
    assert.equal(withAutoplayParam("https://x/v/1?h=abc"), "https://x/v/1?h=abc&autoplay=1");
  });
  it("does not double-append", () => {
    assert.equal(withAutoplayParam("https://x/v/1?autoplay=1"), "https://x/v/1?autoplay=1");
  });
});

function node(id: string, attrs: Record<string, string>, children: IRChild[] = []): IRNode {
  return { id, tag: "div", attrs, visibleByVp: {}, bboxByVp: {}, computedByVp: {}, children } as IRNode;
}
function irWith(root: IRNode): IR {
  return { doc: {} as IR["doc"], root } as IR;
}
const interactionWith = (over: Partial<InteractionCapture>): InteractionCapture =>
  ({ hover: {}, focus: {}, candidates: 0, patterns: [], ...over });

describe("buildVideoSpec", () => {
  const capture = (trigger: string, media: string, overlay: string): InteractionCapture => interactionWith({
    videos: [{
      frameCap: "1", triggerCap: trigger,
      overlays: [{ cap: overlay, hide: { display: "none", opacity: "0", visibility: "visible", pointerEvents: "none" } }],
      media: { cap: media, kind: "iframe", embedUrl: "https://player.vimeo.com/video/7" },
    }],
  });

  it("maps trigger/media/overlay caps to surviving cids", () => {
    const ir = irWith(node("n0", { "data-cid-cap": "1" }, [
      node("n1", { "data-cid-cap": "2" }), node("n2", { "data-cid-cap": "3" }), node("n3", { "data-cid-cap": "4" }),
    ]));
    const spec = buildVideoSpec(ir, capture("2", "3", "4"));
    assert.equal(spec.items.length, 1);
    assert.equal(spec.items[0]!.trigger, "n1");
    assert.equal(spec.items[0]!.media.target, "n2");
    assert.equal(spec.items[0]!.overlays[0]!.target, "n3");
  });

  it("drops the player when its media or trigger was pruned", () => {
    const ir = irWith(node("n0", { "data-cid-cap": "1" }, [node("n1", { "data-cid-cap": "2" })]));
    assert.equal(buildVideoSpec(ir, capture("2", "99", "2")).items.length, 0, "pruned media");
    assert.equal(buildVideoSpec(ir, capture("99", "2", "2")).items.length, 0, "pruned trigger");
  });
});
