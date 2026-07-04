import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { letterSpacingEquivalent, normHref, countVisibleInCaptureHiddenInClone } from "../src/validate/gates.js";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { PageSnapshot } from "../src/capture/walker.js";

// FIX 5 — the link gate must not fail a javascript: source href against the clone's sanitized value.
// Generation emits an inert `#` for a `javascript:*` href (React blocks the literal), so normHref
// collapses every javascript: href — on either side — to `#`, letting the two sides match.
describe("normHref collapses javascript: hrefs to # (FIX 5)", () => {
  const origin = "https://example.test";
  it("normalizes a javascript: source href to #", () => {
    assert.equal(normHref("Javascript:{}", origin), "#");
    assert.equal(normHref("javascript:void(0)", origin), "#");
  });
  it("makes a javascript: source match the emitted # value", () => {
    assert.equal(normHref("javascript:{}", origin), normHref("#", origin), "source and clone agree");
  });
  it("still distinguishes a real fragment from a full URL", () => {
    assert.equal(normHref("#top", origin), "#top");
    assert.equal(normHref("https://example.test/x/", origin), "https://example.test/x");
  });
});

// Chromium serializes a computed `letter-spacing: 0` back as the keyword `normal`. The emitter, after
// snapping a sub-0.1px authored tracking to 0, ships `letter-spacing: 0px` — which the CLONE then
// reports as `normal` too, but a source that authored an explicit near-zero px can land on either
// spelling. Gate 4 must treat `normal` and `0px` as equal, or every such node fails on spelling alone.
describe("gate4 letterSpacing normal ↔ 0px normalization", () => {
  it("treats `normal` and `0px` as equivalent", () => {
    assert.ok(letterSpacingEquivalent("normal", "0px"));
    assert.ok(letterSpacingEquivalent("0px", "normal"));
  });

  it("treats `normal` and `normal` as equivalent", () => {
    assert.ok(letterSpacingEquivalent("normal", "normal"));
  });

  it("treats a sub-2px authored tracking vs `normal` as equivalent (within ±2px)", () => {
    // source computed `-0.08px`, clone serialized `normal` — a 0.08px delta, well within tolerance.
    assert.ok(letterSpacingEquivalent("-0.08px", "normal"));
    assert.ok(letterSpacingEquivalent("normal", "-0.0375px"));
  });

  it("still equates two close real px values (−0.24px vs −0.2px)", () => {
    assert.ok(letterSpacingEquivalent("-0.24px", "-0.2px"));
  });

  it("still FAILS a genuine tracking difference beyond ±2px", () => {
    assert.ok(!letterSpacingEquivalent("4px", "normal"));
    assert.ok(!letterSpacingEquivalent("normal", "-3px"));
    assert.ok(!letterSpacingEquivalent("6px", "2px"));
  });

  it("passes when the source did not constrain the property (undefined)", () => {
    assert.ok(letterSpacingEquivalent(undefined, "0px"));
  });
});

// A capture-visible text node that the clone renders hidden (off-screen-shifted / banded /
// width-frozen subtree) is the emil-banner / maxbo-feed regression class. The diagnostic counts
// DISTINCT source cids whose gen counterpart exists but reports visible:false. Non-blocking; it
// only has to be a faithful, deterministic count.
describe("countVisibleInCaptureHiddenInClone diagnostic", () => {
  // Minimal IR text leaf: `text` at every listed vp, visible per `vis`.
  const leaf = (id: string, text: string, vis: Record<number, boolean>): IRNode => {
    const vps = Object.keys(vis).map(Number);
    const rec = <T,>(v: T): Record<number, T> => Object.fromEntries(vps.map((vp) => [vp, v]));
    return {
      id, tag: "a", attrs: {},
      visibleByVp: vis,
      bboxByVp: rec({ x: 0, y: 0, width: 100, height: 16 }),
      computedByVp: rec({} as Record<string, string>),
      children: [{ text }],
    } as unknown as IRNode;
  };
  const makeIR = (leaves: IRNode[]): IR => ({
    doc: {} as IR["doc"],
    root: { id: "n0", tag: "body", attrs: {}, visibleByVp: {}, bboxByVp: {}, computedByVp: {}, children: leaves } as unknown as IRNode,
  });
  // Minimal clone snapshot: one node per (cid, visible) with matching direct text.
  const snap = (nodes: Array<{ cid: string; text: string; visible: boolean }>): PageSnapshot => ({
    root: {
      tag: "body", attrs: { "data-cid": "n0" }, computed: {}, bbox: { x: 0, y: 0, width: 100, height: 100 }, visible: true,
      children: nodes.map((n) => ({
        tag: "a", attrs: { "data-cid": n.cid }, computed: {}, bbox: { x: 0, y: 0, width: 100, height: 16 },
        visible: n.visible, children: [{ text: n.text }],
      })),
    },
  } as unknown as PageSnapshot);

  it("counts a source-visible text node the clone renders hidden", () => {
    const ir = makeIR([leaf("n4", "Enrollment open!", { 375: true })]);
    const gen = { 375: snap([{ cid: "n4", text: "Enrollment open!", visible: false }]) };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375]), 1);
  });

  it("does NOT count a node visible in both source and clone", () => {
    const ir = makeIR([leaf("n4", "Enrollment open!", { 375: true })]);
    const gen = { 375: snap([{ cid: "n4", text: "Enrollment open!", visible: true }]) };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375]), 0);
  });

  it("does NOT count a node the SOURCE itself hid (faithful hide)", () => {
    // maxbo n192 @375: source already off-screen (visible:false) — the clone hiding it is correct.
    const ir = makeIR([leaf("n192", "Avatar: Fire and Ash", { 375: false, 768: true })]);
    const gen = {
      375: snap([{ cid: "n192", text: "Avatar: Fire and Ash", visible: false }]),
      768: snap([{ cid: "n192", text: "Avatar: Fire and Ash", visible: true }]),
    };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375, 768]), 0);
  });

  it("counts a node once even when hidden at several viewports (distinct cids)", () => {
    const ir = makeIR([leaf("n4", "Enrollment open!", { 375: true, 768: true })]);
    const gen = {
      375: snap([{ cid: "n4", text: "Enrollment open!", visible: false }]),
      768: snap([{ cid: "n4", text: "Enrollment open!", visible: false }]),
    };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375, 768]), 1);
  });

  it("ignores whitespace-only text nodes", () => {
    const ir = makeIR([leaf("n5", "   ", { 375: true })]);
    const gen = { 375: snap([{ cid: "n5", text: "   ", visible: false }]) };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375]), 0);
  });

  it("does not count when the clone has no node for the cid (a different miss)", () => {
    const ir = makeIR([leaf("n4", "Enrollment open!", { 375: true })]);
    const gen = { 375: snap([]) };
    assert.equal(countVisibleInCaptureHiddenInClone(ir, gen, [375]), 0);
  });
});
