import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalStringify, compactStringify } from "./canonical.js";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeText(file: string, text: string): void {
  ensureDir(dirname(file));
  writeFileSync(file, text);
}

export function writeBytes(file: string, bytes: Buffer): void {
  ensureDir(dirname(file));
  writeFileSync(file, bytes);
}

/** Write canonical (pretty, sorted) JSON. Use for human-inspectable manifests. */
export function writeJSON(file: string, value: unknown): void {
  writeText(file, canonicalStringify(value));
}

/** Write compact canonical JSON. Use for large machine artifacts (DOM dumps). */
export function writeJSONCompact(file: string, value: unknown): void {
  writeText(file, compactStringify(value));
}

export function readJSON<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readText(file: string): string {
  return readFileSync(file, "utf8");
}

export function fileExists(file: string): boolean {
  return existsSync(file);
}
