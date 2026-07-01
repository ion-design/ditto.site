import type { FileFacet } from "./backend.js";

export type FileMeta = { path: string; type: "text" | "binary"; bytes: number; sha256: string };

/** Minimal glob → RegExp: `**` = any (incl. `/`), `*` = any except `/`, `?` = one
 *  non-`/`. Sufficient for `**​/*.tsx`, `src/app/*.css`, etc. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

export function metaOf(facets: FileFacet[]): FileMeta[] {
  return facets.map((f) => ({ path: f.path, type: f.kind, bytes: f.bytes, sha256: f.sha256 }));
}

/** Filter file metadata by glob and/or route (Next = `src/app/<seg>`, Vite = `src/routes/<key>`). */
export function filterMetas(metas: FileMeta[], opts: { glob?: string; route?: string }): FileMeta[] {
  let out = metas;
  if (opts.glob) {
    const re = globToRegExp(opts.glob);
    out = out.filter((m) => re.test(m.path));
  }
  if (opts.route && opts.route !== "/") {
    const seg = opts.route.replace(/^\/+/, "").replace(/\/+$/, "");
    const viteKey = seg.replace(/\//g, "__") || "home";
    out = out.filter((m) =>
      m.path === `src/app/${seg}` || m.path.startsWith(`src/app/${seg}/`) ||
      m.path === `src/routes/${viteKey}` || m.path.startsWith(`src/routes/${viteKey}/`)
    );
  }
  return out;
}

/** Opaque numeric-offset pagination over a sorted list. */
export function paginate<T>(arr: T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor?: string } {
  const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
  const items = arr.slice(offset, offset + limit);
  const next = offset + limit;
  return next < arr.length ? { items, nextCursor: String(next) } : { items };
}

export type ReadFileEntry =
  | { path: string; type: "text"; bytes: number; sha256: string; content: string }
  | { path: string; type: "text"; bytes: number; sha256: string; skipped: true; reason: string }
  | { path: string; type: "binary"; bytes: number; sha256: string; url: string }
  | { path: string; error: string };

/** Read the requested paths with a per-call text-size budget. Binaries are always
 *  returned as URLs (never bytes); text over budget is flagged skipped, so a careless
 *  `["**"]` (no exact match anyway) can't flood the consumer's context. */
export async function readFiles(
  facets: FileFacet[],
  paths: string[],
  opts: { maxBytes?: number; resolveUrl?: (u: string) => string },
): Promise<{ files: ReadFileEntry[]; totalBytes: number; truncated: boolean }> {
  const budget = opts.maxBytes ?? 256 * 1024;
  const byPath = new Map(facets.map((f) => [f.path, f]));
  const out: ReadFileEntry[] = [];
  let used = 0;
  let truncated = false;
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) {
      out.push({ path: p, error: "not found" });
      continue;
    }
    if (f.kind === "binary") {
      let url = f.binaryUrl ? await f.binaryUrl() : "";
      if (opts.resolveUrl) url = opts.resolveUrl(url);
      out.push({ path: p, type: "binary", bytes: f.bytes, sha256: f.sha256, url });
      continue;
    }
    if (used + f.bytes > budget) {
      out.push({ path: p, type: "text", bytes: f.bytes, sha256: f.sha256, skipped: true, reason: "per-call size budget exceeded" });
      truncated = true;
      continue;
    }
    used += f.bytes;
    out.push({ path: p, type: "text", bytes: f.bytes, sha256: f.sha256, content: f.content ?? "" });
  }
  return { files: out, totalBytes: used, truncated };
}
