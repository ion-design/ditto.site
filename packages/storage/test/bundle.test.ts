import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { makeTarGz, makeZip, sha256hex } from "../src/bundle.js";

const files = [
  { path: "src/app/page.tsx", bytes: Buffer.from("hello world hello world") },
  { path: "b.txt", bytes: Buffer.from("x") },
];

test("makeTarGz: deterministic (order-independent), valid gzip, contains files", () => {
  const a = makeTarGz(files);
  const b = makeTarGz([...files].reverse());
  assert.equal(sha256hex(a), sha256hex(b), "sorted entries → deterministic regardless of input order");

  const tar = gunzipSync(a).toString("latin1");
  assert.ok(tar.includes("src/app/page.tsx"), "path present in tar header");
  assert.ok(tar.includes("ustar"), "ustar magic present");
  assert.ok(tar.includes("hello world hello world"), "content present");
});

test("makeZip: deterministic, valid signatures, deflate round-trips", () => {
  const z = makeZip(files);
  assert.equal(sha256hex(z), sha256hex(makeZip(files)), "deterministic");
  assert.equal(z.readUInt32LE(0), 0x04034b50, "local file header signature");
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50, "end-of-central-directory signature");

  // Extract the first entry and verify the deflate stream round-trips.
  const nameLen = z.readUInt16LE(26);
  const compSize = z.readUInt32LE(18);
  const dataStart = 30 + nameLen;
  const out = inflateRawSync(z.subarray(dataStart, dataStart + compSize));
  // entries are sorted: "b.txt" sorts before "src/app/page.tsx"
  assert.equal(out.toString(), "x");
});
