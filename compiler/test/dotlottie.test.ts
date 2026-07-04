import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { isZipArchive, extractDotLottieJson, readZipEntry } from "../src/capture/dotlottie.js";
import { extFromUrl } from "../src/capture/capture.js";

/**
 * Build a minimal, spec-correct ZIP archive in-memory from named entries. Supports both
 * stored (method 0) and deflated (method 8) compression so the extractor is exercised on both.
 * No CRC validation is needed for our reader, so CRC fields are left 0.
 */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const stored = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(stored.length, 18); // comp size
    local.writeUInt32LE(e.data.length, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);
    const localFull = Buffer.concat([local, stored]);
    locals.push(localFull);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central dir sig
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(stored.length, 20); // comp size
    central.writeUInt32LE(e.data.length, 24); // uncomp size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += localFull.length;
  }

  const centralStart = offset;
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, centralDir, eocd]);
}

const ANIM_1 = { v: "5.7.4", nm: "one", layers: [{ ind: 1 }] };
const ANIM_2 = { v: "5.7.4", nm: "two", layers: [{ ind: 2 }] };
const MANIFEST = { version: "1.0", animations: [{ id: "animation_default" }, { id: "animation_2" }] };

describe("dotLottie ZIP extraction", () => {
  it("detects ZIP archives by the PK local-header magic", () => {
    assert.equal(isZipArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), true);
    assert.equal(isZipArchive(Buffer.from('{"v":"5.7"}', "utf8")), false);
    assert.equal(isZipArchive(Buffer.alloc(2)), false);
  });

  it("extracts the manifest's default animation JSON from a stored dotLottie ZIP", () => {
    const zip = buildZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(MANIFEST), "utf8") },
      { name: "animations/animation_default.json", data: Buffer.from(JSON.stringify(ANIM_1), "utf8") },
      { name: "animations/animation_2.json", data: Buffer.from(JSON.stringify(ANIM_2), "utf8") },
    ]);
    const out = extractDotLottieJson(zip);
    assert.ok(out, "expected an extracted animation buffer");
    assert.deepEqual(JSON.parse(out!.toString("utf8")), ANIM_1);
  });

  it("extracts a DEFLATE-compressed animation entry (the common real-world case)", () => {
    const zip = buildZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(MANIFEST), "utf8"), deflate: true },
      { name: "animations/animation_default.json", data: Buffer.from(JSON.stringify(ANIM_1), "utf8"), deflate: true },
    ]);
    const out = extractDotLottieJson(zip);
    assert.ok(out);
    assert.deepEqual(JSON.parse(out!.toString("utf8")), ANIM_1);
  });

  it("falls back to the name-sorted first animation when the manifest is absent", () => {
    const zip = buildZip([
      { name: "animations/b.json", data: Buffer.from(JSON.stringify(ANIM_2), "utf8") },
      { name: "animations/a.json", data: Buffer.from(JSON.stringify(ANIM_1), "utf8") },
    ]);
    const out = extractDotLottieJson(zip);
    assert.ok(out);
    assert.deepEqual(JSON.parse(out!.toString("utf8")), ANIM_1); // "a.json" sorts first
  });

  it("returns null for non-ZIP bytes and for a ZIP with no animations", () => {
    assert.equal(extractDotLottieJson(Buffer.from('{"v":"5.7"}', "utf8")), null);
    const noAnims = buildZip([{ name: "manifest.json", data: Buffer.from("{}", "utf8") }]);
    assert.equal(extractDotLottieJson(noAnims), null);
  });

  it("reads a named entry directly", () => {
    const zip = buildZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify(MANIFEST), "utf8"), deflate: true }]);
    const m = readZipEntry(zip, "manifest.json");
    assert.ok(m);
    assert.deepEqual(JSON.parse(m!.toString("utf8")), MANIFEST);
    assert.equal(readZipEntry(zip, "missing.json"), null);
  });
});

describe("asset extension preservation (extFromUrl)", () => {
  it("preserves real long extensions instead of truncating to 5 chars", () => {
    assert.equal(extFromUrl("https://x/anim.lottie"), "lottie");
    assert.equal(extFromUrl("https://x/site.webmanifest"), "webmanifest");
    assert.equal(extFromUrl("https://x/pic.png?v=2"), "png");
    assert.equal(extFromUrl("https://x/font.woff2"), "woff2");
  });

  it("rejects absurdly long or non-alphanumeric trailing segments", () => {
    assert.equal(extFromUrl("https://x/name.thisisnotanextension"), "");
    assert.equal(extFromUrl("https://x/dir.with.dots/file"), ""); // dot is in a path segment, not the file
  });
});
