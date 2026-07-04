import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  medianVelocityPxPerSec,
  classifyVelocitySamples,
  hasRepeatedChildren,
} from "../src/capture/motion.js";

// These cover the pure discriminators extracted from detectMarquees' in-browser sampling.
// The regression they defend: on a scroll-LINKED-easing page, a static logo row is still
// lerping toward its scroll-target right after scrollIntoView, reading as a constant
// velocity over ONE short window → four phantom marquees at identical -34px/s. The layered
// tests below make that classification fail.

describe("medianVelocityPxPerSec", () => {
  it("converts a steady per-120ms delta to px/s and ignores the wrap-reset outlier", () => {
    // steady -4px per 120ms ≈ -33px/s; one big +200 wrap jump is an outlier the median drops.
    const deltas = [-4, -4, 200, -4, -4];
    assert.equal(medianVelocityPxPerSec(deltas, 120), Math.round((-4 / 120) * 1000));
  });
  it("returns 0 for empty deltas or a non-positive cadence", () => {
    assert.equal(medianVelocityPxPerSec([], 120), 0);
    assert.equal(medianVelocityPxPerSec([-4, -4], 0), 0);
  });
});

describe("classifyVelocitySamples — sustained constant velocity (discriminator 2)", () => {
  const MS = 120;
  it("PASSES a real marquee: velocity holds across both windows", () => {
    const w1 = [-4, -4, -4, -4, -4];
    const w2 = [-4, -4, -4, -4, -4];
    const r = classifyVelocitySamples(w1, w2, MS);
    assert.equal(r.isMarquee, true);
    assert.equal(r.pxPerSec, medianVelocityPxPerSec(w1, MS));
  });

  it("REJECTS a scroll-settle lerp: velocity decays sharply in window 2 (the false positive)", () => {
    // window1 still lerping fast toward scroll-target; window2 nearly settled.
    const w1 = [-4, -4, -4, -4, -4]; // ≈ -33px/s (the phantom "-34px/s")
    const w2 = [-0.4, -0.4, -0.4, -0.4, -0.4]; // decayed to ~-3px/s
    assert.equal(classifyVelocitySamples(w1, w2, MS).isMarquee, false);
  });

  it("REJECTS when window 2 has fully settled (velocity ~0)", () => {
    const w1 = [-4, -4, -4, -4, -4];
    const w2 = [0, 0, 0, 0, 0];
    assert.equal(classifyVelocitySamples(w1, w2, MS).isMarquee, false);
  });

  it("REJECTS when the direction reverses between windows", () => {
    const w1 = [-4, -4, -4, -4, -4];
    const w2 = [4, 4, 4, 4, 4];
    assert.equal(classifyVelocitySamples(w1, w2, MS).isMarquee, false);
  });

  it("REJECTS a static row: no motion in either window", () => {
    assert.equal(classifyVelocitySamples([0, 0, 0], [0, 0, 0], MS).isMarquee, false);
  });

  it("PASSES a slightly slower-but-still-moving second window (within tolerance)", () => {
    // small natural jitter (10% slower) must not disqualify a genuine ticker.
    const w1 = [-4, -4, -4, -4, -4];
    const w2 = [-3.6, -3.6, -3.6, -3.6, -3.6];
    assert.equal(classifyVelocitySamples(w1, w2, MS).isMarquee, true);
  });
});

describe("hasRepeatedChildren — genuine duplication (discriminator 4)", () => {
  it("PASSES two consecutive children with an identical outerHTML hash (a cloned copy)", () => {
    const hashes = [111, 111, 222]; // first two are a literal duplicate
    const widths = [80, 80, 120];
    assert.equal(hasRepeatedChildren(hashes, widths), true);
  });

  it("PASSES a duplicated content block via the repeated width sequence [A B A B]", () => {
    // hashes differ (cloned then attribute-tweaked) but geometry repeats: [100,60,100,60].
    const hashes = [1, 2, 3, 4];
    const widths = [100, 60, 100, 60];
    assert.equal(hasRepeatedChildren(hashes, widths), true);
  });

  it("REJECTS a row of distinct logos: no consecutive repetition (the false-positive shape)", () => {
    // four DIFFERENT logos — the exact static-logo-row case that produced phantom marquees.
    const hashes = [10, 20, 30, 40];
    const widths = [90, 110, 75, 130];
    assert.equal(hasRepeatedChildren(hashes, widths), false);
  });

  it("REJECTS fewer than two children", () => {
    assert.equal(hasRepeatedChildren([5], [50]), false);
    assert.equal(hasRepeatedChildren([], []), false);
  });

  it("does NOT treat a run of zero-width nodes as repetition (hash 0 / width 0 guards)", () => {
    assert.equal(hasRepeatedChildren([0, 0], [0, 0]), false);
    assert.equal(hasRepeatedChildren([1, 2, 3, 4], [0, 0, 0, 0]), false);
  });

  it("REJECTS an odd-length width sequence that can't split into halves", () => {
    const hashes = [1, 2, 3];
    const widths = [100, 60, 100];
    assert.equal(hasRepeatedChildren(hashes, widths), false);
  });
});
