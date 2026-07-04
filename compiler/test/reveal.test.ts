import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageSnapshot, RawNode, RawChild } from "../src/capture/walker.js";
import { captureSite, type CaptureResult } from "../src/capture/capture.js";
import { buildIR } from "../src/normalize/ir.js";
import { buildMotionSpec, motionWireJsx, DITTO_MOTION_TSX } from "../src/generate/motion.js";
import { readJSON } from "../src/util/fsx.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const VIEWPORTS = [375, 800];

function isText(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

function findById(n: RawNode, id: string): RawNode | null {
  if (n.attrs.id === id) return n;
  for (const c of n.children) {
    if (isText(c)) continue;
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

// Scroll reveals (Elementor/WOW/AOS pattern): content wrappers are `visibility:hidden`
// at load and revealed by an IntersectionObserver class swap applying entrance keyframes.
// The capture must (a) settle every reveal BEFORE any viewport snapshot so the clone never
// bakes hidden content, and (b) record the reveal as a motion spec so the clone re-hides
// and replays the entrance on scroll.
describe("scroll-reveal settling + replay capture (integration)", () => {
  let server: Server;
  let url = "";
  let outDir = "";
  let capture: CaptureResult;

  before(async () => {
    const html = readFileSync(join(FIXTURES, "reveal.html"), "utf8");
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    outDir = mkdtempSync(join(tmpdir(), "ditto-reveal-"));
    capture = await captureSite({
      url,
      outDir,
      viewports: VIEWPORTS,
      motion: true,
      breakpoints: false,
      screenshots: false,
    });
  });

  after(async () => {
    server?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("records the POST-REVEAL steady state at every viewport snapshot", () => {
    for (const vp of VIEWPORTS) {
      const snap = readJSON<PageSnapshot>(join(outDir, "capture", `dom-${vp}.json`));
      for (const id of ["reveal-io", "reveal-far"]) {
        const node = findById(snap.root, id)!;
        assert.ok(node, `#${id} captured at ${vp}`);
        assert.equal(node.visible, true, `#${id} visible at ${vp}`);
        assert.notEqual(node.computed.visibility, "hidden", `#${id} not baked hidden at ${vp}`);
        assert.equal(node.computed.animationName, "fadeInUp", `#${id} carries the library's revealed animation at ${vp}`);
        assert.ok(!node.attrs.class?.includes("elementor-invisible"), `#${id} pre-reveal marker cleared at ${vp}`);
      }
    }
  });

  it("never settles at a mid-fade frame (opacity is full after the entrance completes)", () => {
    for (const vp of VIEWPORTS) {
      const snap = readJSON<PageSnapshot>(join(outDir, "capture", `dom-${vp}.json`));
      for (const id of ["reveal-io", "reveal-far"]) {
        const node = findById(snap.root, id)!;
        assert.equal(parseFloat(node.computed.opacity ?? "1"), 1, `#${id} opacity settled at ${vp}`);
      }
    }
  });

  it("leaves genuinely hidden non-library content hidden (fidelity)", () => {
    for (const vp of VIEWPORTS) {
      const snap = readJSON<PageSnapshot>(join(outDir, "capture", `dom-${vp}.json`));
      const never = findById(snap.root, "never")!;
      assert.ok(never, `#never captured at ${vp}`);
      assert.equal(never.visible, false, `#never stays hidden at ${vp}`);
    }
  });

  it("captures both reveals as visibility-family motion specs with the entrance animation", () => {
    const reveals = capture.motion?.reveals ?? [];
    assert.equal(reveals.length, 2, `exactly the two reveal roots (got ${JSON.stringify(reveals)})`);
    for (const rv of reveals) {
      assert.equal(rv.visibility, "hidden");
      assert.equal(rv.animationName, "fadeInUp");
      assert.equal(rv.animationDuration, "0.4s");
      assert.equal(rv.animationDelay, "0s");
      assert.ok(rv.animationTiming, "timing function recorded");
      assert.equal(rv.transition, "", "visibility family carries no transition");
    }
  });

  it("threads the reveal specs into the generated motion spec (re-hide + replay)", () => {
    const ir = buildIR(outDir, VIEWPORTS);
    const spec = buildMotionSpec(ir, capture.motion);
    assert.equal(spec.reveals.length, 2, "both reveals resolve to surviving cids");
    for (const rv of spec.reveals) {
      assert.ok(rv.cid, "reveal mapped to a rendered cid");
      assert.equal(rv.visibility, "hidden");
      assert.equal(rv.animationName, "fadeInUp");
    }
    const jsx = motionWireJsx(spec, 0);
    assert.match(jsx, /<DittoMotion spec=/);
    assert.match(jsx, /"animationName":"fadeInUp"/);
    assert.match(jsx, /"visibility":"hidden"/);
  });

  it("DittoMotion re-hides via JS-applied visibility and replays the captured @keyframes", () => {
    // Initial hide is JS-applied (SSR/non-JS still shows content), entrance restarted on view.
    assert.match(DITTO_MOTION_TSX, /el\.style\.visibility = "hidden"/);
    assert.match(DITTO_MOTION_TSX, /el\.style\.animationName = rv\.animationName/);
    assert.match(DITTO_MOTION_TSX, /el\.style\.visibility = "visible"/);
    // Validator settle path reveals WITHOUT replaying (no mid-entrance graded frames).
    assert.match(DITTO_MOTION_TSX, /f\(false\)/);
  });

  // Fix 2 — reveal-replay stagger must not leave tiles unpainted. A long captured entrance
  // delay/duration replayed on scroll-into-view means a fast scroll / full-page screenshot
  // catches most tiles mid-entrance. The replay caps the delay + duration and force-settles
  // each tile shortly after it enters view, so tiles paint promptly and none stay hidden.
  it("caps the replayed entrance delay and duration", () => {
    // The animate path uses the clamp helpers rather than the raw captured values.
    assert.match(DITTO_MOTION_TSX, /el\.style\.animationDuration = clampDuration\(rv\.animationDuration\)/);
    assert.match(DITTO_MOTION_TSX, /el\.style\.animationDelay = clampDelay\(rv\.animationDelay\)/);
    // Caps are bounded (delay <= 300ms, duration <= 600ms).
    assert.match(DITTO_MOTION_TSX, /REVEAL_MAX_DELAY_MS = 300/);
    assert.match(DITTO_MOTION_TSX, /REVEAL_MAX_DURATION_MS = 600/);
  });

  it("force-settles each revealed tile per-element and settles everything at the failsafe", () => {
    // Per-element settle timer jumps a tile to its settled frame a bounded time after it animates
    // in (so it can't be caught mid-entrance regardless of WHEN it scrolled into view).
    assert.match(DITTO_MOTION_TSX, /settleTimers\.push\(setTimeout\(\(\) => f\(false\), settleAfter\)\)/);
    // Global failsafe settles (animate=false) rather than re-animating — nothing stays hidden.
    assert.match(DITTO_MOTION_TSX, /forceTimer = setTimeout\(\(\) => \{ for \(const f of revealed\) f\(false\); \}, 4000\)/);
  });
});
