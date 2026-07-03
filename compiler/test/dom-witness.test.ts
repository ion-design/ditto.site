import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IR, IRNode } from "../src/normalize/ir.js";
import type { PageSnapshot, RawNode } from "../src/capture/walker.js";
import { gate3bIrVsWitness, gate3cCloneVsWitness } from "../src/validate/domWitness.js";

const VP = 1280;

function raw(tag: string, text: string | null, children: RawNode[] = [], attrs: Record<string, string> = {}): RawNode {
  return {
    tag,
    attrs,
    computed: {},
    bbox: { x: 0, y: 0, w: 100, h: 40 },
    visible: true,
    children: text !== null ? [{ text }, ...children] : children,
  } as unknown as RawNode;
}

function snapshot(root: RawNode, scrollHeight = 800): PageSnapshot {
  return { doc: { scrollHeight, viewportWidth: VP }, root } as unknown as PageSnapshot;
}

function irNode(id: string, tag: string, text: string | null, children: IRNode[] = []): IRNode {
  return {
    id,
    tag,
    attrs: {},
    visibleByVp: { [VP]: true },
    bboxByVp: { [VP]: { x: 0, y: 0, width: 100, height: 40 } },
    computedByVp: { [VP]: {} },
    children: text !== null ? [{ text }, ...children] : children,
  } as unknown as IRNode;
}

function fixtureIr(root: IRNode): IR {
  return {
    doc: { canonicalViewport: VP, viewports: [VP], sampleViewports: [VP], nodeCount: 3, keyframes: [] },
    root,
  } as unknown as IR;
}

const dir = mkdtempSync(join(tmpdir(), "witness-gate-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function writeCaptureDom(snap: PageSnapshot): string {
  mkdirSync(join(dir, "capture"), { recursive: true });
  writeFileSync(join(dir, "capture", `dom-${VP}.json`), JSON.stringify(snap));
  return dir;
}

describe("gate3bIrVsWitness", () => {
  it("passes when the IR mirrors the capture snapshot", () => {
    writeCaptureDom(snapshot(raw("body", null, [raw("main", null, [raw("h1", "Hello witness world"), raw("p", "Some paragraph text here")])])));
    const ir = fixtureIr(irNode("n0", "body", null, [irNode("n1", "main", null, [irNode("n2", "h1", "Hello witness world"), irNode("n3", "p", "Some paragraph text here")])]));
    const res = gate3bIrVsWitness(ir, dir, [VP]);
    assert.equal(res.pass, true, JSON.stringify(res));
    assert.equal(res.metrics.matchPct, 1);
    assert.equal(res.metrics.textPct, 1);
  });

  it("fails on invented IR structure and text", () => {
    writeCaptureDom(snapshot(raw("body", null, [raw("p", "only this text")])));
    const ir = fixtureIr(
      irNode("n0", "body", null, [
        irNode("n1", "p", "only this text"),
        ...Array.from({ length: 60 }, (_, i) => irNode(`x${i}`, "section", "text never captured anywhere")),
      ]),
    );
    const res = gate3bIrVsWitness(ir, dir, [VP]);
    assert.equal(res.pass, false);
  });
});

describe("gate3cCloneVsWitness", () => {
  it("checks witness text presence against the rendered clone (cid-indexed)", () => {
    writeCaptureDom(snapshot(raw("body", null, [raw("h1", "Visible headline text")])));
    const genOk = snapshot(raw("body", null, [raw("h1", "Visible headline text", [], { "data-cid": "n1" })], { "data-cid": "n0" }));
    const ok = gate3cCloneVsWitness({ [VP]: genOk }, dir, [VP]);
    assert.equal(ok.pass, true, JSON.stringify(ok));
    assert.ok((ok.metrics.textTotal as number) >= 1, "gate must actually check text (not vacuous)");

    const genBad = snapshot(raw("body", null, [raw("h1", "Different words entirely", [], { "data-cid": "n1" })], { "data-cid": "n0" }));
    const bad = gate3cCloneVsWitness({ [VP]: genBad }, dir, [VP]);
    assert.equal(bad.pass, false);
  });
});
