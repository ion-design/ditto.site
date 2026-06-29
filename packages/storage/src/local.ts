import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import type { FileMap } from "@cloner/core";
import type { ArtifactStore, StoredFile, StoredManifest } from "./types.js";

/** Reject path traversal — only allow relative paths that stay within the job dir. */
function safeRel(path: string): string {
  const n = normalize(path);
  if (n.includes("\0") || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split(/[/\\]/).includes("..")) {
    throw new Error("unsafe path: " + path);
  }
  return n;
}

/**
 * Disk-backed artifact store (M2, local dev). Writes every file under
 * `<baseDir>/<jobId>/`, returns a manifest with text inline + binary keys, and
 * serves bytes back for the API's /files/* route. In production this is swapped for
 * the S3 store (M4); the API/worker depend only on the ArtifactStore interface.
 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private baseDir: string) {}

  private jobDir(jobId: string): string {
    return join(this.baseDir, jobId);
  }

  async putClone(jobId: string, files: FileMap): Promise<StoredManifest> {
    const root = this.jobDir(jobId);
    const out: StoredFile[] = [];
    for (const [path, f] of Object.entries(files)) {
      const rel = safeRel(path);
      const dest = join(root, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(f.absPath));
      if (f.kind === "text") {
        out.push({ path, kind: "text", bytes: f.bytes, sha256: f.sha256, content: f.content ?? "" });
      } else {
        out.push({ path, kind: "binary", bytes: f.bytes, sha256: f.sha256, key: `${jobId}/${rel}` });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files: out };
  }

  async getFile(jobId: string, path: string): Promise<{ bytes: Buffer } | null> {
    const dest = join(this.jobDir(jobId), safeRel(path));
    if (!existsSync(dest)) return null;
    return { bytes: readFileSync(dest) };
  }

  async binaryUrl(jobId: string, path: string): Promise<string> {
    // Local: served by the API itself.
    return `/v1/clones/${jobId}/files/${path}`;
  }

  async remove(jobId: string): Promise<void> {
    rmSync(this.jobDir(jobId), { recursive: true, force: true });
  }
}
