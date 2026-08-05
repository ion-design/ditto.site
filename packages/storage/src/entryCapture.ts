import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { makeTarGz } from "./bundle.js";

const toPosix = (path: string): string =>
  sep === "/" ? path : path.split(sep).join("/");

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/** Package an entry capture for private, durable storage. */
export function packEntryCapture(sourceDir: string): Buffer {
  const files = [...walkFiles(sourceDir)].map((path) => ({
    path: toPosix(relative(sourceDir, path)),
    bytes: readFileSync(path),
  }));
  return makeTarGz(files);
}

function safeRelativePath(path: string): string {
  const normalized = normalize(path);
  if (
    !path ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split(/[/\\]/).includes("..")
  ) {
    throw new Error(`unsafe entry-capture path: ${path}`);
  }
  return normalized;
}

function tarString(block: Buffer, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

/** Restore a private capture archive. Only regular files emitted by makeTarGz
 * are accepted, and every path is constrained to the destination directory. */
export function unpackEntryCapture(
  bytes: Buffer,
  destinationDir: string,
): void {
  const tar = gunzipSync(bytes);
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = safeRelativePath(prefix ? `${prefix}/${name}` : name);
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = header[156];
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid entry-capture archive size");
    }
    if (type !== 0 && type !== 48) {
      throw new Error("unsupported entry-capture archive entry");
    }

    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error("truncated entry-capture archive");
    entries.push({ path, bytes: tar.subarray(start, end) });
    offset = start + Math.ceil(size / 512) * 512;
  }

  rmSync(destinationDir, { recursive: true, force: true });
  for (const entry of entries) {
    const destination = join(destinationDir, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.bytes);
  }
}
