import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import { propsList, renderChildrenJsx } from "../src/generate/app.js";

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

function props(node: IRNode, assetMap: Map<string, string>): Map<string, string> {
  return new Map(propsList(node, assetMap, SOURCE));
}

describe("video src emission", () => {
  it("ships the local file and mirrors captured playback attrs when the src materialized", () => {
    const assetMap = new Map([
      ["https://example.test/media/hero.mp4", "/assets/cloned/videos/ab.mp4"],
      ["https://example.test/img/poster.jpg", "/assets/cloned/images/cd.jpg"],
    ]);
    const video = el("n1", "video", {
      src: "/media/hero.mp4", poster: "/img/poster.jpg",
      autoplay: "", loop: "", muted: "", playsinline: "",
    });
    const p = props(video, assetMap);
    assert.equal(p.get("src"), JSON.stringify("/assets/cloned/videos/ab.mp4"));
    assert.equal(p.get("poster"), JSON.stringify("/assets/cloned/images/cd.jpg"));
    assert.equal(p.get("autoPlay"), "true");
    assert.equal(p.get("loop"), "true");
    assert.equal(p.get("muted"), "true");
    assert.equal(p.get("playsInline"), "true");
    // preload is mirrored, not forced: none captured → none emitted.
    assert.equal(p.get("preload"), undefined);
  });

  it("falls back to poster-only when no video file materialized", () => {
    const assetMap = new Map([
      ["https://example.test/img/poster.jpg", "/assets/cloned/images/cd.jpg"],
    ]);
    const video = el("n1", "video", { src: "/media/hero.mp4", poster: "/img/poster.jpg", autoplay: "", loop: "" });
    const p = props(video, assetMap);
    assert.equal(p.get("src"), undefined);
    assert.equal(p.get("autoPlay"), undefined);
    assert.equal(p.get("loop"), undefined);
    assert.equal(p.get("poster"), JSON.stringify("/assets/cloned/images/cd.jpg"));
    assert.equal(p.get("preload"), JSON.stringify("none"));
  });

  it("treats a materialized child <source> as a shippable video (src carried by the child)", () => {
    const assetMap = new Map([["https://example.test/media/hero.webm", "/assets/cloned/videos/ef.webm"]]);
    const source = el("n2", "source", { src: "/media/hero.webm", type: "video/webm" }, [], false);
    const video = el("n1", "video", { autoplay: "", muted: "" }, [source]);
    const p = props(video, assetMap);
    assert.equal(p.get("autoPlay"), "true");
    assert.equal(p.get("preload"), undefined);
    const jsx = renderChildrenJsx([video], assetMap, SOURCE, 0);
    assert.match(jsx, /<source[^>]*src="\/assets\/cloned\/videos\/ef\.webm"[^>]*\/>/);
    assert.match(jsx, /type="video\/webm"/);
  });

  it("drops non-materialized <source> children (poster-only video keeps none)", () => {
    const source = el("n2", "source", { src: "/media/hero.webm", type: "video/webm" }, [], false);
    const video = el("n1", "video", { autoplay: "" }, [source]);
    const jsx = renderChildrenJsx([video], new Map(), SOURCE, 0);
    assert.ok(!jsx.includes("<source"));
    assert.ok(!jsx.includes("autoPlay"));
  });
});

describe("poster fallback policy", () => {
  it("DROPS a poster that missed the asset map instead of substituting the transparent GIF", () => {
    const video = el("n1", "video", { poster: "https://clone-still.local/0-abc.jpg" });
    const p = props(video, new Map());
    assert.equal(p.get("poster"), undefined);
    assert.ok(![...p.values()].includes(JSON.stringify(GIF)));
  });

  it("keeps the transparent-GIF fallback for a missed <img> src", () => {
    const img = el("n1", "img", { src: "/img/gone.png", alt: "" });
    const p = props(img, new Map());
    assert.equal(p.get("src"), JSON.stringify(GIF));
  });
});

describe("picture>source rewriting", () => {
  const mkPicture = () => {
    const desktop = el("n2", "source", {
      srcset: "/img/hero-1280.jpg 1x, /img/hero-2560.jpg 2x",
      media: "(min-width: 768px)", type: "image/jpeg", sizes: "100vw",
    }, [], false);
    const gone = el("n3", "source", { srcset: "/img/never-downloaded.avif", media: "(min-width: 1024px)" }, [], false);
    const img = el("n4", "img", { src: "/img/hero-375.jpg", alt: "hero" });
    return el("n1", "picture", {}, [desktop, gone, img]);
  };

  it("emits surviving srcset candidates with media/type/sizes preserved, omits sources with none", () => {
    const assetMap = new Map([
      ["https://example.test/img/hero-1280.jpg", "/assets/cloned/images/a.jpg"],
      ["https://example.test/img/hero-375.jpg", "/assets/cloned/images/m.jpg"],
    ]);
    const jsx = renderChildrenJsx([mkPicture()], assetMap, SOURCE, 0);
    // Desktop source survives with ONLY the materialized candidate; void element.
    assert.match(jsx, /<source[^>]*srcSet="\/assets\/cloned\/images\/a\.jpg 1x"[^>]*\/>/);
    assert.ok(!jsx.includes("hero-2560"));
    assert.match(jsx, /media="\(min-width: 768px\)"/);
    assert.match(jsx, /type="image\/jpeg"/);
    assert.match(jsx, /sizes="100vw"/);
    // The fully-missed source is omitted entirely (no placeholder-pointing variant).
    assert.ok(!jsx.includes("never-downloaded"));
    assert.ok(!jsx.includes("(min-width: 1024px)"));
    // The <img> fallback keeps its captured (rewritten) src.
    assert.match(jsx, /<img[^>]*src="\/assets\/cloned\/images\/m\.jpg"/);
    // <source> stays a void element: no children, no closing tag.
    assert.ok(!jsx.includes("</source>"));
  });

  it("omits every source when nothing materialized, keeping the img fallback", () => {
    const jsx = renderChildrenJsx([mkPicture()], new Map(), SOURCE, 0);
    assert.ok(!jsx.includes("<source"));
    assert.match(jsx, new RegExp(`<img[^>]*src="${GIF.replace(/[+/]/g, (c) => "\\" + c)}"`));
  });
});
