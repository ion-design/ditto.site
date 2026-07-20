/**
 * @cloner/core — the only package that imports the deterministic compiler.
 * The api / worker / mcp layers depend on this, never on compiler internals.
 */
export { runCloneJob, verifyCloneJobResult } from "./runCloneJob.js";
export { collectFileMap, fileMapStats } from "./collectFileMap.js";
export { cacheKey, normalizeUrl, canonicalOptions } from "./cacheKey.js";
export {
  normalizeCloneRequestOptions,
  resolveCloneMode,
  resolveCloneOptions,
  resolveCloneStyling,
} from "./options.js";
export { CAPTURE_REJECTED_CODE, CaptureRejectedError, COMPILER_VERSION } from "clone-static";
export type { WallDiagnosis } from "clone-static";
export type {
  CloneMode,
  CloneOptions,
  CloneStyling,
  CollectedFile,
  FileMap,
  CaptureSanity,
  CloneTimings,
  RouteInfo,
  CloneJobResult,
  RunCloneJobInput,
} from "./types.js";
