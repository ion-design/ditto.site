import type { CloneOptions, RouteInfo } from "@cloner/core";
import type { RestCloneResult } from "./rest.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cached";

/** The cheap status/list view (no file contents). */
export type JobView = {
  jobId: string;
  url: string;
  kind: "clone" | "clone_site";
  status: JobStatus;
  options: CloneOptions;
  compilerVersion?: string;
  timings?: unknown;
  routes?: RouteInfo[];
  capture?: { nodeCount: number; pollution: boolean; blocked: boolean };
  verify?: unknown;
  fileCount?: number;
  totalBytes?: number;
  bundleUrl?: string;
  error?: string;
};

export type SubmitOutcome =
  | { jobId: string; status: "succeeded" | "cached"; httpStatus: 200; result: RestCloneResult }
  | { jobId: string; status: "queued"; httpStatus: 202 };

export type ResultOutcome =
  | { ready: true; result: RestCloneResult }
  | { ready: false; status: JobStatus; error?: string };

/** A file with a content/url accessor — the substrate for MCP list/read (so the
 *  filtering + size-budget logic lives once, regardless of backend). */
export type FileFacet = {
  path: string;
  kind: "text" | "binary";
  bytes: number;
  sha256: string;
  content?: string; // text only
  binaryUrl?: () => Promise<string>; // binary only
};

export type BundleFormat = "tgz" | "zip";
export type CloneBundle = { bytes: Buffer; sha256: string; format: BundleFormat; url?: string };

/** The HTTP routes talk to this; concrete backends are the in-memory sync runner
 *  (M1) and the DB+queue async backend (M2). */
export interface Backend {
  submit(url: string, options: CloneOptions | undefined): Promise<SubmitOutcome>;
  status(jobId: string): Promise<JobView | null>;
  result(jobId: string): Promise<ResultOutcome | null>;
  file(jobId: string, path: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  list(): Promise<JobView[]>;
  remove(jobId: string): Promise<boolean>;
  /** All files with content/url accessors (null if job not ready/found). */
  facets(jobId: string): Promise<FileFacet[] | null>;
  /** The whole app as one compressed archive (null if not ready/found). */
  bundle(jobId: string, format?: BundleFormat): Promise<CloneBundle | null>;
  /** Pipeline progress events for polling UIs (null if unsupported or job unknown). */
  events?(jobId: string): Promise<Array<Record<string, unknown>> | null>;
}
