import { createHash } from "node:crypto";

/**
 * Deterministic helpers. Everything the compiler emits must be byte-stable for
 * the same input capture (rubric Gate 6), so all JSON is serialized through
 * canonicalStringify (recursively sorted keys, fixed formatting) and all IDs are
 * derived from content hashes or stable indices — never time or randomness.
 */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, 2-space indent, trailing newline. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

/** Compact canonical JSON (sorted keys, no whitespace) — for large artifacts. */
export function compactStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

export function sha1_8(input: string): string {
  return sha1(input).slice(0, 8);
}

export function sha1_12(input: string): string {
  return sha1(input).slice(0, 12);
}

/** Round to a fixed precision so sub-pixel jitter does not change output. */
export function round(n: number, decimals = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
