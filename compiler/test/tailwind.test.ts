import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { declToUtil, snapBase, prettifyBase, collapseBases } from "../src/generate/tailwind.js";

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

// BUG B — the spacing-scale snap must only fire when a value lands ESSENTIALLY ON a step (≤0.25px).
// The scale is 2px-granular (`p-0.5`=2px, `p-1.5`=6px), so 3.5px is BETWEEN steps — snapping it up to
// p-1 (4px) adds +0.5px per side, which accumulates across a fixed-width flex row until items overflow
// and wrap. On-step values (2px→p-0.5, 4px→p-1) still snap.
describe("snapBase spacing-scale snapping", () => {
  it("keeps a between-steps value arbitrary (3.5px does NOT snap to p-1)", () => {
    assert.equal(snapBase("p-[3.5px]"), "p-[3.5px]");
  });

  it("does not snap the same sub-step delta on other spacing props", () => {
    assert.equal(snapBase("pl-[3.5px]"), "pl-[3.5px]");
    assert.equal(snapBase("gap-[3.5px]"), "gap-[3.5px]");
    assert.equal(snapBase("mt-[13.5px]"), "mt-[13.5px]"); // between p-3 (12px) and p-3.5 (14px)
  });

  it("still snaps a value that sits on a 0.5-step (2px → p-0.5, 6px → p-1.5)", () => {
    assert.equal(snapBase("p-[2px]"), "p-0.5");
    assert.equal(snapBase("p-[6px]"), "p-1.5");
  });

  it("still snaps a near-exact on-step value within the tight budget (3.98px → p-1)", () => {
    assert.equal(snapBase("p-[3.98px]"), "p-1");
  });

  it("leaves an already-clean scale utility unchanged and snaps 16px → mx-4", () => {
    assert.equal(snapBase("p-1"), "p-1");
    assert.equal(snapBase("mx-[16px]"), "mx-4");
  });
});

// A percentage 0 on a MAIN-SIZE axis (flex-basis) or a %-of-indefinite-height axis (height/min-height)
// is NOT the definite zero `-0`: `flex-basis:0%` content-sizes against an auto-sized flex container,
// whereas `flex-basis:0` gives a zero base size (collapsing a `flex:1 1 0%` item in an auto-height
// column). prettifyBase must keep those literal. Width/inset 0% resolve against the definite
// containing-block width, so their `-0` rewrite stays.
describe("prettifyBase 0% on indefinite-axis prefixes", () => {
  it("keeps basis-[0%] literal (0% ≠ definite 0 for flex-basis)", () => {
    assert.equal(prettifyBase("basis-[0%]"), "basis-[0%]");
  });
  it("keeps h-[0%] and min-h-[0%] literal (%-of-indefinite-height → auto)", () => {
    assert.equal(prettifyBase("h-[0%]"), "h-[0%]");
    assert.equal(prettifyBase("min-h-[0%]"), "min-h-[0%]");
  });
  it("still rewrites width/inset 0% to the definite -0 (definite containing-block width)", () => {
    assert.equal(prettifyBase("w-[0%]"), "w-0");
    assert.equal(prettifyBase("min-w-[0%]"), "min-w-0");
    assert.equal(prettifyBase("left-[0%]"), "left-0");
    assert.equal(prettifyBase("inset-x-[0%]"), "inset-x-0");
  });
  it("still rewrites non-zero fractions on every prefix (basis-[33.3333%] → basis-1/3)", () => {
    assert.equal(prettifyBase("basis-[33.3333%]"), "basis-1/3");
    assert.equal(prettifyBase("h-[50%]"), "h-1/2");
    assert.equal(prettifyBase("min-h-[100%]"), "min-h-full");
  });
});

// flex:1 1 0% is Tailwind's `flex-1` — fold the grow-[1] + zero-basis pair so the emitted class both
// reads idiomatically AND resolves to the exact flex longhands (avoiding the basis-[0%] hazard).
describe("collapseBases flex-1 folding", () => {
  it("folds grow-[1] + basis-[0%] → flex-1 (shrink defaults to 1, elided)", () => {
    assert.deepEqual(collapseBases(["grow-[1]", "basis-[0%]"]), ["flex-1"]);
  });
  it("folds grow-[1] + basis-0 (already-shortened band delta) → flex-1", () => {
    assert.deepEqual(collapseBases(["grow-[1]", "basis-0"]), ["flex-1"]);
  });
  it("does NOT fold when shrink-0 is present (flex:1 0 0% ≠ flex-1)", () => {
    assert.deepEqual(collapseBases(["grow-[1]", "shrink-0", "basis-[0%]"]).sort(), ["basis-[0%]", "grow-[1]", "shrink-0"]);
  });
  it("does NOT fold a non-zero basis (grow-[1] + basis-[50%] left as-is)", () => {
    assert.deepEqual(collapseBases(["grow-[1]", "basis-[50%]"]).sort(), ["basis-[50%]", "grow-[1]"]);
  });
});

// letter-spacing is authored at a finer scale than box lengths; a real -0.08px tracking is within
// snapLen's 0.1px integer-snap window and would collapse to 0px → Chromium serializes it as `normal`
// → a false style-gate mismatch. Tracking must skip the integer snap (snapBase keeps 2 decimals).
describe("declToUtil letter-spacing sub-0.1px preservation", () => {
  it("keeps a real -0.08px tracking (does NOT snap to tracking-[0px])", () => {
    assert.equal(declToUtil("letter-spacing", "-0.08px"), "tracking-[-0.08px]");
  });
  it("keeps -0.0375px through declToUtil, then snapBase rounds to 2 decimals (not to zero)", () => {
    assert.equal(declToUtil("letter-spacing", "-0.0375px"), "tracking-[-0.0375px]");
    assert.equal(snapBase("tracking-[-0.0375px]"), "tracking-[-0.04px]");
  });
  it("still keeps a genuine zero as tracking-[0px]", () => {
    assert.equal(declToUtil("letter-spacing", "0px"), "tracking-[0px]");
  });
  it("still integer-snaps a BOX length near an integer (204.9994px → 205px)", () => {
    assert.equal(declToUtil("width", "204.9994px"), "w-[205px]");
  });
});

// text-wrap: modern heading line-balancing. `balance`/`pretty` rebalance where a title wraps;
// without emitting them a two-line heading breaks differently in the clone. Tailwind v4 has the
// named utilities text-balance / text-pretty / text-nowrap / text-wrap; anything else (e.g.
// `stable`) falls through to the arbitrary property escape.
describe("declToUtil text-wrap", () => {
  it("maps balance and pretty to the named Tailwind v4 utilities", () => {
    assert.equal(declToUtil("text-wrap", "balance"), "text-balance");
    assert.equal(declToUtil("text-wrap", "pretty"), "text-pretty");
  });
  it("maps wrap and nowrap to their named utilities", () => {
    assert.equal(declToUtil("text-wrap", "wrap"), "text-wrap");
    assert.equal(declToUtil("text-wrap", "nowrap"), "text-nowrap");
  });
  it("falls back to the arbitrary property for an unmapped value", () => {
    assert.equal(declToUtil("text-wrap", "stable"), "[text-wrap:stable]");
  });
});
