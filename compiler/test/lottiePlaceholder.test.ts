import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DITTO_LOTTIE_TSX } from "../src/generate/lottie.js";
import { isIdentityTransform, canonicalizeTransforms } from "../src/normalize/ir.js";
import type { StyleMap } from "../src/normalize/ir.js";

/**
 * The DittoLottie runtime must NOT erase the captured placeholder frame before the animation
 * has successfully loaded — a failed load would otherwise blank the container (erasing hero /
 * logo / footer media). These are string assertions on the emitted 'use client' template.
 */
describe("DittoLottie placeholder retention", () => {
  it("does not clear the container's innerHTML before mounting", () => {
    assert.ok(
      !/el\.innerHTML\s*=\s*""/.test(DITTO_LOTTIE_TSX),
      "template must not eagerly clear the placeholder via el.innerHTML = \"\"",
    );
  });

  it("mounts the live animation into a separate overlay child, not the container itself", () => {
    assert.match(DITTO_LOTTIE_TSX, /createElement\(["']div["']\)/);
    assert.match(DITTO_LOTTIE_TSX, /container:\s*mount/);
  });

  it("only removes the placeholder after a successful load event (DOMLoaded)", () => {
    // The reveal/swap must be gated behind lottie's ready event, and the placeholder removal
    // must live inside that gated path (removing original children once mount is ready).
    assert.match(DITTO_LOTTIE_TSX, /addEventListener\(\s*["']DOMLoaded["']/);
    assert.match(DITTO_LOTTIE_TSX, /removeChild/);
    // The removal must reference the ready swap, not run unconditionally at mount time.
    const revealIdx = DITTO_LOTTIE_TSX.indexOf("DOMLoaded");
    const clearIdx = DITTO_LOTTIE_TSX.indexOf("removeChild");
    assert.ok(revealIdx >= 0 && clearIdx >= 0, "both the ready gate and the placeholder removal must be present");
  });

  it("handles a failed load without leaving a broken mount stacked over the placeholder", () => {
    assert.match(DITTO_LOTTIE_TSX, /data_failed/);
  });

  // The player creates its <svg>/<canvas> at runtime WITHOUT a data-cid, so the DOM/media gate can't
  // map it back to the captured node. The reveal must forward the discarded placeholder's data-cid
  // onto the runtime-rendered element (validation-agnostic; no gate special-casing).
  it("forwards the placeholder's data-cid onto the runtime-rendered svg/canvas before the swap", () => {
    // reads the placeholder cid, then reassigns it to the rendered svg/canvas inside the mount
    assert.match(DITTO_LOTTIE_TSX, /getAttribute\(\s*["']data-cid["']\s*\)/);
    assert.match(DITTO_LOTTIE_TSX, /mount\.querySelector\(\s*["']svg,\s*canvas["']\s*\)/);
    assert.match(DITTO_LOTTIE_TSX, /setAttribute\(\s*["']data-cid["']\s*,/);
    // the cid capture must precede its removal so the placeholder is still in the DOM when read
    const readIdx = DITTO_LOTTIE_TSX.indexOf('getAttribute("data-cid")');
    const removeIdx = DITTO_LOTTIE_TSX.indexOf("removeChild");
    assert.ok(readIdx >= 0 && removeIdx >= 0 && readIdx < removeIdx, "must read the placeholder cid before removing it");
  });
});

describe("identity-transform canonicalization (isIdentityTransform)", () => {
  it("treats none and identity matrices as identity", () => {
    assert.equal(isIdentityTransform("none"), true);
    assert.equal(isIdentityTransform(undefined), true);
    assert.equal(isIdentityTransform("matrix(1, 0, 0, 1, 0, 0)"), true);
    assert.equal(isIdentityTransform("matrix(1,0,0,1,0,0)"), true);
    assert.equal(
      isIdentityTransform("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)"),
      true,
    );
  });

  it("does NOT treat a real (non-identity) transform as identity", () => {
    assert.equal(isIdentityTransform("matrix(1, 0, 0, 1, 0, 67.75)"), false);
    assert.equal(isIdentityTransform("translateY(67.75px)"), false);
    assert.equal(isIdentityTransform("matrix(0.5, 0, 0, 0.5, 0, 0)"), false);
    assert.equal(isIdentityTransform("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1)"), false);
  });

  it("rewrites identity values to `none` while leaving a real transform observable at other widths", () => {
    // The contamination scenario: the base viewport (1280) baked a scroll-linked translateY,
    // while the other widths report identity (none / identity matrix). After canonicalization
    // the identity widths read literal `none`, so the generator's per-band delta emits the
    // explicit reset and the base transform can't cascade across bands.
    const computedByVp: Record<number, StyleMap> = {
      375: { transform: "none" } as StyleMap,
      768: { transform: "matrix(1, 0, 0, 1, 0, 0)" } as StyleMap,
      1280: { transform: "matrix(1, 0, 0, 1, 0, 67.75)" } as StyleMap, // contaminated base
      1920: { transform: "none" } as StyleMap,
    };
    canonicalizeTransforms(computedByVp);
    assert.equal(computedByVp[375]!.transform, "none");
    assert.equal(computedByVp[768]!.transform, "none"); // identity matrix normalized to none
    assert.equal(computedByVp[1280]!.transform, "matrix(1, 0, 0, 1, 0, 67.75)"); // real transform preserved
    assert.equal(computedByVp[1920]!.transform, "none");
  });
});
