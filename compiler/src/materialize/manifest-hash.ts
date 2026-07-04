import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileExists } from "../util/fsx.js";

export type AssetManifestHash = {
  algorithm: "sha256";
  hash: string;
  fileCount: number;
  totalBytes: number;
};

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fileExists(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Content-addressed manifest over assets-store for Gate 6b and evidence freeze. */
export function hashAssetStore(sourceDir: string): AssetManifestHash {
  const storeDir = join(sourceDir, "assets-store");
  const h = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  for (const f of walkFiles(storeDir)) {
    const rel = f.slice(storeDir.length + 1);
    const buf = readFileSync(f);
    h.update(rel);
    h.update("\0");
    h.update(buf);
    h.update("\0");
    fileCount++;
    totalBytes += buf.length;
  }
  return { algorithm: "sha256", hash: h.digest("hex"), fileCount, totalBytes };
}
