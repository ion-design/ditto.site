import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, basename, relative, sep } from "node:path";
import type { CollectedFile, FileMap } from "./types.js";

/** Extensions whose bytes are returned inline as UTF-8 text (the code a consumer
 *  reads). Everything else under public/assets (images/fonts/video) is binary and
 *  returned by reference. */
const TEXT_EXTS = new Set([
  ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".css", ".json",
  ".html", ".xml", ".txt", ".md", ".map", ".d.ts",
]);

function isTextFile(path: string): boolean {
  const base = basename(path);
  if (base === ".gitignore" || base === "next-env.d.ts") return true;
  return TEXT_EXTS.has(extname(path).toLowerCase());
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

/** Collect the generated app (`<runDir>/generated/app/`) into a file map keyed
 *  by app-relative POSIX path. Text files inline their content; binaries carry a
 *  local path + sha256 for the storage layer to upload and presign. Keys are sorted
 *  so the map is deterministic for the same generated app (golden-file friendly). */
export function collectFileMap(runDir: string): FileMap {
  const appDir = join(runDir, "generated", "app");
  if (!existsSync(appDir)) {
    throw new Error(`collectFileMap: no generated app at ${appDir}`);
  }
  const files: CollectedFile[] = [];
  for (const abs of walk(appDir)) {
    const rel = toPosix(relative(appDir, abs));
    const buf = readFileSync(abs);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const bytes = statSync(abs).size;
    if (isTextFile(rel)) {
      files.push({ path: rel, kind: "text", bytes, sha256, content: buf.toString("utf8"), absPath: abs });
    } else {
      files.push({ path: rel, kind: "binary", bytes, sha256, absPath: abs });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const map: FileMap = {};
  for (const f of files) map[f.path] = f;
  return map;
}

/** Total bytes + file count for a quick overview (the cheap metadata an MCP
 *  `get_clone_result` returns before any file content is read). */
export function fileMapStats(files: FileMap): { fileCount: number; totalBytes: number } {
  let totalBytes = 0;
  const vals = Object.values(files);
  for (const f of vals) totalBytes += f.bytes;
  return { fileCount: vals.length, totalBytes };
}
