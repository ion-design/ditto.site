import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSections, detectSectionNodes } from "../src/infer/sections.js";
import { planSections } from "../src/generate/sectionSplit.js";
import type { IR, IRNode, IRChild } from "../src/normalize/ir.js";

const CW = 1280;

type Box = { x?: number; y: number; width?: number; height: number };

/** An element node at the canonical viewport (ids assigned later in pre-order). */
function el(tag: string, box: Box, children: IRChild[] = [], display = "block"): IRNode {
  return {
    id: "",
    tag,
    attrs: {},
    visibleByVp: { [CW]: true },
    bboxByVp: { [CW]: { x: box.x ?? 0, y: box.y, width: box.width ?? CW, height: box.height } },
    computedByVp: { [CW]: { display } },
    children,
  };
}

function text(t: string): IRChild {
  return { text: t };
}

/** Wrap children in a <body> root and assign stable pre-order ids (n0, n1, …). */
function page(children: IRNode[], pageH: number): IR {
  const root = el("body", { y: 0, height: pageH }, children);
  let i = 0;
  const assign = (n: IRNode): void => {
    n.id = `n${i++}`;
    for (const c of n.children) if ((c as IRNode).tag) assign(c as IRNode);
  };
  assign(root);
  return {
    doc: {
      sourceUrl: "https://example.test/", title: "Fixture", lang: "en", charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: [CW], sampleViewports: [CW], canonicalViewport: CW,
      perViewport: { [CW]: { scrollHeight: pageH, scrollWidth: CW, htmlBg: "", bodyBg: "", bodyColor: "", bodyFont: "" } },
      nodeCount: i, keyframes: [],
    },
    root,
  };
}

/** A content band with a heading (so section naming has honest evidence). Bands get
 *  `variant` extra paragraphs so adjacent one-off sections differ structurally — the
 *  repeated-run filter (≥3 identical signatures → component cluster) must not fire. */
function band(y: number, height: number, heading: string, variant = 0): IRNode {
  const extras: IRNode[] = [];
  for (let k = 0; k <= variant % 7; k++) {
    extras.push(el("p", { y: y + 80 + k * 30, height: 24, x: 120, width: 600 }, [text(`Body copy ${k}`)]));
  }
  return el("section", { y, height }, [
    el("h2", { y: y + 24, height: 40, x: 120, width: 600 }, [text(heading)]),
    ...extras,
  ]);
}

/** navbar(62) + hero(800) + 3 bands + footer(400), flat under body. */
function sixBandPage(): IR {
  const nav = el("nav", { y: 0, height: 62 });
  const hero = el("section", { y: 62, height: 800 }, [
    el("h1", { y: 120, height: 60, x: 120, width: 900 }, [text("Ship faster with widgets")]),
  ]);
  const b1 = band(862, 600, "Trusted by teams", 0);
  const b2 = band(1462, 700, "Everything you need", 1);
  const b3 = band(2162, 500, "What customers say", 2);
  const footer = el("footer", { y: 2662, height: 400 }, [
    el("a", { y: 2700, height: 20, x: 120, width: 200, }, [text("Privacy")], "inline"),
  ]);
  return page([nav, hero, b1, b2, b3, footer], 3062);
}

/** Same bands, but body > div#root > (nav + main(13 bands) + footer) — the real-site shape. */
function wrappedPage(bandCount = 13): IR {
  const nav = el("nav", { y: 0, height: 62 });
  const bandH = 900;
  const bands: IRNode[] = [];
  for (let k = 0; k < bandCount; k++) {
    bands.push(k === 0
      ? el("section", { y: 62, height: bandH }, [el("h1", { y: 100, height: 60, x: 120, width: 900 }, [text("Design your future")])])
      : band(62 + k * bandH, bandH, `Feature area ${k}`, k));
  }
  const mainH = bandCount * bandH;
  const main = el("main", { y: 62, height: mainH }, bands);
  const footer = el("footer", { y: 62 + mainH, height: 400 });
  const pageH = 62 + mainH + 400;
  const wrapper = el("div", { y: 0, height: pageH }, [nav, main, footer]);
  return page([wrapper], pageH);
}

