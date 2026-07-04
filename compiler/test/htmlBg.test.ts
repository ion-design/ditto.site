import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveHtmlBg, htmlBgRule } from "../src/generate/app.js";

// Regression: when the source layers a full-bleed backdrop at z-index<0 behind a
// body-propagated canvas background, emitting an opaque `html { background }`
// flips CSS 2.1 §14.2 background propagation and buries that backdrop under the
// body box. `html` must only paint when the SOURCE html actually painted.
describe("resolveHtmlBg — source-faithful canvas propagation", () => {
  it("transparent html + colored body → no html background (body propagates to canvas)", () => {
    const htmlBg = resolveHtmlBg({ htmlBg: "rgba(0, 0, 0, 0)", bodyBg: "rgb(246, 244, 238)" });
    assert.equal(htmlBg, null);
    assert.equal(htmlBgRule(htmlBg), "");
  });

  it("colored html → html background kept", () => {
    const htmlBg = resolveHtmlBg({ htmlBg: "rgb(10, 20, 30)", bodyBg: "rgb(246, 244, 238)" });
    assert.equal(htmlBg, "rgb(10, 20, 30)");
    assert.equal(htmlBgRule(htmlBg), "html { background: rgb(10, 20, 30); }\n");
  });

  it("both transparent → #ffffff fallback (never a UA-default canvas)", () => {
    const htmlBg = resolveHtmlBg({ htmlBg: "rgba(0, 0, 0, 0)", bodyBg: "rgba(0, 0, 0, 0)" });
    assert.equal(htmlBg, "#ffffff");
    assert.equal(htmlBgRule(htmlBg), "html { background: #ffffff; }\n");
  });

  it("missing perViewport entry → #ffffff fallback", () => {
    const htmlBg = resolveHtmlBg(undefined);
    assert.equal(htmlBg, "#ffffff");
  });

  it("undefined html + colored body (only body captured) → no html rule", () => {
    // Body-only styling is the common case the old fallback existed for; it must
    // still leave html transparent so the body color reaches the canvas.
    const htmlBg = resolveHtmlBg({ bodyBg: "rgb(0, 0, 0)" });
    assert.equal(htmlBg, null);
  });

  it("deterministic: identical input yields identical output", () => {
    const pv = { htmlBg: "rgba(0, 0, 0, 0)", bodyBg: "rgb(1, 2, 3)" };
    assert.equal(resolveHtmlBg(pv), resolveHtmlBg({ ...pv }));
  });
});
