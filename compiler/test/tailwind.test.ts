import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { declToUtil } from "../src/generate/tailwind.js";

// Zero-value gating. A named `-0` step only exists for props on Tailwind's spacing (or numeric)
// scales; for the rest the class compiles to NOTHING — a silent no-op that ships the wrong style
// (a map label captured at font-size:0 painted at the inherited 20px because `text-0` isn't a
// utility). Zeros for scale-less props must stay arbitrary so the declaration really compiles.
describe("declToUtil zero values", () => {
  it("emits arbitrary text-[0px] for font-size:0 (no text-0 utility in v4)", () => {
    assert.equal(declToUtil("font-size", "0px"), "text-[0px]");
    assert.equal(declToUtil("font-size", "0"), "text-[0px]");
  });

  it("emits arbitrary tracking-[0px] for letter-spacing:0 (no tracking-0 utility in v4)", () => {
    assert.equal(declToUtil("letter-spacing", "0px"), "tracking-[0px]");
    assert.equal(declToUtil("letter-spacing", "0"), "tracking-[0px]");
  });

  it("emits arbitrary rounded corners for radius:0 (radius scale has no numeric 0)", () => {
    assert.equal(declToUtil("border-top-left-radius", "0px"), "rounded-tl-[0px]");
  });

  it("keeps the named -0 for spacing-scale props", () => {
    assert.equal(declToUtil("width", "0px"), "w-0");
    assert.equal(declToUtil("width", "0"), "w-0");
    assert.equal(declToUtil("top", "0px"), "top-0");
    assert.equal(declToUtil("margin-left", "0px"), "ml-0");
    assert.equal(declToUtil("line-height", "0px"), "leading-0");
  });

  it("keeps the named -0 for numeric scales that include 0", () => {
    assert.equal(declToUtil("flex-grow", "0"), "grow-0");
    assert.equal(declToUtil("flex-shrink", "0"), "shrink-0");
    assert.equal(declToUtil("order", "0"), "order-0");
    assert.equal(declToUtil("z-index", "0"), "z-0");
  });

  it("leaves non-zero values untouched", () => {
    assert.equal(declToUtil("font-size", "20px"), "text-[20px]");
    assert.equal(declToUtil("letter-spacing", "-0.5px"), "tracking-[-0.5px]");
  });
});
