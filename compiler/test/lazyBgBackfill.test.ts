import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, StyleMap, BBox } from "../src/normalize/ir.js";
import { backfillLazyBackgrounds } from "../src/normalize/ir.js";

const VPS = [375, 768, 1280, 1920];
const URL_BG = 'url("https://example.test/photo.avif")';

function node(id: string, byVp: Record<number, StyleMap>): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { display: "block", position: "static", ...byVp[vp] };
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = true;
  }
  return { id, tag: "div", attrs: {}, visibleByVp, bboxByVp, computedByVp, children: [] };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/",
      title: "Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: 1280,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
      nodeCount: 2,
      keyframes: [],
    },
    root,
  };
}

// The lazy-background rescue must not misread a RESPONSIVE swap as a lazy-load miss.
// Discriminator: background-size/position/repeat come from CSS at each width regardless of
// whether a lazy loader has injected the image yet — so a viewport whose bg is `none` AND whose
// companions are the pure defaults, while every url viewport authors a companion, is a width the
// source paints NO image at (remento's gift-certificate card: url + 210px/100% 89%/no-repeat at
// mobile, none/auto/0% 0%/repeat at desktop — backfilling painted the raw photo tiled from the
// corner over the desktop card). Ambiguous cases keep the rescue.
describe("backfillLazyBackgrounds responsive-swap guard", () => {
  it("does not backfill a viewport whose companions are defaults when every donor authors them", () => {
    const card = node("n1", {
      375: { backgroundImage: URL_BG, backgroundSize: "210px", backgroundPosition: "100% 89%", backgroundRepeat: "no-repeat" },
      768: { backgroundImage: URL_BG, backgroundSize: "310px", backgroundPosition: "100% 50%", backgroundRepeat: "no-repeat" },
      1280: { backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" },
      1920: { backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" },
    });
    backfillLazyBackgrounds(irWith(card));
    assert.equal(card.computedByVp[1280]!.backgroundImage, "none", "desktop swap viewport stays none");
    assert.equal(card.computedByVp[1920]!.backgroundImage, "none", "wide swap viewport stays none");
    assert.equal(card.computedByVp[375]!.backgroundImage, URL_BG, "donor viewports untouched");
  });

  it("still backfills a genuine lazy miss (the gap viewport authors its own companions)", () => {
    const hero = node("n1", {
      375: { backgroundImage: URL_BG, backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat" },
      768: { backgroundImage: URL_BG, backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat" },
      1280: { backgroundImage: "none", backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat" },
      1920: { backgroundImage: URL_BG, backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat" },
    });
    backfillLazyBackgrounds(irWith(hero));
    assert.equal(hero.computedByVp[1280]!.backgroundImage, URL_BG, "authored-companion gap is a lazy miss → filled");
  });

  it("keeps the rescue when donors author nothing (ambiguous → old behavior)", () => {
    const banner = node("n1", {
      375: { backgroundImage: URL_BG },
      768: { backgroundImage: URL_BG },
      1280: { backgroundImage: "none" },
      1920: { backgroundImage: "none" },
    });
    backfillLazyBackgrounds(irWith(banner));
    assert.equal(banner.computedByVp[1280]!.backgroundImage, URL_BG, "no companion signal → keep the lazy rescue");
  });

  it("spreads a synthetic iframe still (clone-frame.local), companions included", () => {
    // The frame-still fallback (capture.ts) injects the still + `100% 100%`/`no-repeat` at the
    // CANONICAL viewport only — it is the compiler's own artifact, never a responsive swap, and
    // its sizing must travel with it or the spread still tiles at background-size:auto.
    const STILL = 'url("https://clone-frame.local/3-abc123def456.jpg")';
    const frame = node("n1", {
      375: { backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" },
      768: { backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" },
      1280: { backgroundImage: STILL, backgroundSize: "100% 100%", backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat" },
      1920: { backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" },
    });
    backfillLazyBackgrounds(irWith(frame));
    for (const vp of [375, 768, 1920]) {
      assert.equal(frame.computedByVp[vp]!.backgroundImage, STILL, `still spread to ${vp}`);
      assert.equal(frame.computedByVp[vp]!.backgroundSize, "100% 100%", `still sizing spread to ${vp}`);
      assert.equal(frame.computedByVp[vp]!.backgroundRepeat, "no-repeat", `still repeat spread to ${vp}`);
    }
  });
});
