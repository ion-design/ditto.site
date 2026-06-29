import type { CloneFramework, CloneMode, CloneOptions, CloneStyling } from "./types.js";

export type ResolvedCloneOptions = CloneOptions & {
  mode: CloneMode;
  styling: CloneStyling;
  framework: CloneFramework;
  multiPage: boolean;
  humanizeMode: CloneStyling;
  interactions: boolean;
  components: boolean;
  motion: boolean;
};

export function resolveCloneMode(options: CloneOptions = {}): CloneMode {
  return options.mode ?? (options.multiPage ? "multi" : "single");
}

export function resolveCloneStyling(options: CloneOptions = {}): CloneStyling {
  return options.styling ?? options.humanizeMode ?? "tailwind";
}

export function resolveCloneFramework(options: CloneOptions = {}): CloneFramework {
  return options.framework ?? "next";
}

/** Normalize the request-facing shape. Deprecated aliases are consumed but not
 * echoed, so REST/MCP results present the product-level option names. */
export function normalizeCloneRequestOptions(options: CloneOptions = {}): CloneOptions {
  const normalized: CloneOptions = {
    ...options,
    mode: resolveCloneMode(options),
    styling: resolveCloneStyling(options),
    framework: resolveCloneFramework(options),
  };
  delete normalized.multiPage;
  delete normalized.humanizeMode;
  return normalized;
}

/** Resolve options for the compiler adapter. This is where automatic internal
 * defaults live; callers should not need to choose these in normal use. */
export function resolveCloneOptions(options: CloneOptions = {}): ResolvedCloneOptions {
  const mode = resolveCloneMode(options);
  const styling = resolveCloneStyling(options);
  const framework = resolveCloneFramework(options);
  return {
    ...options,
    mode,
    styling,
    framework,
    multiPage: mode === "multi",
    humanizeMode: styling,
    interactions: options.interactions ?? true,
    components: options.components ?? true,
    motion: options.motion ?? true,
  };
}
