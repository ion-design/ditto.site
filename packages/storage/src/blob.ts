/** A minimal object-store client. The ArtifactStore is built on this so its logic
 *  is testable with an in-memory client and runs on S3/R2 in production. */
export interface BlobClient {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** A URL a client can use to fetch the object directly (presigned for S3). */
  presign(key: string, opts?: { expiresSeconds?: number; downloadName?: string; contentType?: string }): Promise<string>;
  delete(key: string): Promise<void>;
  /** Delete everything under a prefix (best effort). */
  deletePrefix(prefix: string): Promise<void>;
}

/** In-memory BlobClient for tests. presign() returns a fake URL (no real fetch). */
export class InMemoryBlobClient implements BlobClient {
  private objs = new Map<string, { bytes: Buffer; contentType: string }>();
  constructor(private publicBase = "memory://blobs") {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objs.set(key, { bytes, contentType });
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objs.get(key)?.bytes ?? null;
  }
  async presign(key: string): Promise<string> {
    return `${this.publicBase}/${key}?sig=test`;
  }
  async delete(key: string): Promise<void> {
    this.objs.delete(key);
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objs.keys()]) if (k.startsWith(prefix)) this.objs.delete(k);
  }
  /** test helper */
  has(key: string): boolean {
    return this.objs.has(key);
  }
}
