import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFileMap } from "@cloner/core";
import { LocalArtifactStore } from "../src/local.js";

test("LocalArtifactStore: persists, inlines text, references binaries, round-trips bytes", async () => {
  const work = mkdtempSync(join(tmpdir(), "store-src-"));
  const blobs = mkdtempSync(join(tmpdir(), "store-blobs-"));
  try {
    // Synthesize a generated app and collect it.
    const app = join(work, "generated", "app");
    mkdirSync(join(app, "src", "app"), { recursive: true });
    mkdirSync(join(app, "public", "assets", "cloned", "images"), {
      recursive: true,
    });
    writeFileSync(
      join(app, "src", "app", "page.tsx"),
      "export default () => null\n",
    );
    const png = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(
      join(app, "public", "assets", "cloned", "images", "a.png"),
      png,
    );
    const files = collectFileMap(work);

    const store = new LocalArtifactStore(blobs);
    const manifest = await store.putClone("job-1", files);

    const page = manifest.files.find((f) => f.path === "src/app/page.tsx")!;
    assert.equal(page.kind, "text");
    assert.ok(page.kind === "text" && page.content.includes("export default"));

    const bin = manifest.files.find((f) => f.path.endsWith("a.png"))!;
    assert.equal(bin.kind, "binary");
    assert.ok(
      bin.kind === "binary" &&
        bin.key === "job-1/public/assets/cloned/images/a.png",
    );

    const got = await store.getFile(
      "job-1",
      "public/assets/cloned/images/a.png",
    );
    assert.ok(got);
    assert.deepEqual([...got!.bytes], [1, 2, 3, 4, 5]);

    assert.equal(
      await store.binaryUrl("job-1", "public/assets/cloned/images/a.png"),
      "/v1/clones/job-1/files/public/assets/cloned/images/a.png",
    );

    await store.remove("job-1");
    assert.equal(
      await store.getFile("job-1", "public/assets/cloned/images/a.png"),
      null,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(blobs, { recursive: true, force: true });
  }
});

test("LocalArtifactStore: rejects path traversal", async () => {
  const blobs = mkdtempSync(join(tmpdir(), "store-blobs2-"));
  try {
    const store = new LocalArtifactStore(blobs);
    await assert.rejects(() => store.getFile("job-1", "../../etc/passwd"));
  } finally {
    rmSync(blobs, { recursive: true, force: true });
  }
});

test("LocalArtifactStore: entry captures survive store recreation and stay private", async () => {
  const source = mkdtempSync(join(tmpdir(), "capture-src-"));
  const restored = mkdtempSync(join(tmpdir(), "capture-dest-"));
  const blobs = mkdtempSync(join(tmpdir(), "capture-blobs-"));
  try {
    mkdirSync(join(source, "capture", "assets"), { recursive: true });
    writeFileSync(
      join(source, "capture", "capture-result.json"),
      '{"url":"https://example.test/"}',
    );
    writeFileSync(
      join(source, "capture", "assets", "hero.bin"),
      Buffer.from([4, 3, 2, 1]),
    );

    await new LocalArtifactStore(blobs).putEntryCapture("job-1", source);
    const recreated = new LocalArtifactStore(blobs);
    assert.equal(await recreated.restoreEntryCapture("job-1", restored), true);
    assert.equal(
      readFileSync(join(restored, "capture", "capture-result.json"), "utf8"),
      '{"url":"https://example.test/"}',
    );
    assert.deepEqual(
      [...readFileSync(join(restored, "capture", "assets", "hero.bin"))],
      [4, 3, 2, 1],
    );
    assert.equal(
      await recreated.getFile("job-1", "capture/capture-result.json"),
      null,
      "private capture is not addressable through the customer file API",
    );
    await recreated.remove("job-1");
    assert.equal(await recreated.restoreEntryCapture("job-1", restored), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(restored, { recursive: true, force: true });
    rmSync(blobs, { recursive: true, force: true });
  }
});
