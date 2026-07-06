import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadPatternIndex,
  assertPinnedCatalog,
  resolvePatternHints,
  matchCatalogNode,
} from "../src/knowledge/patternIndex.js";
import { planForFrameUrl } from "../src/capture/graft.js";
import type { IR, IRNode, IRChild } from "../src/normalize/ir.js";

const CW = 1280;
const LOCK_PATH = fileURLToPath(new URL("../data/pattern-catalog.lock", import.meta.url));

/** Element node at the canonical viewport (ids assigned in pre-order by `page`). */
function el(
  tag: string,
  opts: { srcClass?: string; attrs?: Record<string, string>; children?: IRChild[] } = {},
): IRNode {
  return {
    id: "",
    tag,
    attrs: opts.attrs ?? {},
    srcClass: opts.srcClass,
    visibleByVp: { [CW]: true },
    bboxByVp: { [CW]: { x: 0, y: 0, width: CW, height: 100 } },
    computedByVp: { [CW]: { display: "block" } },
    children: opts.children ?? [],
  };
}

/** Wrap children in a <body> root and assign stable pre-order ids (n0, n1, …). */
function page(children: IRNode[]): IR {
  const root = el("body", { children });
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
      perViewport: { [CW]: { scrollHeight: 100, scrollWidth: CW, htmlBg: "", bodyBg: "", bodyColor: "", bodyFont: "" } },
      nodeCount: i, keyframes: [],
    },
    root,
  };
}

describe("pattern catalog: load + pin", () => {
  it("loads the frozen catalog and pins by sha256 (lock verifies)", () => {
    const idx = loadPatternIndex();
    assert.equal(idx.catalog.version, 1);
    assert.ok(idx.catalog.patterns.length > 0, "catalog has patterns");
    // The on-disk lock must equal the catalog's live hash — no throw.
    assert.doesNotThrow(() => assertPinnedCatalog());
    const pinned = readFileSync(LOCK_PATH, "utf8").trim();
    assert.equal(pinned, idx.hash, "lock matches catalog hash");
  });
});

describe("pattern catalog: integrity check throws unconditionally", () => {
  const original = readFileSync(LOCK_PATH, "utf8");
  afterEach(() => {
    // Always restore the real lock so later tests / runs see the pinned hash.
    writeFileSync(LOCK_PATH, original);
  });

  it("throws on a lock/catalog hash mismatch (no env-var escape hatch)", () => {
    writeFileSync(LOCK_PATH, "deadbeef".repeat(8) + "\n");
    assert.throws(() => assertPinnedCatalog(), /hash mismatch/);
    // Restoring must make it pass again.
    writeFileSync(LOCK_PATH, original);
    assert.doesNotThrow(() => assertPinnedCatalog());
  });
});

describe("pattern catalog: fingerprint fixtures hit", () => {
  it("matchCatalogNode identifies a generic carousel fingerprint by class token", () => {
    const hits = matchCatalogNode({ tag: "div", attrs: {}, srcClass: "swiper swiper-wrapper" });
    assert.deepEqual(hits.map((h) => h.id), ["carousel_swiper"]);
    assert.equal(hits[0].kind, "carousel");
  });

  it("matchCatalogNode identifies a platform fingerprint by class prefix", () => {
    const hits = matchCatalogNode({ tag: "div", attrs: {}, srcClass: "elementor-widget-container" });
    assert.ok(hits.some((h) => h.id === "platform_elementor"), "elementor prefix hit");
  });

  it("matchCatalogNode identifies a scroll-animation fingerprint by attribute presence", () => {
    const hits = matchCatalogNode({ tag: "div", attrs: { "data-aos": "fade-up" }, srcClass: undefined });
    assert.ok(hits.some((h) => h.id === "anim_aos"), "data-aos attr hit");
  });

  it("resolvePatternHints walks the IR deterministically and records id + cid evidence", () => {
    const ir = page([
      el("div", { srcClass: "swiper", children: [el("div", { srcClass: "swiper-slide" })] }),
      el("div", { srcClass: "swiper-slide" }),
    ]);
    const hints = resolvePatternHints(ir);
    const swiper = hints.matches.find((m) => m.id === "carousel_swiper");
    assert.ok(swiper, "swiper detected");
    // Three nodes carried a swiper token → count 3, cids are pre-order node ids.
    assert.equal(swiper!.count, 3);
    assert.deepEqual(swiper!.cids, ["n1", "n2", "n3"]);
    // matches are sorted by id → deterministic evidence ordering.
    const ids = hints.matches.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
    // Same catalog + same IR ⇒ byte-identical hints.
    assert.deepEqual(resolvePatternHints(page([
      el("div", { srcClass: "swiper", children: [el("div", { srcClass: "swiper-slide" })] }),
      el("div", { srcClass: "swiper-slide" }),
    ])), hints);
  });

  it("resolvePatternHints exposes platform flags (stripped) and simpleStatic", () => {
    const ir = page([el("section", { srcClass: "shopify-section" })]);
    const hints = resolvePatternHints(ir);
    assert.ok(hints.platforms.includes("shopify"), "shopify platform surfaced");
    assert.ok(hints.flags.includes("platform_shopify"));
  });
});

describe("popup-vendor skip list: FRAME_SKIP semantics preserved (single source of truth)", () => {
  // The catalog's consent/chat entries are DOM class/id fingerprints; the capture
  // pipeline's popup-vendor skip list (graft.ts FRAME_SKIP_RE) matches iframe host
  // URLs. They are orthogonal axes — the catalog carries no URL hosts, so there is
  // nothing to consolidate; capture's list stays the single source of truth for
  // frame-graft decisions. Assert its semantics are unchanged.
  it("skips promo/consent creative iframe hosts", () => {
    assert.equal(planForFrameUrl("https://widget.privy.com/assets/popup.html"), "skip");
    assert.equal(planForFrameUrl("https://app.recart.com/creative"), "skip");
    assert.equal(planForFrameUrl("https://www.googletagmanager.com/ns.html"), "skip");
  });

  it("still grafts inline form embeds and same-origin blank frames", () => {
    assert.equal(planForFrameUrl("https://static-forms.klaviyo.com/form"), "graft");
    assert.equal(planForFrameUrl("about:blank"), "graft");
    assert.equal(planForFrameUrl(""), "graft");
  });

  it("still renders media players as stills", () => {
    assert.equal(planForFrameUrl("https://www.youtube.com/embed/abc"), "still");
  });
});
