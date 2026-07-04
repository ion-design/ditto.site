import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSvgRootFill, isRealPaint } from "../src/generate/app.js";

describe("isRealPaint", () => {
  it("treats none / empty / transparent as non-paint", () => {
    for (const v of [undefined, null, "", "  ", "none", "NONE", "transparent", "rgba(0, 0, 0, 0)", "rgba(0,0,0,0)"]) {
      assert.equal(isRealPaint(v), false, `${String(v)} should not paint`);
    }
  });
  it("treats a color / currentColor as a real paint", () => {
    for (const v of ["rgb(255, 255, 255)", "#000", "currentColor", "red", "rgb(0, 0, 0)"]) {
      assert.equal(isRealPaint(v), true, `${v} should paint`);
    }
  });
});

describe("resolveSvgRootFill", () => {
  it("keeps a raw fill that is itself a real paint", () => {
    assert.deepEqual(resolveSvgRootFill("#123456", { fill: "rgb(255,255,255)", color: "rgb(0,0,0)" }), { mode: "keep" });
    assert.deepEqual(resolveSvgRootFill("red", null), { mode: "keep" });
  });

  it("falls back when no raw fill is declared (existing currentColor default)", () => {
    assert.deepEqual(resolveSvgRootFill(undefined, { fill: "rgb(255,255,255)", color: "rgb(255,255,255)" }), { mode: "fallback" });
    assert.deepEqual(resolveSvgRootFill(null, null), { mode: "fallback" });
  });

  it("recovers currentColor when fill=none but computed fill tracks the element color (wordmark case)", () => {
    // The a16z logo case: fill="none" attribute, but CSS `fill: currentColor` with white color.
    const r = resolveSvgRootFill("none", { fill: "rgb(255, 255, 255)", color: "rgb(255, 255, 255)" });
    assert.equal(r.mode, "emit");
    assert.equal(r.value, "currentColor");
    assert.equal(r.emitColor, "rgb(255, 255, 255)");
  });

  it("emits the literal computed fill when it differs from the element color", () => {
    const r = resolveSvgRootFill("none", { fill: "rgb(255, 0, 0)", color: "rgb(0, 0, 0)" });
    assert.equal(r.mode, "emit");
    assert.equal(r.value, "rgb(255, 0, 0)");
    assert.equal(r.emitColor, undefined);
  });

  it("leaves a genuinely unfilled svg as none (computed fill also none)", () => {
    assert.deepEqual(resolveSvgRootFill("none", { fill: "none", color: "rgb(0,0,0)" }), { mode: "keep" });
    assert.deepEqual(resolveSvgRootFill("none", { fill: "rgba(0, 0, 0, 0)", color: "rgb(0,0,0)" }), { mode: "keep" });
    // No computed paint captured at all → cannot prove it paints → stays none.
    assert.deepEqual(resolveSvgRootFill("none", null), { mode: "keep" });
    assert.deepEqual(resolveSvgRootFill("none", undefined), { mode: "keep" });
  });

  it("does not emit color when the recovered fill is currentColor but color is not a real paint", () => {
    // fill == color but color is transparent → cannot be a meaningful currentColor recovery;
    // the equality branch is guarded on isRealPaint(color), so it emits the literal fill instead.
    const r = resolveSvgRootFill("none", { fill: "rgb(0, 128, 0)", color: "transparent" });
    assert.equal(r.mode, "emit");
    assert.equal(r.value, "rgb(0, 128, 0)");
    assert.equal(r.emitColor, undefined);
  });
});
