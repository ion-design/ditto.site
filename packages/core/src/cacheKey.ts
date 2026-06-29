import { createHash } from "node:crypto";
import type { CloneOptions } from "./types.js";
import { resolveCloneOptions } from "./options.js";

/** Normalize a URL so trivially-different spellings of the same page share a cache
 *  entry: lowercase scheme+host, drop default ports, drop the fragment, collapse a
 *  bare/trailing-slash path. Query is preserved (it can select a different page) but
 *  its params are sorted for stability. Falsy/invalid input is returned trimmed. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  u.hash = "";
  // Collapse trailing slashes on the path (but keep "/" for root).
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  // Sort query params for stability.
  u.searchParams.sort();
  return u.toString();
}

/** The subset of options that change the generated output, serialized canonically.
 *  `noCache` is intentionally excluded (it's a request-time switch, not an output
 *  determinant). `verify`/`asyncVerify` are included so a verified result isn't
 *  served for an unverified request and vice-versa. Viewports are sorted; booleans
 *  normalized. */
export function canonicalOptions(options: CloneOptions = {}): string {
  const resolved = resolveCloneOptions(options);
  const norm = {
    mode: resolved.mode,
    styling: resolved.styling,
    framework: resolved.framework,
    viewports: resolved.viewports ? [...resolved.viewports].sort((a, b) => a - b) : null,
    interactions: resolved.interactions,
    components: resolved.components,
    motion: resolved.motion,
    verify: !!resolved.verify,
    asyncVerify: !!resolved.asyncVerify,
    maxRoutes: resolved.maxRoutes ?? null,
    maxCollection: resolved.maxCollection ?? null,
  };
  return JSON.stringify(norm);
}

/** cacheKey = sha256(normalizedUrl + canonicalOptions + compilerVersion).
 *  A compilerVersion bump invalidates everything (the output changed). The cache is
 *  freshness-bounded by the caller (CACHE_STALE_AFTER), because two *captures* of a
 *  live site can differ even though generation from one capture is byte-stable. */
export function cacheKey(url: string, options: CloneOptions | undefined, compilerVersion: string): string {
  const payload = [normalizeUrl(url), canonicalOptions(options), compilerVersion].join("\n");
  return createHash("sha256").update(payload).digest("hex");
}
