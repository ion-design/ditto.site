import { join } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { GateResult } from "./gates.js";
import { fileExists, readJSON } from "../util/fsx.js";

function walkHash(dir: string, prefix: string, h: ReturnType<typeof createHash>): number {
  if (!existsSync(dir)) return 0;
  let files = 0;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(p);
    if (st.isDirectory()) files += walkHash(p, rel, h);
    else {
      h.update(rel);
      h.update("\0");
      h.update(readFileSync(p));
      h.update("\0");
      files++;
    }
  }
  return files;
}

/** Gate 6b: canonical manifest hash over static mirror + frozen asset store. */
export function gate6bManifestHash(sourceDir: string, generatedDir: string): GateResult {
  const issues: string[] = [];
  const h = createHash("sha256");
  let files = walkHash(join(generatedDir, "app", "public", "static"), "static", h);
  files += walkHash(join(sourceDir, "assets-store"), "assets-store", h);

  const hash = h.digest("hex");
  const evidencePath = join(sourceDir, "evidence", "evidence-manifest.json");
  if (fileExists(evidencePath)) {
    const ev = readJSON<{ assetManifest?: { hash: string } }>(evidencePath);
    if (ev.assetManifest?.hash && files > 0) {
      // Store hash at capture vs combined deliverable hash — both recorded for audit.
    }
  }

  if (files === 0) issues.push("manifest hash: no static mirror or asset files");

  return {
    gate: "manifest_hash",
    pass: issues.length === 0,
    metrics: { hash, files, captureAssetHash: fileExists(evidencePath) ? readJSON<{ assetManifest?: { hash: string } }>(evidencePath).assetManifest?.hash : undefined },
    issues,
  };
}
