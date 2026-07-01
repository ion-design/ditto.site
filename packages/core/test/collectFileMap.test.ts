import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collectFileMap, fileMapStats } from "../src/collectFileMap.js";

test("collectFileMap: inlines text, references binaries, sorts keys, hashes bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-"));
  try {
    const app = join(root, "generated", "app");
    mkdirSync(join(app, "src", "app", "_clone"), { recursive: true });
    mkdirSync(join(app, "public", "assets", "cloned", "images"), { recursive: true });
    writeFileSync(join(app, "package.json"), '{"name":"x"}\n');
    writeFileSync(join(app, ".gitignore"), "node_modules\n");
    writeFileSync(join(app, "src", "app", "page.tsx"), "export default function Page(){return null}\n");
    writeFileSync(join(app, "src", "app", "globals.css"), "body{margin:0}\n");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(join(app, "public", "assets", "cloned", "images", "a.png"), png);

    const map = collectFileMap(root);
    const keys = Object.keys(map);
    assert.deepEqual(keys, [...keys].sort(), "keys are sorted (deterministic)");

    assert.equal(map["package.json"]!.kind, "text");
    assert.equal(map[".gitignore"]!.kind, "text", ".gitignore is treated as text");
    const page = map["src/app/page.tsx"]!;
    assert.equal(page.kind, "text");
    assert.ok(page.content!.includes("export default"));
    assert.equal(page.sha256, createHash("sha256").update("export default function Page(){return null}\n").digest("hex"));

    const bin = map["public/assets/cloned/images/a.png"]!;
    assert.equal(bin.kind, "binary");
    assert.equal(bin.content, undefined, "binaries are by reference, not inlined");
    assert.equal(bin.sha256, createHash("sha256").update(png).digest("hex"));
    assert.equal(bin.bytes, png.length);

    const stats = fileMapStats(map);
    assert.equal(stats.fileCount, 5);
    assert.ok(stats.totalBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFileMap: throws when there is no generated app", () => {
  const root = mkdtempSync(join(tmpdir(), "cfm-empty-"));
  try {
    assert.throws(() => collectFileMap(root), /no generated app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
