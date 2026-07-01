import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobClient } from "./blob.js";

export type S3Config = {
  bucket: string;
  region?: string;
  endpoint?: string; // e.g. http://localhost:9000 for MinIO, or R2 endpoint
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean; // required for MinIO
  /** if set, objects are public at `${publicUrl}/${key}` (CDN) and not presigned. */
  publicUrl?: string;
  presignExpiresSeconds?: number;
};

/** BlobClient backed by S3 / R2 / MinIO. */
export class S3BlobClient implements BlobClient {
  private client: S3Client;
  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region ?? "auto",
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? !!cfg.endpoint,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: bytes, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!r.Body) return null;
      const arr = await (r.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(arr);
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async presign(key: string, opts?: { expiresSeconds?: number; downloadName?: string; contentType?: string }): Promise<string> {
    if (this.cfg.publicUrl) return `${this.cfg.publicUrl.replace(/\/$/, "")}/${key}`;
    const cmd = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ResponseContentDisposition: opts?.downloadName ? `attachment; filename="${opts.downloadName}"` : undefined,
      ResponseContentType: opts?.contentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts?.expiresSeconds ?? this.cfg.presignExpiresSeconds ?? 3600 });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const listed = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }));
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}

/** Build an S3 config from env (S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
 *  S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE, S3_PUBLIC_URL). Returns null if no bucket. */
export function s3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return null;
  return {
    bucket,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    publicUrl: process.env.S3_PUBLIC_URL,
  };
}