describe("section decomposition (recursive descent)", () => {
  it("splits navbar + hero + 3 bands + footer into 6 sections", () => {
    const ir = sixBandPage();
    const sections = detectSections(ir);
    assert.equal(sections.length, 6);
    assert.equal(sections[0]!.role, "navbar");
    assert.equal(sections[1]!.role, "hero");
    assert.equal(sections[5]!.role, "footer");
    // the 62px navbar (below the old 64px bar) is still the navbar
    assert.equal(sections[0]!.bboxByVp[CW]!.height, 62);
  });

  it("descends body > div > main wrappers to the real bands", () => {
    const ir = wrappedPage(13);
    const sections = detectSections(ir);
    assert.equal(sections.length, 15); // nav + 13 bands + footer
    assert.equal(sections[0]!.role, "navbar");
    assert.equal(sections[1]!.role, "hero");
    assert.equal(sections[14]!.role, "footer");
    // no wrapper survives as a section
    const tags = new Set(detectSectionNodes(ir).map((n) => n.tag));
    assert.ok(!tags.has("main") && !tags.has("body") && !tags.has("div"));
  });

  it("sections tile the page top-to-bottom without gaps or overlaps", () => {
    const ir = wrappedPage(13);
    const boxes = detectSections(ir).map((s) => s.bboxByVp[CW]!).sort((a, b) => a.y - b.y);
    const pageH = ir.doc.perViewport[CW]!.scrollHeight;
    let cursor = 0;
    for (const b of boxes) {
      assert.ok(Math.abs(b.y - cursor) <= 8, `gap/overlap at y=${b.y} (expected ~${cursor})`);
      cursor = b.y + b.height;
    }
    assert.ok(pageH - cursor <= 8, `uncovered tail: ${pageH - cursor}px`);
  });

  it("keeps a single-band page as one section (degenerate stays legal)", () => {
    const inner = el("div", { y: 100, height: 300, x: 320, width: 640 });
    const only = el("div", { y: 0, height: 800 }, [inner]);
    const ir = page([only], 800);
    const sections = detectSections(ir);
    assert.equal(sections.length, 1);
  });

  it("does not split side-by-side columns or overlaid layers", () => {
    // two full-width overlapping layers inside a page-covering wrapper
    const a = el("div", { y: 100, height: 1900 });
    const b = el("div", { y: 100, height: 1900 });
    const wrapper = el("div", { y: 100, height: 1900 }, [a, b]);
    const nav = el("nav", { y: 0, height: 100 });
    const ir = page([nav, wrapper], 2000);
    const sections = detectSections(ir);
    assert.equal(sections.length, 2); // nav + the wrapper, unsplit
  });

  it("does not descend when children leave large coverage gaps", () => {
    // one small band inside a page-covering container: splitting would drop content
    const lone = band(0, 300, "Only child");
    const container = el("div", { y: 0, height: 2000 }, [lone]);
    const ir = page([container], 2000);
    assert.equal(detectSections(ir).length, 1);
  });

  it("keeps a 62px fixed div-wrapped navbar as its own band (nav evidence beats the 64px bar)", () => {
    // real-site shape: hero at y=0, a thin fixed bar (styled div, real <nav> nested
    // narrow inside) floating over it
    const navInner = el("nav", { y: 12, height: 62, x: 700, width: 454 });
    const bar = el("div", { y: 12, height: 62 }, [el("div", { y: 12, height: 62 }, [navInner])]);
    const hero = el("section", { y: 0, height: 800 }, [
      el("h1", { y: 200, height: 60, x: 120, width: 900 }, [text("We recruit designers")]),
    ]);
    const b1 = band(800, 700, "Our mission", 1);
    const b2 = band(1500, 900, "Services", 2);
    const footer = el("footer", { y: 2400, height: 300 });
    const ir = page([hero, bar, b1, b2, footer], 2700);
    const sections = detectSections(ir);
    assert.equal(sections.length, 5);
    assert.equal(sections[0]!.role, "hero"); // y=0 sorts before the bar at y=12
    assert.equal(sections[1]!.role, "navbar");
    const names = [...planSections(ir).roots.values()];
    assert.ok(names.includes("Navbar"), `expected Navbar in ${names.join(", ")}`);
  });

  it("is deterministic: same capture, byte-identical sections", () => {
    const a = JSON.stringify(detectSections(wrappedPage(13)));
    const b = JSON.stringify(detectSections(wrappedPage(13)));
    assert.equal(a, b);
  });
});

describe("section component planning (emission roots + names)", () => {
  it("names one component per band: Navbar, HeroSection, content sections, Footer", () => {
    const ir = sixBandPage();
    const plan = planSections(ir);
    const names = [...plan.roots.values()];
    assert.equal(names.length, 6);
    assert.equal(names[0], "Navbar");
    assert.equal(names[1], "HeroSection");
    assert.equal(names[5], "Footer");
    assert.ok(names.includes("TrustedByTeamsSection"));
    assert.ok(names.includes("WhatCustomersSaySection"));
    assert.equal(new Set(names).size, 6, "names are unique");
  });

  it("plans a component per band through body > div > main wrappers", () => {
    const plan = planSections(wrappedPage(13));
    assert.equal(plan.roots.size, 15);
    const names = [...plan.roots.values()];
    assert.equal(names[0], "Navbar");
    assert.equal(names[1], "HeroSection");
    assert.equal(names[14], "Footer");
  });

  it("falls back to evidence names for bands without headings", () => {
    const nav = el("nav", { y: 0, height: 62 });
    const hero = el("section", { y: 62, height: 800 }, [
      el("h1", { y: 120, height: 60, x: 120, width: 900 }, [text("Hello")]),
    ]);
    const formBand = el("section", { y: 862, height: 500 }, [
      el("form", { y: 900, height: 200, x: 320, width: 640 }),
    ]);
    const mediaBand = el("section", { y: 1362, height: 500 }, [
      el("video", { y: 1400, height: 400, x: 160, width: 960 }),
    ]);
    const footer = el("footer", { y: 1862, height: 300 });
    const ir = page([nav, hero, formBand, mediaBand, footer], 2162);
    const names = [...planSections(ir).roots.values()];
    assert.ok(names.includes("ContactSection"), `expected ContactSection in ${names.join(", ")}`);
    assert.ok(names.includes("MediaSection"), `expected MediaSection in ${names.join(", ")}`);
  });

  it("leaves a page with too few bands unsplit (no monolithic 'hero' misnomer)", () => {
    const only = el("div", { y: 0, height: 800 }, [el("div", { y: 100, height: 300, x: 320, width: 640 })]);
    const plan = planSections(page([only], 800));
    assert.equal(plan.roots.size, 0);
  });

  it("is deterministic across runs", () => {
    const a = JSON.stringify([...planSections(wrappedPage(13)).roots.entries()]);
    const b = JSON.stringify([...planSections(wrappedPage(13)).roots.entries()]);
    assert.equal(a, b);
  });
});
