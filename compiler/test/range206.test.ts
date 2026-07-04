import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSite, looksLikeVideoFile, type CaptureResult } from "../src/capture/capture.js";

// A minimal-but-valid mp4 shape: [size]"ftyp" brand box followed by payload bytes.
const FULL_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isomiso2"),
  Buffer.alloc(64_000, 0x07),
]);
// The pathological range fragment observed in the wild: a tail slice (moov atom region)
// of the file — starts mid-container, no ftyp/EBML magic.
const TAIL_FRAGMENT = FULL_MP4.subarray(FULL_MP4.length - 1000);

describe("looksLikeVideoFile (container magic)", () => {
  it("accepts mp4-family (ftyp), webm/mkv (EBML), and ogg (OggS) heads", () => {
    assert.equal(looksLikeVideoFile(FULL_MP4), true);
    assert.equal(looksLikeVideoFile(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)])), true);
    assert.equal(looksLikeVideoFile(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(100)])), true);
  });

  it("rejects range fragments, HTML error bodies, and tiny buffers", () => {
    assert.equal(looksLikeVideoFile(TAIL_FRAGMENT), false, "moov-tail fragment is not a video file");
    assert.equal(looksLikeVideoFile(Buffer.from("<!doctype html><html><body>404</body></html>")), false);
    assert.equal(looksLikeVideoFile(Buffer.from([0x00, 0x00])), false);
  });
});

// A <video> element makes the browser fetch with Range headers; the 206 fragment must
// NOT be stored as the asset (first-stored-wins would then also block the full-download
// fallback). The fallback pass fetches without Range and stores the complete 200 body.
describe("206 range responses are not stored as full assets (integration)", () => {
  let server: Server;
  let url = "";
  let videoUrl = "";
  let outDir = "";
  let capture: CaptureResult;
  let rangeHits = 0;
  let fullHits = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/video.mp4")) {
        if (req.headers.range) {
          rangeHits++;
          // Serve the tail fragment regardless of the requested range — the corrupt-body
          // case (byte-verified in the wild: an 18,925-byte moov tail of a 6MB mp4).
          res.writeHead(206, {
            "content-type": "video/mp4",
            "content-range": `bytes ${FULL_MP4.length - TAIL_FRAGMENT.length}-${FULL_MP4.length - 1}/${FULL_MP4.length}`,
            "content-length": String(TAIL_FRAGMENT.length),
          });
          res.end(TAIL_FRAGMENT);
          return;
        }
        fullHits++;
        res.writeHead(200, { "content-type": "video/mp4", "content-length": String(FULL_MP4.length) });
        res.end(FULL_MP4);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><html><body><h1>Video page</h1><video src="/video.mp4" muted preload="auto" width="320" height="180"></video></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    videoUrl = url + "video.mp4";
    outDir = mkdtempSync(join(tmpdir(), "ditto-206-"));
    capture = await captureSite({
      url,
      outDir,
      viewports: [800],
      breakpoints: false,
      screenshots: false,
    });
  });

  after(async () => {
    server?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("exercised both paths: browser range fetch (206) and the full fallback fetch (200)", () => {
    assert.ok(rangeHits >= 1, `browser issued a Range request (got ${rangeHits})`);
    assert.ok(fullHits >= 1, `fallback pass fetched the full body (got ${fullHits})`);
  });

  it("stores the COMPLETE 200 body, byte-identical, never the 206 fragment", () => {
    const asset = capture.assets.find((a) => a.url === videoUrl);
    assert.ok(asset, "video asset discovered");
    assert.ok(asset!.storedAs, "video asset stored");
    assert.equal(asset!.bytes, FULL_MP4.length, "stored size is the full file, not the fragment");
    const stored = readFileSync(join(outDir, "assets-store", asset!.storedAs!));
    assert.ok(stored.equals(FULL_MP4), "stored bytes are the complete video");
    assert.ok(looksLikeVideoFile(stored), "stored file passes the container-magic check");
  });
});
