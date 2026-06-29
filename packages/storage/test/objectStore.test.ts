import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFileMap } from "@cloner/core";
import { ObjectArtifactStore, InMemoryBlobClient } from "../src/index.js";

test("ObjectArtifactStore: binaries → blob (presigned URL), text inline, getFile, bundle, remove", async () => {
  const work = mkdtempSync(join(tmpdir(), "obj-src-"));
  try {
    const app = join(work, "generated", "app");
    mkdirSync(join(app, "src", "app"), { recursive: true });
    mkdirSync(join(app, "public", "assets", "cloned", "images"), { recursive: true });
    writeFileSync(join(app, "src", "app", "page.tsx"), "export default () => null\n");
    writeFileSync(join(app, "public", "assets", "cloned", "images", "a.png"), Buffer.from([9, 8, 7]));
    const files = collectFileMap(work);

    const blob = new InMemoryBlobClient("https://cdn.test");
    const store = new ObjectArtifactStore(blob);
    const manifest = await store.putClone("job-1", files);

    const page = manifest.files.find((f) => f.path === "src/app/page.tsx")!;
    assert.equal(page.kind, "text");

    const bin = manifest.files.find((f) => f.path.endsWith("a.png"))!;
    assert.equal(bin.kind, "binary");
    assert.ok(bin.kind === "binary" && bin.key === "clones/job-1/public/assets/cloned/images/a.png");
    assert.ok(blob.has("clones/job-1/public/assets/cloned/images/a.png"), "binary uploaded to blob");
    assert.ok(!blob.has("clones/job-1/src/app/page.tsx"), "text NOT uploaded (stays in manifest)");

    const got = await store.getFile("job-1", "public/assets/cloned/images/a.png");
    assert.deepEqual([...got!.bytes], [9, 8, 7]);

    const url = await store.binaryUrl("job-1", "public/assets/cloned/images/a.png");
    assert.ok(url.startsWith("https://cdn.test/clones/job-1/"), "presigned/public URL");

    const bundleUrl = await store.uploadBundle("job-1", "tgz", Buffer.from("archive"));
    assert.ok(bundleUrl.includes("clones/job-1/bundle/clone.tgz"));

    await store.remove("job-1");
    assert.equal(await store.getFile("job-1", "public/assets/cloned/images/a.png"), null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
