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
export { COMPILER_VERSION } from "clone-static";
export {
  discoverIonCloneInventory,
  ION_CLONE_DISCOVERY_VERSION,
  ION_CLONE_PLAN_VERSION,
  validateIonClonePlan,
} from "clone-static";
export type {
  IonCloneDiscoveryV1,
  IonClonePlanV1,
  IonManifestPlan,
  IonRendererPlan,
  IonRouteDispositionPlan,
} from "clone-static";
export type {
  CloneMode,
  CloneOptions,
  CloneStyling,
  ExperimentalContentHandoff,
  CollectedFile,
  FileMap,
  CaptureSanity,
  CloneTimings,
  RouteInfo,
  CloneJobResult,
  RunCloneJobInput,
} from "./types.js";
