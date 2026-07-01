import type { FileMap } from "@cloner/core";

/** A file as persisted: text inline (goes into the DB manifest), binaries by
 *  reference to a storage key (local relative path or S3 key). */
export type StoredFile =
  | { path: string; kind: "text"; bytes: number; sha256: string; content: string }
  | { path: string; kind: "binary"; bytes: number; sha256: string; key: string };

export type StoredManifest = {
  files: StoredFile[];
  /** the whole app as one compressed archive (M4); absent until built. */
  bundleKey?: string;
};

/** Blob backend for clone artifacts. LocalArtifactStore (M2) writes to disk;
 *  S3ArtifactStore (M4) uploads to S3/R2 and presigns URLs. */
export interface ArtifactStore {
  /** Persist a clone's files; returns the manifest (text inline, binaries by key). */
  putClone(jobId: string, files: FileMap): Promise<StoredManifest>;
  /** Read one file's bytes (for the API's /files/* streaming). null if absent. */
  getFile(jobId: string, path: string): Promise<{ bytes: Buffer } | null>;
  /** A URL a client uses to fetch a binary out-of-band (local: API route;
   *  S3: presigned URL). */
  binaryUrl(jobId: string, path: string): Promise<string>;
  /** Persist a prebuilt archive and return a download URL (presigned for S3). When
   *  absent (local store), the API serves the bundle bytes itself. */
  uploadBundle?(jobId: string, format: "tgz" | "zip", bytes: Buffer): Promise<string>;
  /** Delete all artifacts for a job. */
  remove(jobId: string): Promise<void>;
}
