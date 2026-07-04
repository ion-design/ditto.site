import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeFontFile } from "../src/capture/capture.js";
import { buildFontGraph } from "../src/infer/fonts.js";
import type { FontFace } from "../src/capture/walker.js";
import type { AssetGraph, AssetEntry } from "../src/infer/assets.js";

// --- Magic-byte validator table -------------------------------------------------------------

function head(tag: string, len = 64): Buffer {
  return Buffer.concat([Buffer.from(tag, "latin1"), Buffer.alloc(Math.max(0, len - tag.length))]);
}

describe("looksLikeFontFile (font container magic)", () => {
  it("accepts every real font-container signature", () => {
    assert.equal(looksLikeFontFile(head("wOF2")), true, "woff2");
    assert.equal(looksLikeFontFile(head("wOFF")), true, "woff");
    assert.equal(looksLikeFontFile(head("OTTO")), true, "CFF OpenType (otf)");
    assert.equal(looksLikeFontFile(head("true")), true, "TrueType 'true' sfnt");
    assert.equal(looksLikeFontFile(head("ttcf")), true, "TrueType collection");
    assert.equal(
      looksLikeFontFile(Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(60)])),
      true,
      "TrueType \\x00\\x01\\x00\\x00 sfnt (ttf)",
    );
    // EOT: 0x504C ("LP") marker at byte offset 34.
    const eot = Buffer.alloc(80);
    eot[34] = 0x4c;
    eot[35] = 0x50;
    assert.equal(looksLikeFontFile(eot), true, "eot");
  });

  it("rejects HTML/text impostor bodies (the SPA-router 200 shell)", () => {
    assert.equal(looksLikeFontFile(Buffer.from("<!DOCTYPE html><html><head></head></html>")), false);
    assert.equal(looksLikeFontFile(Buffer.from("<!doctype html>")), false);
    assert.equal(looksLikeFontFile(Buffer.from("<html><body>not a font</body></html>")), false);
    assert.equal(looksLikeFontFile(Buffer.from("<?xml version=\"1.0\"?>")), false);
    assert.equal(looksLikeFontFile(Buffer.from("just some plain text body")), false);
  });

  it("rejects truncated/empty buffers", () => {
    assert.equal(looksLikeFontFile(Buffer.alloc(0)), false);
    assert.equal(looksLikeFontFile(Buffer.from([0x77, 0x4f])), false); // 2 bytes of "wO"
  });
});

// --- Validity-aware first-insert preference in buildFontGraph -------------------------------

function fontEntry(sourceUrl: string, localPath: string | null): AssetEntry {
  return {
    sourceUrl,
    type: "font",
    classification: localPath ? "downloaded" : "skipped",
    localPath,
    storedFile: localPath ? localPath.split("/").pop()! : null,
    bytes: localPath ? 45_000 : 0,
    reason: localPath ? null : "font_file_unavailable",
    impact: null,
    via: [],
  };
}

function graphOf(entries: AssetEntry[]): AssetGraph {
  const byUrl = new Map<string, AssetEntry>();
  for (const e of entries) byUrl.set(e.sourceUrl, e);
  return { entries, byUrl };
}

const DOC = "https://host.example/page";
// The genuine subset lives under the css file's sibling media dir; only THIS url is downloaded.
const GOOD_URL = "https://host.example/marketing-static/_next/static/media/good.woff2";
// The wrongly-based (document-relative) url that the SPA router answered with HTML and that was
// therefore rejected at store time — it never becomes a downloaded asset.
const BAD_URL = "https://host.example/media/impostor.woff2";

