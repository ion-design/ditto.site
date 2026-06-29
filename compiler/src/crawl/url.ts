/**
 * URL normalization for crawling. A "route path" is the canonical key we crawl,
 * dedupe, and template on: same-origin, pathname only (query + hash dropped —
 * the plan dedupes by pathname to avoid query-string explosions), trailing slash
 * stripped (except root). Everything off-origin, non-http, asset-like, or a bare
 * anchor/mailto/tel is rejected (returns null).
 */

// Asset-like extensions we never treat as crawlable routes.
const ASSET_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|cjs|json|xml|txt|pdf|zip|gz|tgz|tar|rar|7z|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|map|rss|atom|csv|xlsx?|docx?|pptx?|wasm)$/i;

/** Host compared without a leading www. so example.com and www.example.com match. */
export function normHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** True when `href` resolves to the same origin (ignoring www.) as `base`. */
export function isSameOrigin(href: string, base: string): boolean {
  try {
    const u = new URL(href, base);
    const b = new URL(base);
    return /^https?:$/.test(u.protocol) && normHost(u.hostname) === normHost(b.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve an href against `base` to a normalized same-origin route path, or null
 * if it is not a crawlable internal route. Deterministic and idempotent.
 */
export function toRoutePath(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:|blob:|sms:|ftp:)/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  try {
    if (normHost(u.hostname) !== normHost(new URL(base).hostname)) return null;
  } catch {
    return null;
  }
  let p = u.pathname || "/";
  if (ASSET_EXT.test(p)) return null;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** Split a route path into its non-empty segments ("/blog/x" -> ["blog","x"]). */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Depth = number of path segments ("/" is depth 0, "/about" is 1, "/a/b" is 2). */
export function depthOf(path: string): number {
  return segmentsOf(path).length;
}
