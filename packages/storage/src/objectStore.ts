import { extname } from "node:path";
import type { FileMap } from "@cloner/core";
import type { ArtifactStore, StoredFile, StoredManifest } from "./types.js";
import type { BlobClient } from "./blob.js";

const CT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm",
};
const ctFor = (p: string) => CT[extname(p).toLowerCase()] ?? "application/octet-stream";

/**
 * Object-store (S3 / R2 / MinIO) ArtifactStore. Binaries are uploaded
 * content-addressably under `clones/<jobId>/<path>` and served via presigned URLs;
 * text files stay inline in the DB manifest (small) and are not uploaded. The
 * whole-app bundle is uploaded + presigned on demand.
 */
export class ObjectArtifactStore implements ArtifactStore {
  constructor(private blob: BlobClient, private opts?: { presignExpiresSeconds?: number }) {}

  private key(jobId: string, path: string): string {
    return `clones/${jobId}/${path}`;
  }

  async putClone(jobId: string, files: FileMap): Promise<StoredManifest> {
    const out: StoredFile[] = [];
    for (const [path, f] of Object.entries(files)) {
      if (f.kind === "text") {
        out.push({ path, kind: "text", bytes: f.bytes, sha256: f.sha256, content: f.content ?? "" });
      } else {
        const { readFileSync } = await import("node:fs");
        await this.blob.put(this.key(jobId, path), readFileSync(f.absPath), ctFor(path));
        out.push({ path, kind: "binary", bytes: f.bytes, sha256: f.sha256, key: this.key(jobId, path) });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files: out };
  }

  async getFile(jobId: string, path: string): Promise<{ bytes: Buffer } | null> {
    const bytes = await this.blob.get(this.key(jobId, path));
    return bytes ? { bytes } : null;
  }

  async binaryUrl(jobId: string, path: string): Promise<string> {
    return this.blob.presign(this.key(jobId, path), { expiresSeconds: this.opts?.presignExpiresSeconds, contentType: ctFor(path) });
  }

  /** Upload the prebuilt archive and return a presigned download URL. */
  async uploadBundle(jobId: string, format: "tgz" | "zip", bytes: Buffer): Promise<string> {
    const key = `clones/${jobId}/bundle/clone.${format}`;
    const ct = format === "zip" ? "application/zip" : "application/gzip";
    await this.blob.put(key, bytes, ct);
    return this.blob.presign(key, { expiresSeconds: this.opts?.presignExpiresSeconds, downloadName: `clone-${jobId}.${format}`, contentType: ct });
  }

  async remove(jobId: string): Promise<void> {
    await this.blob.deletePrefix(`clones/${jobId}/`);
  }
}