describe("buildFontGraph validity-aware preference (first-insert race)", () => {
  it("prefers the face whose src resolves to a downloaded file even when it was inserted SECOND", () => {
    const graph = graphOf([fontEntry(GOOD_URL, "/assets/cloned/fonts/good.woff2")]);
    // Insertion order mirrors the real race: the mis-based CSSOM face lands first, the correctly
    // based css-text face second. Only the good url is a downloaded asset.
    const faces: FontFace[] = [
      { family: "Gothic", weight: "400", style: "normal", src: `url("${BAD_URL}") format("woff2")` },
      { family: "Gothic", weight: "400", style: "normal", src: `url("${GOOD_URL}") format("woff2")` },
    ];
    const { entries, css } = buildFontGraph(faces, graph, DOC);
    const gothic = entries.filter((e) => e.family === "Gothic");
    assert.equal(gothic.length, 1, "deduped to a single face");
    assert.equal(gothic[0]!.status, "resolved");
    assert.deepEqual(gothic[0]!.localPaths, ["/assets/cloned/fonts/good.woff2"]);
    assert.match(css, /good\.woff2/);
    assert.doesNotMatch(css, /impostor/);
  });

  it("keeps the FIRST face when neither resolves (fallback, ties hold order)", () => {
    const graph = graphOf([]); // nothing downloaded
    const faces: FontFace[] = [
      { family: "Gothic", weight: "400", style: "normal", src: `url("${BAD_URL}") format("woff2")` },
      { family: "Gothic", weight: "400", style: "normal", src: `url("${GOOD_URL}") format("woff2")` },
    ];
    const { entries } = buildFontGraph(faces, graph, DOC);
    const gothic = entries.filter((e) => e.family === "Gothic");
    assert.equal(gothic.length, 1);
    assert.equal(gothic[0]!.status, "fallback");
  });

  it("keeps the FIRST resolving face when BOTH resolve (ties hold insertion order)", () => {
    const alt = "https://host.example/marketing-static/_next/static/media/alt.woff2";
    const graph = graphOf([
      fontEntry(GOOD_URL, "/assets/cloned/fonts/good.woff2"),
      fontEntry(alt, "/assets/cloned/fonts/alt.woff2"),
    ]);
    const faces: FontFace[] = [
      { family: "Gothic", weight: "400", style: "normal", src: `url("${GOOD_URL}") format("woff2")` },
      { family: "Gothic", weight: "400", style: "normal", src: `url("${alt}") format("woff2")` },
    ];
    const { entries } = buildFontGraph(faces, graph, DOC);
    const gothic = entries.filter((e) => e.family === "Gothic");
    assert.equal(gothic.length, 1);
    assert.deepEqual(gothic[0]!.localPaths, ["/assets/cloned/fonts/good.woff2"], "first resolving wins");
  });
});

// --- baseHref-driven relative resolution in buildFontGraph ----------------------------------

describe("buildFontGraph resolves a face's relative src against its owning sheet (baseHref)", () => {
  it("uses baseHref, not the document url, so ../media climbs from the css file", () => {
    // The sheet lives at /marketing-static/_next/static/css/sheet.css; `../media/x` from THERE is
    // /marketing-static/_next/static/media/x.woff2, which is what actually downloaded. Resolved
    // against the document (/page) it would clamp to /marketing-static/_next/static/media only if
    // the css path were the base — the point of baseHref.
    const sheetUrl = "https://host.example/marketing-static/_next/static/css/sheet.css";
    const resolved = "https://host.example/marketing-static/_next/static/media/x.woff2";
    const graph = graphOf([fontEntry(resolved, "/assets/cloned/fonts/x.woff2")]);
    const faces: FontFace[] = [
      { family: "Gothic", weight: "400", style: "normal", src: 'url("../media/x.woff2") format("woff2")', baseHref: sheetUrl },
    ];
    const { entries } = buildFontGraph(faces, graph, DOC);
    assert.equal(entries[0]!.status, "resolved");
    assert.deepEqual(entries[0]!.localPaths, ["/assets/cloned/fonts/x.woff2"]);
  });

  it("falls back to the document url when baseHref is absent (inline <style> / out-of-band parse)", () => {
    // An out-of-band parse bakes the absolute url into src, so document fallback is harmless.
    const abs = "https://host.example/fonts/y.woff2";
    const graph = graphOf([fontEntry(abs, "/assets/cloned/fonts/y.woff2")]);
    const faces: FontFace[] = [
      { family: "Mono", weight: "400", style: "normal", src: `url("${abs}") format("woff2")` },
    ];
    const { entries } = buildFontGraph(faces, graph, DOC);
    assert.equal(entries[0]!.status, "resolved");
  });
});
