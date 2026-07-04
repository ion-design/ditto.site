import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IR, IRNode } from "../src/normalize/ir.js";
import { collectExpectedCss, cssReplayedByReveal } from "../src/validate/motionGate.js";
import { missingHarnessDeps } from "../src/validate/render.js";

// Minimal IRNode factory — collectExpectedCss only reads id, computedByVp[vp].animation*,
// and children, so we build just those fields and cast.
function node(id: string, anim: { animationName?: string; animationIterationCount?: string; animationDuration?: string } | null, children: IRNode[] = []): IRNode {
  return {
    id,
    tag: "div",
    attrs: {},
    visibleByVp: {},
    bboxByVp: {},
    computedByVp: anim ? { 1280: anim as unknown as IRNode["computedByVp"][number] } : {},
    children,
  } as unknown as IRNode;
}

function ir(root: IRNode): IR {
  return { doc: { canonicalViewport: 1280 } as unknown as IR["doc"], root };
}

describe("motion gate — CSS entrance / reveal-replay accounting", () => {
  it("collectExpectedCss reports every node with a computed animation-name != none", () => {
    const tree = ir(
      node("n0", null, [
        node("n464", { animationName: "fadeInUp", animationIterationCount: "1" }),
        node("n2", { animationName: "none" }), // excluded
        node("n3", null), // no animation
        node("n4", { animationName: "spin", animationIterationCount: "infinite" }),
      ]),
    );
    const got = collectExpectedCss(tree);
    assert.deepEqual(got.map((e) => e.cid).sort(), ["n4", "n464"]);
    const spin = got.find((e) => e.cid === "n4")!;
    assert.equal(spin.infinite, true);
    const fade = got.find((e) => e.cid === "n464")!;
    assert.equal(fade.infinite, false);
    assert.deepEqual(fade.names, ["fadeInUp"]);
  });

  it("collectExpectedCss EXCLUDES a scroll/view-timeline animation (animation-duration:auto)", () => {
    // Fix 3: the ooni text-fill em (animation-timeline:view → computed animation-duration:auto)
    // is intentionally NOT emitted (we render the at-rest state, not a scroll replay). It must be
    // excluded from the static-CSS expectation, not counted as an owed-but-missing animation.
    const tree = ir(
      node("n0", null, [
        node("n358", { animationName: "fillAnimation", animationDuration: "auto", animationIterationCount: "1" }),
        node("n4", { animationName: "spin", animationDuration: "1s", animationIterationCount: "infinite" }),
      ]),
    );
    const got = collectExpectedCss(tree);
    assert.deepEqual(got.map((e) => e.cid), ["n4"], "scroll-timeline node n358 must be excluded");
  });

  it("cssReplayedByReveal excludes a captured entrance the clone replays via a reveal", () => {
    // The cropin regression: n464's fadeInUp is driven by a DittoMotion reveal, so the static
    // animation-name is deliberately NOT emitted — it must NOT fail emitted=false.
    const revealAnim = new Map([["n464", "fadeInUp"]]);
    assert.equal(cssReplayedByReveal("n464", ["fadeInUp"], revealAnim), true);
  });

  it("cssReplayedByReveal does NOT exclude a CSS anim whose node has no reveal (still static)", () => {
    const revealAnim = new Map([["n464", "fadeInUp"]]);
    // A different, non-reveal node keeps the static-CSS expectation.
    assert.equal(cssReplayedByReveal("n9", ["spin"], revealAnim), false);
  });

  it("cssReplayedByReveal does NOT exclude when the reveal replays a DIFFERENT animation name", () => {
    // Reveal covers the cid but with a different entrance — the captured CSS anim is unrelated
    // and still owed as static CSS, so it must not be silently excused.
    const revealAnim = new Map([["n464", "fadeInUp"]]);
    assert.equal(cssReplayedByReveal("n464", ["pulse"], revealAnim), false);
  });

  it("cssReplayedByReveal ignores reveals with no entrance animationName (transition family)", () => {
    // Transition-family reveals (opacity/transform only) carry no animationName; a node with a
    // real CSS keyframe anim is NOT excused by such a reveal.
    const revealAnim = new Map<string, string>(); // no entries for transition-family reveals
    assert.equal(cssReplayedByReveal("n464", ["fadeInUp"], revealAnim), false);
  });
});

describe("harness build — missing dependency detection (Lottie regression)", () => {
  function tmp(): { app: string; harness: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "harness-dep-"));
    const app = join(root, "app");
    const harness = join(root, "harness");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(harness, "node_modules"), { recursive: true });
    return { app, harness, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  function writePkg(dir: string, deps: Record<string, string>): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps }));
  }
  function provision(harness: string, name: string, version: string): void {
    const p = join(harness, "node_modules", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "package.json"), JSON.stringify({ name, version }));
  }

  it("flags a dep the app declares but the harness lacks, pinned to the app's exact version", () => {
    const { app, harness, cleanup } = tmp();
    try {
      writePkg(app, { next: "15.5.19", react: "19.2.7", "lottie-web": "5.12.2" });
      provision(harness, "next", "15.5.19");
      provision(harness, "react", "19.2.7");
      // lottie-web NOT provisioned in the harness — mirrors the real regression.
      const missing = missingHarnessDeps(app, harness);
      assert.deepEqual(missing, [{ name: "lottie-web", version: "5.12.2" }]);
    } finally { cleanup(); }
  });

  it("returns nothing when every app dep is already in the harness node_modules", () => {
    const { app, harness, cleanup } = tmp();
    try {
      writePkg(app, { next: "15.5.19", react: "19.2.7" });
      provision(harness, "next", "15.5.19");
      provision(harness, "react", "19.2.7");
      assert.deepEqual(missingHarnessDeps(app, harness), []);
    } finally { cleanup(); }
  });

  it("strips a caret/tilde range to a bare version for a deterministic pinned install", () => {
    const { app, harness, cleanup } = tmp();
    try {
      writePkg(app, { "lottie-web": "^5.12.2" });
      const missing = missingHarnessDeps(app, harness);
      assert.deepEqual(missing, [{ name: "lottie-web", version: "5.12.2" }]);
    } finally { cleanup(); }
  });

  it("returns nothing when the app has no package.json", () => {
    const { app, harness, cleanup } = tmp();
    try {
      rmSync(join(app, "package.json"), { force: true });
      assert.deepEqual(missingHarnessDeps(app, harness), []);
    } finally { cleanup(); }
  });
});
