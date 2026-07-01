/**
 * Canonical URL normalization for deterministic asset storage and HTML rewrite.
 * Strips cache-busting query strings (?v=) and fragments so disk paths match browser requests.
 */

export function stripUrlQueryAndHash(url: string): string {
  if (url.startsWith("data:")) return url;
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return url.split("#")[0]?.split("?")[0] ?? url;
  }
}

/** Fix protocol-relative and common wget artifacts. */
export function normalizeFetchUrl(url: string, base?: string): string {
  let u = url.trim();
  if (u.startsWith("//")) u = "https:" + u;
  if (u.startsWith("https:/") && !u.startsWith("https://")) u = u.replace(/^https:\/(?!\/)/, "https://");
  if (u.startsWith("http:/") && !u.startsWith("http://")) u = u.replace(/^http:\/(?!\/)/, "http://");
  if (base && !/^https?:\/\//i.test(u)) {
    try { u = new URL(u, base).href; } catch { /* keep */ }
  }
  return stripUrlQueryAndHash(u);
}

export function basenameFromUrl(url: string): string {
  try {
    const p = new URL(stripUrlQueryAndHash(url)).pathname;
    const base = p.slice(p.lastIndexOf("/") + 1);
    return base || "asset";
  } catch {
    const clean = stripUrlQueryAndHash(url);
    return clean.slice(clean.lastIndexOf("/") + 1) || "asset";
  }
}
