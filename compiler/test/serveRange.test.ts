import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic, parseRangeHeader, pendingFontFamilies, type FontFaceStatus } from "../src/validate/render.js";

// ---- Pure helper: parseRangeHeader ----
describe("parseRangeHeader", () => {
  const SIZE = 1000;

  it("no header → full 200", () => {
    assert.deepEqual(parseRangeHeader(undefined, SIZE), { kind: "full" });
    assert.deepEqual(parseRangeHeader("", SIZE), { kind: "full" });
  });

  it("bytes=0- (Chromium's open-ended media probe) → whole file as a range", () => {
    assert.deepEqual(parseRangeHeader("bytes=0-", SIZE), { kind: "range", start: 0, end: 999 });
  });

  it("bounded range bytes=100-199 → [100,199] inclusive", () => {
    assert.deepEqual(parseRangeHeader("bytes=100-199", SIZE), { kind: "range", start: 100, end: 199 });
  });

  it("end past EOF is clamped to size-1", () => {
    assert.deepEqual(parseRangeHeader("bytes=900-5000", SIZE), { kind: "range", start: 900, end: 999 });
  });

  it("suffix range bytes=-100 → last 100 bytes", () => {
    assert.deepEqual(parseRangeHeader("bytes=-100", SIZE), { kind: "range", start: 900, end: 999 });
  });

  it("suffix larger than file → whole file", () => {
    assert.deepEqual(parseRangeHeader("bytes=-5000", SIZE), { kind: "range", start: 0, end: 999 });
  });

  it("start at or past EOF → unsatisfiable (416)", () => {
    assert.deepEqual(parseRangeHeader("bytes=1000-", SIZE), { kind: "unsatisfiable" });
    assert.deepEqual(parseRangeHeader("bytes=2000-3000", SIZE), { kind: "unsatisfiable" });
  });

  it("zero-length resource → unsatisfiable for any range", () => {
    assert.deepEqual(parseRangeHeader("bytes=0-", 0), { kind: "unsatisfiable" });
  });

  it("malformed / multi-range / inverted → full (safe fallback, never throws)", () => {
    assert.deepEqual(parseRangeHeader("bytes=abc-def", SIZE), { kind: "full" });
    assert.deepEqual(parseRangeHeader("items=0-10", SIZE), { kind: "full" });
    assert.deepEqual(parseRangeHeader("bytes=0-10,20-30", SIZE), { kind: "full" }); // multi-range collapsed
    assert.deepEqual(parseRangeHeader("bytes=-", SIZE), { kind: "full" });
    assert.deepEqual(parseRangeHeader("bytes=500-100", SIZE), { kind: "full" }); // inverted
  });
});

// ---- Pure helper: pendingFontFamilies (the font-load wait decision) ----
// The render walk must run after webfonts are APPLIED, else text boxes measure the fallback face
// (a systematic width delta wrongly attributed to the clone). This helper is the state-based (not
// time-based) predicate the in-page poll ends on: it returns the DECLARED families not yet terminal.
describe("pendingFontFamilies", () => {
  const face = (family: string, status: string, weight = "400", style = "normal"): FontFaceStatus => ({ family, weight, style, status });

  it("no faces declared → nothing pending", () => {
    assert.deepEqual(pendingFontFamilies([]), []);
  });

  it("all faces loaded → nothing pending (walk may proceed)", () => {
    assert.deepEqual(pendingFontFamilies([face("Avenir", "loaded"), face("Inter", "loaded")]), []);
  });

  it("an unloaded face makes its family pending", () => {
    assert.deepEqual(pendingFontFamilies([face("Avenir", "unloaded")]), ["Avenir"]);
  });

  it("a loading face makes its family pending", () => {
    assert.deepEqual(pendingFontFamilies([face("Avenir", "loading")]), ["Avenir"]);
  });

  it("errored faces are terminal — never reported pending (waiting longer is pointless)", () => {
    assert.deepEqual(pendingFontFamilies([face("Avenir", "error")]), []);
  });

  it("a family with mixed weights is pending if ANY weight is not terminal", () => {
    const faces = [face("Avenir", "loaded", "400"), face("Avenir", "loading", "700")];
    assert.deepEqual(pendingFontFamilies(faces), ["Avenir"]);
  });

  it("a family whose faces are all terminal (loaded or errored) is not pending", () => {
    const faces = [face("Avenir", "loaded", "400"), face("Avenir", "error", "700")];
    assert.deepEqual(pendingFontFamilies(faces), []);
  });

  it("strips surrounding quotes from the reported family name and dedupes+sorts", () => {
    const faces = [face('"Source Serif"', "unloaded"), face("Avenir", "loading"), face("Avenir", "unloaded")];
    assert.deepEqual(pendingFontFamilies(faces), ["Avenir", "Source Serif"]);
  });

  it("only the unloaded families are returned when some are loaded", () => {
    const faces = [face("Inter", "loaded"), face("Avenir", "unloaded"), face("JetBrains", "loaded")];
    assert.deepEqual(pendingFontFamilies(faces), ["Avenir"]);
  });
});

// ---- Integration: serveStatic answers real Range requests with 206/416 ----
describe("serveStatic Range support (integration)", () => {
  let rootDir = "";
  let base = "";
  let close: (() => Promise<void>) | null = null;
  const BODY = Buffer.alloc(5000, 0x41); // 5000 'A' bytes stands in for a media file

  before(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "ditto-serve-"));
    mkdirSync(join(rootDir, "assets"), { recursive: true });
    writeFileSync(join(rootDir, "assets", "hero.webm"), BODY);
    writeFileSync(join(rootDir, "index.html"), "<!doctype html><html><body>ok</body></html>");
    const s = await serveStatic(rootDir);
    base = s.url;
    close = s.close;
  });

  after(async () => {
    await close?.();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("open-ended Range bytes=0- → 206 with a bounded body + Content-Range/Accept-Ranges", async () => {
    const res = await fetch(base + "/assets/hero.webm", { headers: { Range: "bytes=0-" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-range"), `bytes 0-4999/5000`);
    assert.equal(res.headers.get("content-type"), "video/webm");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 5000);
  });

  it("bounded Range bytes=100-199 → 206 returning exactly those 100 bytes", async () => {
    const res = await fetch(base + "/assets/hero.webm", { headers: { Range: "bytes=100-199" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 100-199/5000`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 100);
    assert.ok(buf.equals(BODY.subarray(100, 200)));
  });

  it("Range past EOF → 416 with Content-Range: bytes */size", async () => {
    const res = await fetch(base + "/assets/hero.webm", { headers: { Range: "bytes=9000-" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */5000`);
    // Drain the (empty) body so the socket is released.
    await res.arrayBuffer();
  });

  it("no Range header → full 200 with Accept-Ranges advertised", async () => {
    const res = await fetch(base + "/assets/hero.webm");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 5000);
  });

  it("HTML routes still serve a normal 200 (Range logic doesn't disturb pages)", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<body>ok<\/body>/);
  });
});
