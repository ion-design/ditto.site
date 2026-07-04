import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawNode, RawChild } from "../src/capture/walker.js";
import { buildIR, isTextChild, type IR, type IRNode } from "../src/normalize/ir.js";
import { collectNodeRules } from "../src/generate/css.js";

// Per-viewport DOM divergence handling:
//  • GRAFT — a child that exists ONLY at non-canonical viewports enters the IR as a sibling at
//    its source position, carrying per-viewport data only for the widths it appeared at, and is
//    emitted display:none at base + revealed in its band(s).
//  • DRIFT — a container whose children are a wholly DIFFERENT SET at some viewport (content
//    identity drift) is NOT grafted (no duplication); the canonical children stand in at that
//    width (the display:none banding is skipped) and the divergence is recorded in
//    doc.contentDrift for the manifest.

function raw(tag: string, attrs: Record<string, string> = {}, children: RawChild[] = [], visible = true, computedOver: Record<string, string> = {}): RawNode {
  return {
    tag, attrs,
    computed: { display: visible ? "block" : "none", position: "static", visibility: "visible", ...computedOver },
    bbox: { x: 0, y: 0, width: visible ? 640 : 0, height: visible ? 360 : 0 },
    visible,
    children,
  };
}

function snapshot(vp: number, root: RawNode): object {
  return {
    doc: {
      url: "https://example.test/page", title: "Fixture",
      head: { description: "", canonical: "", ogTitle: "", ogDescription: "", ogImage: "", ogType: "", ogSiteName: "", twitterCard: "", themeColor: "" },
      lang: "en", charset: "UTF-8", viewportWidth: vp, viewportHeight: 800,
      scrollWidth: vp, scrollHeight: 800, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)",
      bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial", metaViewport: "width=device-width, initial-scale=1",
      nodeCount: 10, truncated: false,
    },
    root, cssVars: {}, fontFaces: [], cssUrls: [], domAssets: [], keyframes: [],
  };
}

/** Build an IR from a DIFFERENT raw body tree per viewport. */
function buildDivergentIR(rootByVp: Record<number, RawNode>): IR {
  const vps = Object.keys(rootByVp).map(Number).sort((a, b) => a - b);
  const sourceDir = mkdtempSync(join(tmpdir(), "ditto-ir-graft-"));
  mkdirSync(join(sourceDir, "capture"), { recursive: true });
  for (const vp of vps) {
    writeFileSync(join(sourceDir, "capture", `dom-${vp}.json`), JSON.stringify(snapshot(vp, rootByVp[vp]!)));
  }
  return buildIR(sourceDir, vps);
}

function findByTag(node: IRNode, tag: string): IRNode | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

function elemChildren(node: IRNode): IRNode[] {
  return node.children.filter((c): c is IRNode => !isTextChild(c));
}

// ---- fixtures ----

/** Carousel whose pagination (ul + 3 bullet li) exists ONLY below the canonical width. */
function carouselFixture(): { small: RawNode; large: RawNode } {
  const track = (): RawNode => raw("div", { id: "track" });
  const pagination = (): RawNode =>
    raw("ul", { id: "pagination" }, [
      raw("li", {}, [raw("button", { type: "button" }, [{ text: "1" }])]),
      raw("li", {}, [raw("button", { type: "button" }, [{ text: "2" }])]),
      raw("li", {}, [raw("button", { type: "button" }, [{ text: "3" }])]),
    ]);
  const small = raw("body", {}, [raw("section", { id: "carousel" }, [track(), pagination()])]);
  const large = raw("body", {}, [raw("section", { id: "carousel" }, [track()])]);
  return { small, large };
}

/** Container serving a DIFFERENT item set per viewport (content identity drift). */
function driftFixture(): { small: RawNode; large: RawNode } {
  const item = (id: string): RawNode => raw("li", { id }, [raw("span", {}, [{ text: `Item ${id}` }])]);
  const small = raw("body", {}, [raw("ul", { id: "rotator" }, [item("b1"), item("b2"), item("b3"), item("b4")])]);
  const large = raw("body", {}, [raw("ul", { id: "rotator" }, [item("a1"), item("a2"), item("a3"), item("a4")])]);
  return { small, large };
}

