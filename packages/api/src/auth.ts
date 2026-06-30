import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export type AuthConfig = {
  /** sha256 hashes of accepted keys (from env). */
  keyHashes: Set<string>;
  /** optional async lookup (e.g. the DB apiKeys table) by key hash. */
  lookup?: (keyHash: string) => Promise<boolean>;
};

function extractKey(authHeader: string | undefined, xApiKey: string | undefined): string | undefined {
  if (xApiKey) return xApiKey;
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    return m ? m[1]! : authHeader;
  }
  return undefined;
}

/** Require a valid API key (Authorization: Bearer <key> or x-api-key). */
export function apiKeyAuth(cfg: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const provided = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided) return c.json({ error: "missing API key" }, 401);
    const h = hashApiKey(provided);
    if (cfg.keyHashes.has(h)) return next();
    if (cfg.lookup && (await cfg.lookup(h))) return next();
    return c.json({ error: "invalid API key" }, 401);
  };
}

export type RateLimitConfig = {
  perMinute: number;
  /** window length in milliseconds (default: one minute). */
  windowMs?: number;
  /** key the limit by (default: API-key hash, else client IP). */
  keyFn?: (c: Parameters<MiddlewareHandler>[0]) => string;
};

/** Fixed-window in-memory rate limiter. Sufficient for a single API instance; a
 *  shared store (Redis/PG) would be needed across replicas. Keyed by API key when
 *  present, else client IP. */
export function rateLimit(cfg: RateLimitConfig): MiddlewareHandler {
  const windowMs = cfg.windowMs ?? 60_000;
  const buckets = new Map<string, { count: number; reset: number }>();
  const keyFn =
    cfg.keyFn ??
    ((c) => {
      const provided = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
      if (provided) return "k:" + hashApiKey(provided);
      const xff = c.req.header("x-forwarded-for");
      const ip = (xff ? xff.split(",")[0]!.trim() : undefined) ?? c.req.header("x-real-ip") ?? "anon";
      return "ip:" + ip;
    });

  return async (c, next) => {
    const now = Date.now();
    const key = keyFn(c);
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const remaining = Math.max(0, cfg.perMinute - b.count);
    c.header("x-ratelimit-limit", String(cfg.perMinute));
    c.header("x-ratelimit-remaining", String(remaining));
    if (b.count > cfg.perMinute) {
      c.header("retry-after", String(Math.ceil((b.reset - now) / 1000)));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    return next();
  };
}
