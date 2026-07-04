import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { PseudoStateRule } from "../src/capture/capture.js";
import { generatePseudoStateCss } from "../src/generate/pseudoStates.js";

function el(id: string, tag: string, attrs: Record<string, string> = {}, children: IRNode[] = []): IRNode {
  return {
    id, tag, attrs,
    visibleByVp: { 1280: true },
    bboxByVp: { 1280: { x: 0, y: 0, w: 10, h: 10 } },
    computedByVp: { 1280: {} },
    children,
  } as unknown as IRNode;
}

function fixtureIr(root: IRNode): IR {
  return { doc: { canonicalViewport: 1280, viewports: [1280], sampleViewports: [1280], nodeCount: 3, keyframes: [] }, root } as unknown as IR;
}

describe("generatePseudoStateCss", () => {
  const ir = fixtureIr(
    el("n0", "body", {}, [
      el("n1", "a", { "data-cid-cap": "ps0" }),
      el("n2", "button", { "data-cid-cap": "ps1" }),
    ]),
  );

  it("maps capIds to cids and emits scoped pseudo rules in capture order", () => {
    const rules: PseudoStateRule[] = [
      { capId: "ps0", pseudo: "hover", decls: { color: "rgb(255, 0, 0)", "text-decoration-line": "underline" } },
      { capId: "ps1", pseudo: "focus-visible", media: "(min-width: 768px)", decls: { "outline-color": "blue" } },
    ];
    const css = generatePseudoStateCss(ir, rules);
    assert.ok(css.includes(`[data-cid="n1"]:hover { color: rgb(255, 0, 0); text-decoration-line: underline; }`), css);
    assert.ok(css.includes(`@media (min-width: 768px) { [data-cid="n2"]:focus-visible { outline-color: blue; } }`), css);
    assert.ok(css.indexOf("n1") < css.indexOf("n2"), "capture (cascade) order preserved");
  });

  it("skips rules whose element was pruned from the IR and returns empty when nothing maps", () => {
    const rules: PseudoStateRule[] = [{ capId: "ps-gone", pseudo: "hover", decls: { color: "red" } }];
    assert.equal(generatePseudoStateCss(ir, rules), "");
    assert.equal(generatePseudoStateCss(ir, undefined), "");
    assert.equal(generatePseudoStateCss(ir, []), "");
  });

  it("is deterministic for identical inputs", () => {
    const rules: PseudoStateRule[] = [{ capId: "ps0", pseudo: "hover", decls: { opacity: "0.8" } }];
    assert.equal(generatePseudoStateCss(ir, rules), generatePseudoStateCss(ir, rules));
  });
});
