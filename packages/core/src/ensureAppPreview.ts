/**
 * App preview: build the generated Next.js/Vite clone in the shared harness and
 * publish the static export into `generated/app/public/app-preview/` so it rides
 * the existing file-map + storage plumbing and the API can serve a browsable,
 * styled homepage (no client-side build step).
 *
 * Root-absolute references (`/_next/…`, `/assets/…`, `/static/…`) are rewritten
 * depth-aware to relative paths in .html/.css so the export works from ANY mount
 * path (e.g. `/v1/clones/:id/app-preview/`). Rewrites only touch quoted attribute
 * values and CSS url() — inline flight-data strings are left alone.
 *
 * Determinism note: preview output embeds Next build ids and is NOT byte-stable;
 * it lives outside every determinism surface (Gate 6 regenerates into temp dirs,
 * gate6b hashes only `public/static` + `assets-store`).
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildApp, DEFAULT_HARNESS_DIR } from "clone-static";

export type AppPreviewResult = {
  ok: boolean;
  previewMs: number;
  /** files published under public/app-preview/ (0 when the build failed) */
  files: number;
  error?: string;
};

const REWRITE_ROOTS = ["_next", "assets", "static"];

/** Rewrite root-absolute references to depth-aware relative ones. `depth` is the
 *  file's directory depth below the export root (0 for /index.html). */
export function relativizeExportRefs(content: string, depth: number, kind: "html" | "css"): string {
  const rel = depth === 0 ? "./" : "../".repeat(depth);
  let out = content;
  for (const root of REWRITE_ROOTS) {
    if (kind === "html") {
      // src="/assets/…", href='/_next/…', poster="/assets/…", content="/assets/…"
      out = out.replace(
        new RegExp(`(src|href|poster|content)=(["'])/${root}/`, "g"),
        (_m, attr, q) => `${attr}=${q}${rel}${root}/`,
      );
      // srcset can carry several comma-separated URLs inside one attribute value.
      out = out.replace(/srcset=(["'])([^"']*)\1/g, (_m, q, val: string) => {
        let v = val;
        for (const r of REWRITE_ROOTS) v = v.split(`/${r}/`).join(`${rel}${r}/`);
        return `srcset=${q}${v}${q}`;
      });
    }
    // url(/assets/…), url("/assets/…"), url('/_next/…') — html <style> blocks too.
    out = out.replace(
      new RegExp(`url\\((["']?)/${root}/`, "g"),
      (_m, q) => `url(${q}${rel}${root}/`,
    );
  }
  return out;
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function ensureAppPreview(
  runDir: string,
  opts?: { harnessDir?: string; log?: (e: Record<string, unknown>) => void },
): AppPreviewResult {
  const t0 = Date.now();
  const log = opts?.log ?? (() => {});
  const appDir = join(runDir, "generated", "app");
  const previewDir = join(appDir, "public", "app-preview");
  // Never let a stale preview ride into the harness copy (self-inclusion).
  rmSync(previewDir, { recursive: true, force: true });
  if (!existsSync(appDir)) {
    return { ok: false, previewMs: Date.now() - t0, files: 0, error: "no generated app at " + appDir };
  }

  log({ event: "app_build_start" });
  const build = buildApp(appDir, opts?.harnessDir ?? DEFAULT_HARNESS_DIR);
  if (!build.ok || !build.outDir) {
    log({ event: "app_build_done", ok: false, ms: build.durationMs });
    return { ok: false, previewMs: Date.now() - t0, files: 0, error: build.stderr.slice(-2000) };
  }

  cpSync(build.outDir, previewDir, { recursive: true });
  let files = 0;
  for (const file of walkFiles(previewDir)) {
    files++;
    const isHtml = file.endsWith(".html");
    const isCss = file.endsWith(".css");
    if (!isHtml && !isCss) continue;
    const depth = relative(previewDir, file).split(sep).length - 1;
    const src = readFileSync(file, "utf8");
    const rewritten = relativizeExportRefs(src, depth, isHtml ? "html" : "css");
    if (rewritten !== src) writeFileSync(file, rewritten);
  }
  log({ event: "app_build_done", ok: true, ms: build.durationMs, files });
  return { ok: true, previewMs: Date.now() - t0, files };
}
