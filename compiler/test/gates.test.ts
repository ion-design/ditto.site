import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { letterSpacingEquivalent, normHref, countVisibleInCaptureHiddenInClone, gate2Assets, gatePollution } from "../src/validate/gates.js";
import { servedAssetExists } from "../src/validate/validate.js";
import type { AssetGraph } from "../src/infer/assets.js";
import type { FontGraph } from "../src/infer/fonts.js";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { PageSnapshot } from "../src/capture/walker.js";
import type { CaptureResult } from "../src/capture/capture.js";

describe("gatePollution shared challenge verdict", () => {
  const make = (opts: { title: string; text: string; nodes: number; srcClass?: string; assets?: string[] }): { ir: IR; capture: CaptureResult } => {
    const root = {
      id: "n0", tag: "body", attrs: {}, ...(opts.srcClass ? { srcClass: opts.srcClass } : {}),
      visibleByVp: { 1280: true }, bboxByVp: { 1280: { x: 0, y: 0, width: 1280, height: 800 } },
      computedByVp: { 1280: {} }, children: [{ text: opts.text }],
    } as unknown as IRNode;
    const ir = {
      doc: {
        sourceUrl: "https://ridge.com/", title: opts.title, viewports: [1280], sampleViewports: [1280],
        canonicalViewport: 1280, nodeCount: opts.nodes,
        perViewport: { 1280: { scrollHeight: 800, scrollWidth: 1280, htmlBg: "", bodyBg: "", bodyColor: "", bodyFont: "" } },
      },
      root,
    } as unknown as IR;
    const capture = {
      sourceUrl: "https://ridge.com/", capturedAt: "2026-01-01T00:00:00.000Z", viewports: [1280],
      perViewport: [{ viewport: 1280, height: 800, scrollHeight: 800, nodeCount: opts.nodes, truncated: false }],
      assets: (opts.assets ?? []).map((url) => ({ url, type: "other", contentType: null, status: 200, storedAs: null, bytes: 0, via: [] })),
      fontFaces: [], cssTexts: [],
    } as CaptureResult;
    return { ir, capture };
  };

  it("flags a high-node cf-chl capture using the shared structured diagnosis", () => {
    const { ir, capture } = make({
      title: "Just a moment...", text: "Incorrect device time", nodes: 450, srcClass: "cf-chl-widget",
    });
    const result = gatePollution(ir, capture, [1280]);
    assert.equal(result.pass, false);
    assert.equal(result.metrics.challengeDetected, true);
    assert.ok((result.metrics.challengeSignals as string[]).includes("cloudflare.cf-chl-identifier"));
  });

  it("does not flag large ordinary documentation that mentions CAPTCHA", () => {
    const { ir, capture } = make({
      title: "Security documentation", text: "How Cloudflare and CAPTCHA accessibility work for our customers.", nodes: 1200,
      assets: ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
    });
    const result = gatePollution(ir, capture, [1280]);
    assert.equal(result.metrics.challengeDetected, false);
    assert.ok(!result.issues.some((issue) => issue.includes("anti-bot challenge")));
  });
});

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

// FIX 3 — an aborted srcset-candidate image fetch (requestfailed, file present on disk) must not be
// counted as a "404" asset failure. servedAssetExists maps a failed URL to a file under the served
// export exactly as serveStatic does; the assetFailed filter in validate.ts uses it to excuse
// aborted fetches whose file exists, while genuine misses (>= 400, or file absent) still fail.
describe("servedAssetExists (FIX 3 aborted-image excuse)", () => {
  const root = mkdtempSync(join(tmpdir(), "served-out-"));
  mkdirSync(join(root, "assets", "cloned", "images"), { recursive: true });
  writeFileSync(join(root, "assets", "cloned", "images", "present.webp"), "RIFFxxxxWEBP");

  it("resolves a URL to a present file under the served root", () => {
    assert.equal(servedAssetExists(root, "http://127.0.0.1:5000/assets/cloned/images/present.webp"), true);
  });

  it("returns false when the file is absent from the served root (a genuine miss)", () => {
    assert.equal(servedAssetExists(root, "http://127.0.0.1:5000/assets/cloned/images/absent.webp"), false);
  });

  it("ignores query strings when resolving to disk", () => {
    assert.equal(servedAssetExists(root, "http://127.0.0.1:5000/assets/cloned/images/present.webp?206w"), true);
  });

  it("does not escape the served root via .. traversal", () => {
    assert.equal(servedAssetExists(root, "http://127.0.0.1:5000/../../../etc/passwd"), false);
  });

  it("an unparseable URL is treated as a genuine miss", () => {
    assert.equal(servedAssetExists(root, "not-a-url"), false);
  });
});

describe("gate2Assets failed-asset message (FIX 3)", () => {
  const emptyAssets: AssetGraph = { entries: [], byUrl: new Map() };
  const emptyFonts: FontGraph = { entries: [], css: "" };

  it("passes when no generated asset refs are missing", () => {
    const r = gate2Assets(emptyAssets, emptyFonts, { remoteRefs: [], failed404: [] });
    assert.equal(r.pass, true);
    assert.equal(r.metrics.failed404, 0);
  });

  it("fails and reports missing refs (not '404') when a genuine miss is passed", () => {
    const r = gate2Assets(emptyAssets, emptyFonts, { remoteRefs: [], failed404: ["failed http://127.0.0.1:5000/assets/cloned/images/absent.webp"] });
    assert.equal(r.pass, false);
    assert.equal(r.metrics.failed404, 1);
    assert.ok(r.issues.some((i) => i.includes("generated asset refs missing")), `expected 'missing' wording, got: ${r.issues.join(" | ")}`);
  });
});