describe("IR grafts non-canonical-only children", () => {
  it("grafts a subtree present only at 375 into the canonical tree at its source position", () => {
    const { small, large } = carouselFixture();
    const ir = buildDivergentIR({ 375: small, 1280: large });

    const section = findByTag(ir.root, "section")!;
    const kids = elemChildren(section);
    assert.deepEqual(kids.map((k) => k.tag), ["div", "ul"], "pagination grafted after the matched track");

    const ul = kids[1]!;
    assert.equal(ul.attrs.id, "pagination");
    // Per-viewport data ONLY at the source viewport — nothing invented at canonical.
    assert.deepEqual(Object.keys(ul.computedByVp), ["375"]);
    assert.equal(ul.visibleByVp[375], true);
    assert.equal(ul.computedByVp[1280], undefined);
    assert.equal(ul.bboxByVp[1280], undefined);
    // The grafted subtree's descendants carry the same viewport-scoped data.
    const bullets = elemChildren(ul);
    assert.equal(bullets.length, 3);
    for (const li of bullets) {
      assert.deepEqual(Object.keys(li.computedByVp), ["375"]);
      const btn = elemChildren(li)[0]!;
      assert.equal(btn.tag, "button");
      assert.deepEqual(Object.keys(btn.computedByVp), ["375"]);
    }
    // No drift recorded — this is an additive responsive difference, not a set swap.
    assert.equal(section.childDriftVps, undefined);
    assert.equal(ir.doc.contentDrift, undefined);
  });

  it("merges the same non-canonical-only child across several viewports into ONE grafted node", () => {
    const { small, large } = carouselFixture();
    const ir = buildDivergentIR({ 375: small, 768: structuredClone(small), 1280: large });

    const section = findByTag(ir.root, "section")!;
    const uls = elemChildren(section).filter((k) => k.tag === "ul");
    assert.equal(uls.length, 1, "one grafted node, not one per viewport");
    assert.deepEqual(Object.keys(uls[0]!.computedByVp).map(Number).sort((a, b) => a - b), [375, 768]);
  });

  it("is deterministic: two builds from the same capture are byte-identical", () => {
    const { small, large } = carouselFixture();
    const a = buildDivergentIR({ 375: small, 1280: large });
    const b = buildDivergentIR({ 375: structuredClone(small), 1280: structuredClone(large) });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("does not graft a child that never paints at any band viewport", () => {
    const { small, large } = carouselFixture();
    // Make the whole pagination subtree invisible at 375.
    const section = small.children[0] as RawNode;
    const pag = (section.children as RawNode[]).find((c) => c.tag === "ul")!;
    const markInvisible = (n: RawNode): void => {
      n.visible = false; n.computed.display = "none"; n.bbox = { x: 0, y: 0, width: 0, height: 0 };
      for (const c of n.children) if ((c as RawNode).tag) markInvisible(c as RawNode);
    };
    markInvisible(pag);
    const ir = buildDivergentIR({ 375: small, 1280: large });
    assert.equal(findByTag(ir.root, "ul"), null, "invisible-everywhere subtree is not grafted");
  });
});

describe("IR whole-set content drift falls back to faithful-at-canonical", () => {
  it("records drift instead of grafting when both sides mutually mismatch", () => {
    const { small, large } = driftFixture();
    const ir = buildDivergentIR({ 375: small, 1280: large });

    const rotator = findByTag(ir.root, "ul")!;
    const kids = elemChildren(rotator);
    // Canonical set only — the divergent 375 set is NOT grafted (no duplication).
    assert.deepEqual(kids.map((k) => k.attrs.id), ["a1", "a2", "a3", "a4"]);
    assert.deepEqual(rotator.childDriftVps, [375]);
    // Canonical children carry no invented data at the drift viewport.
    for (const k of kids) assert.equal(k.computedByVp[375], undefined);
    // Surfaced for the manifest, with the final (post-renumber) id.
    assert.deepEqual(ir.doc.contentDrift, [{ id: rotator.id, tag: "ul", viewports: [375] }]);
  });

  it("does not misread an additive difference as drift", () => {
    // Canonical set fully matches at 375; 375 merely has extras → graft path, no drift.
    const item = (id: string): RawNode => raw("li", { id });
    const small = raw("body", {}, [raw("ul", { id: "list" }, [item("x1"), item("x2"), item("e1"), item("e2"), item("e3")])]);
    const large = raw("body", {}, [raw("ul", { id: "list" }, [item("x1"), item("x2")])]);
    const ir = buildDivergentIR({ 375: small, 1280: large });
    const list = findByTag(ir.root, "ul")!;
    assert.equal(list.childDriftVps, undefined);
    assert.deepEqual(elemChildren(list).map((k) => k.attrs.id), ["x1", "x2", "e1", "e2", "e3"]);
    assert.deepEqual(Object.keys(elemChildren(list)[2]!.computedByVp), ["375"]);
  });
});

describe("emission of grafted and drift nodes", () => {
  it("emits a grafted node as display:none at base with a full reveal band at its viewport", () => {
    const { small, large } = carouselFixture();
    const ir = buildDivergentIR({ 375: small, 1280: large });
    const ul = findByTag(ir.root, "ul")!;
    const rules = collectNodeRules(ir, new Map());
    const nr = rules.get(ul.id)!;
    assert.deepEqual([...nr.base.entries()], [["display", "none"]], "hidden at the canonical base");
    assert.equal(nr.bands.length, 1, "exactly one band: the reveal at its source viewport");
    const band = nr.bands[0]!;
    assert.match(band.media, /max-width/);
    assert.equal(band.decls.get("display"), "block", "the band reveals AND lays out the node");
  });

  it("skips the display:none band for drift stand-ins (and their descendants), keeps it otherwise", () => {
    const { small, large } = driftFixture();
    // Control: a genuinely canonical-only sibling (absent at 375, NOT under a drift container)
    // must still be banded display:none at 375.
    (large.children as RawNode[]).push(raw("aside", { id: "desktop-only" }, [{ text: "Desktop" }]));
    const ir = buildDivergentIR({ 375: small, 1280: large });
    const rules = collectNodeRules(ir, new Map());

    const rotator = findByTag(ir.root, "ul")!;
    for (const li of elemChildren(rotator)) {
      const nr = rules.get(li.id)!;
      assert.equal(nr.bands.some((b) => b.decls.get("display") === "none"), false, `stand-in ${li.attrs.id} not hidden at the drift viewport`);
      // Descendants of the stand-in subtree are not hidden either.
      const span = elemChildren(li)[0]!;
      const snr = rules.get(span.id)!;
      assert.equal(snr.bands.some((b) => b.decls.get("display") === "none"), false, "stand-in descendant not hidden");
    }

    const aside = findByTag(ir.root, "aside")!;
    const anr = rules.get(aside.id)!;
    assert.equal(anr.bands.some((b) => b.decls.get("display") === "none"), true, "unrelated canonical-only node still hidden per band");
  });
});
