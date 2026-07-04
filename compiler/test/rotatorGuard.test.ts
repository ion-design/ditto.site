import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { MotionCapture } from "../src/capture/motion.js";
import { captureMotion } from "../src/capture/motion.js";
import { buildMotionSpec, DITTO_MOTION_TSX } from "../src/generate/motion.js";

// A rotator cycles the text of a single LEAF word/phrase. A container that bears element
// children must never be treated as a rotator: the runtime replaces its content on each swap,
// so classifying a structural panel as a rotator would flatten its whole subtree to one text
// node. This regression guards all three defense layers against that misclassification.

// ---- Minimal IR factory (only the fields buildMotionSpec reads: id, attrs, children) ----
function node(id: string, cap: string | null, children: IRNode[] = [], text?: string): IRNode {
  const kids = text !== undefined ? ([{ text }] as unknown as IRNode[]) : children;
  return {
    id,
    tag: "div",
    attrs: cap !== null ? { "data-cid-cap": cap } : {},
    visibleByVp: {},
    bboxByVp: {},
    computedByVp: {},
    children: kids,
  } as unknown as IRNode;
}

function ir(root: IRNode): IR {
  return { doc: { canonicalViewport: 1280 } as unknown as IR["doc"], root };
}

function motionWith(rotators: MotionCapture["rotators"]): MotionCapture {
  return { waapi: [], rotators, reveals: [], marquees: [] };
}

describe("rotator misclassification guard — layer 1 (emission)", () => {
  it("emits a rotator whose target is a genuine text leaf (no element children)", () => {
    const tree = ir(node("n0", null, [node("n1", "5", [], "Design")]));
    const spec = buildMotionSpec(tree, motionWith([{ cap: "5", texts: ["Design", "Build"], intervalMs: 900 }]));
    assert.equal(spec.rotators.length, 1, "leaf rotator survives emission");
    assert.equal(spec.rotators[0]!.cid, "n1");
  });

  it("DROPS a rotator whose target IR node has element children (structural container)", () => {
    // n1 is capped and was classified as a rotator, but it holds real element rows (n2, n3).
    const container = node("n1", "5", [
      node("n2", null, [], "row one"),
      node("n3", null, [], "row two"),
    ]);
    const tree = ir(node("n0", null, [container]));
    const spec = buildMotionSpec(tree, motionWith([{ cap: "5", texts: ["a", "b"], intervalMs: 240 }]));
    assert.equal(spec.rotators.length, 0, "element-bearing container is not emitted as a rotator");
  });

  it("keeps genuine leaf rotators while dropping a sibling container in the same spec", () => {
    const tree = ir(node("n0", null, [
      node("n1", "5", [], "Design"), // genuine leaf
      node("n2", "6", [node("n3", null, [], "row")]), // container → dropped
    ]));
    const spec = buildMotionSpec(tree, motionWith([
      { cap: "5", texts: ["Design", "Build"], intervalMs: 900 },
      { cap: "6", texts: ["x", "y"], intervalMs: 240 },
    ]));
    assert.equal(spec.rotators.length, 1);
    assert.equal(spec.rotators[0]!.cid, "n1");
  });
});

describe("rotator misclassification guard — layer 3 (non-destructive runtime)", () => {
  it("saves & restores the target's child NODES, never a flattened textContent string", () => {
    // Save path: the original child nodes are cloned (structure preserved), not read as a string.
    assert.match(DITTO_MOTION_TSX, /Array\.from\(el\.childNodes\)\.map\(\(n\) => n\.cloneNode\(true\)\)/);
    // Restore path: rebuild via replaceChildren with cloned nodes — no `textContent = r.original`.
    assert.match(DITTO_MOTION_TSX, /r\.el\.replaceChildren\(\.\.\.r\.original\.map\(\(n\) => n\.cloneNode\(true\)\)\)/);
    assert.doesNotMatch(DITTO_MOTION_TSX, /r\.el\.textContent = r\.original/, "no lossy textContent restore remains");
  });

  it("refuses to install a rotator on an element that has element children at runtime", () => {
    assert.match(DITTO_MOTION_TSX, /if \(el\.childElementCount > 0\) continue;/);
  });
});

describe("rotator misclassification guard — layer 2 (capture leaf guard)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  after(async () => {
    await browser.close();
  });

  it("does not record an element-bearing container (runtime-injected uncapped rows) as a rotator", async () => {
    // #panel is capped BEFORE its rows are injected (mirrors cid-cap tagging preceding the site's
    // late row appends). Its rows are uncapped. #word is a genuine capped leaf cycling text.
    await page.setContent(`<!doctype html><html><body>
      <div id="panel" data-cid-cap="10"></div>
      <span id="word" data-cid-cap="11">Design</span>
      <script>
        var glyphs = ["\\u2b22", "\\u2b21"], gi = 0;
        var panel = document.getElementById("panel"), rows = 0;
        // Append real (uncapped) element rows over time, and toggle a glyph inside them.
        setInterval(function () {
          if (rows < 4) {
            var r = document.createElement("div");
            r.className = "row";
            r.innerHTML = '<span class="g">' + glyphs[gi % 2] + '</span> line ' + rows;
            panel.appendChild(r); rows++;
          } else {
            gi++;
            var gs = panel.querySelectorAll(".g");
            for (var k = 0; k < gs.length; k++) gs[k].textContent = glyphs[gi % 2];
          }
        }, 120);
        // #word: a genuine leaf whose text content cycles.
        var words = ["Design", "Build", "Ship"], wi = 0, w = document.getElementById("word");
        setInterval(function () { wi = (wi + 1) % words.length; w.textContent = words[wi]; }, 200);
      </script>
    </body></html>`);
    // tsx/esbuild names the evaluated function; provide the helper it references in-page.
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    const motion = await captureMotion(page, { observeMs: 1600 });
    const caps = new Set(motion.rotators.map((r) => r.cap));
    assert.ok(!caps.has("10"), "element-bearing panel is NOT recorded as a rotator");
    assert.ok(caps.has("11"), "genuine leaf word IS recorded as a rotator");
  });
});
