import { extname } from "node:path";
import type { CloneJobResult, CloneOptions, CloneTimings, FileMap, RouteInfo } from "@cloner/core";
import type { StoredFile } from "@cloner/storage";

/** The eager REST file entry. Text is inline; binaries are by reference
 *  (a URL the client fetches out-of-band). */
export type RestFileEntry =
  | { type: "text"; content: string; bytes: number; sha256: string }
  | { type: "binary"; url: string; bytes: number; sha256: string };

export type RestCloneResult = {
  jobId: string;
  url: string;
  kind: "clone" | "clone_site";
  options: CloneOptions;
  status: "succeeded" | "failed" | "cached";
  compilerVersion: string;
  timings: CloneTimings;
  routes?: RouteInfo[];
  files: Record<string, RestFileEntry>;
  bundleUrl?: string; // added in M4 (storage); omitted in the sync/in-memory build
  verify?: unknown;
  capture: { nodeCount: number; pollution: boolean; blocked: boolean };
  /** true when a multi-page job reused a prior single-page entry capture (speed path). */
  captureReused?: boolean;
};

/** The cheap overview (no file contents) for status polling / list. */
export type RestCloneSummary = {
  jobId: string;
  url: string;
  kind: "clone" | "clone_site";
  status: "succeeded" | "failed" | "cached";
  options: CloneOptions;
  compilerVersion: string;
  timings: CloneTimings;
  routes?: RouteInfo[];
  capture: { nodeCount: number; pollution: boolean; blocked: boolean };
  captureReused?: boolean;
  fileCount: number;
  totalBytes: number;
  bundleUrl?: string;
};

/** Map a collected FileMap to the eager REST shape. `filesBaseUrl` is the per-file
 *  access prefix (e.g. "/v1/clones/<id>/files") used to reference binaries. */
export function toRestFiles(files: FileMap, filesBaseUrl: string): Record<string, RestFileEntry> {
  const out: Record<string, RestFileEntry> = {};
  for (const [path, f] of Object.entries(files)) {
    if (f.kind === "text") {
      out[path] = { type: "text", content: f.content ?? "", bytes: f.bytes, sha256: f.sha256 };
    } else {
      out[path] = { type: "binary", url: `${filesBaseUrl}/${path}`, bytes: f.bytes, sha256: f.sha256 };
    }
  }
  return out;
}

export function buildRestResult(jobId: string, result: CloneJobResult, filesBaseUrl: string): RestCloneResult {
  return {
    jobId,
    url: result.url,
    kind: result.kind,
    options: result.options,
    status: "succeeded",
    compilerVersion: result.compilerVersion,
    timings: result.timings,
    routes: result.routes,
    files: toRestFiles(result.files, filesBaseUrl),
    verify: result.verify,
    capture: result.capture,
    captureReused: result.captureReused,
  };
}

export function buildRestSummary(jobId: string, result: CloneJobResult): RestCloneSummary {
  let totalBytes = 0;
  const vals = Object.values(result.files);
  for (const f of vals) totalBytes += f.bytes;
  return {
    jobId,
    url: result.url,
    kind: result.kind,
    status: "succeeded",
    options: result.options,
    compilerVersion: result.compilerVersion,
    timings: result.timings,
    routes: result.routes,
    capture: result.capture,
    captureReused: result.captureReused,
    fileCount: vals.length,
    totalBytes,
  };
}

/** Reconstruct the eager REST result from persisted (DB + storage) data — the
 *  read path for the async DB backend. Text comes inline from the manifest;
 *  binary URLs are resolved via the store (local API route or presigned S3 URL). */
export async function restResultFromStored(
  jobId: string,
  args: {
    url: string;
    kind: "clone" | "clone_site";
    options: CloneOptions;
    compilerVersion: string;
    timings: CloneTimings;
    capture: { nodeCount: number; pollution: boolean; blocked: boolean };
    routes?: RouteInfo[];
    verify?: unknown;
    files: StoredFile[];
    bundleUrl?: string;
    binaryUrl: (path: string) => Promise<string>;
  },
): Promise<RestCloneResult> {
  const files: Record<string, RestFileEntry> = {};
  for (const f of args.files) {
    if (f.kind === "text") {
      files[f.path] = { type: "text", content: f.content, bytes: f.bytes, sha256: f.sha256 };
    } else {
      files[f.path] = { type: "binary", url: await args.binaryUrl(f.path), bytes: f.bytes, sha256: f.sha256 };
    }
  }
  return {
    jobId,
    url: args.url,
    kind: args.kind,
    options: args.options,
    status: "succeeded",
    compilerVersion: args.compilerVersion,
    timings: args.timings,
    routes: args.routes,
    files,
    bundleUrl: args.bundleUrl,
    verify: args.verify,
    capture: args.capture,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".tsx": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
