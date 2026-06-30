import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild } from "../src/normalize/ir.js";
import type { MotionCapture } from "../src/capture/motion.js";
import type { AssetGraph, AssetEntry } from "../src/infer/assets.js";
import { buildLottieSpec, lottieHasContent } from "../src/generate/lottie.js";

/** Minimal IRNode — buildLottieSpec only reads id / attrs / children. */
function node(id: string, attrs: Record<string, string>, children: IRChild[] = []): IRNode {
  return { id, tag: "div", attrs, visibleByVp: {}, bboxByVp: {}, computedByVp: {}, children } as IRNode;
}

function irWith(root: IRNode): IR {
  return { doc: {} as IR["doc"], root } as IR;
}

function emptyMotion(over: Partial<MotionCapture>): MotionCapture {
  return { waapi: [], rotators: [], reveals: [], marquees: [], lotties: [], lottieInline: {}, cssAnimated: 0, ...over };
}

function downloadedGraph(url: string, localPath: string): AssetGraph {
  const entry: AssetEntry = {
    sourceUrl: url, type: "lottie", classification: "downloaded",
    localPath, storedFile: localPath.split("/").pop()!, bytes: 100, reason: null, impact: null, via: ["lottie"],
  };
  return { entries: [entry], byUrl: new Map([[url, entry]]) };
}

const lottie = (over: Partial<MotionCapture["lotties"][number]>): MotionCapture["lotties"][number] => ({
  cap: "cap-1", via: "player", src: null, inlineKey: null, renderer: "svg", loop: true, autoplay: true, width: 240, height: 240, ...over,
});

describe("buildLottieSpec", () => {
  it("resolves a URL-backed lottie: cap->cid and src->materialized local path", () => {
    const ir = irWith(node("n0", {}, [node("n6", { "data-cid-cap": "cap-1" })]));
    const motion = emptyMotion({ lotties: [lottie({ src: "https://x/anim.json" })] });
    const graph = downloadedGraph("https://x/anim.json", "/assets/cloned/lottie/abc.json");

    const spec = buildLottieSpec(ir, motion, graph);
    assert.equal(spec.items.length, 1);
    const it0 = spec.items[0]!;
    assert.equal(it0.cid, "n6");
    assert.equal(it0.path, "/assets/cloned/lottie/abc.json");
    assert.equal(it0.animationData, null);
    assert.equal(it0.renderer, "svg");
    assert.equal(it0.loop, true);
    assert.ok(lottieHasContent(spec));
  });

  it("falls back to inline animationData when there is no fetchable URL", () => {
    const ir = irWith(node("n0", {}, [node("n6", { "data-cid-cap": "cap-1" })]));
    const motion = emptyMotion({
      lotties: [lottie({ src: null, inlineKey: "k0", renderer: "canvas" })],
      lottieInline: { k0: { v: "5.7", layers: [] } },
    });
    const graph: AssetGraph = { entries: [], byUrl: new Map() };

    const spec = buildLottieSpec(ir, motion, graph);
    assert.equal(spec.items.length, 1);
    assert.equal(spec.items[0]!.path, null);
    assert.deepEqual(spec.items[0]!.animationData, { v: "5.7", layers: [] });
    assert.equal(spec.items[0]!.renderer, "canvas");
  });

  it("drops a lottie whose container node didn't survive into the IR", () => {
    const ir = irWith(node("n0", {}, [node("n6", { "data-cid-cap": "other-cap" })]));
    const motion = emptyMotion({ lotties: [lottie({ src: "https://x/anim.json" })] });
    const graph = downloadedGraph("https://x/anim.json", "/assets/cloned/lottie/abc.json");

    assert.equal(buildLottieSpec(ir, motion, graph).items.length, 0);
  });

  it("drops a lottie whose JSON neither downloaded nor has inline data", () => {
    const ir = irWith(node("n0", {}, [node("n6", { "data-cid-cap": "cap-1" })]));
    const motion = emptyMotion({ lotties: [lottie({ src: "https://x/missing.json" })] });
    const graph: AssetGraph = { entries: [], byUrl: new Map() }; // never downloaded

    const spec = buildLottieSpec(ir, motion, graph);
    assert.equal(spec.items.length, 0);
    assert.equal(lottieHasContent(spec), false);
  });

  it("returns empty for a capture with no lotties", () => {
    const ir = irWith(node("n0", {}));
    assert.equal(buildLottieSpec(ir, emptyMotion({}), { entries: [], byUrl: new Map() }).items.length, 0);
  });
});
