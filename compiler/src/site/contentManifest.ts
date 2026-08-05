import { createHash } from "node:crypto";

export type DittoExtractionFailure = {
  familyKey?: string;
  manifestKey?: string;
  sourceType?: string;
  sourceId?: string | number;
  sourceUrl?: string;
  routePath?: string;
  reason: string;
};

export type DittoExtractionMetadata = {
  adapter: "wordpress-rest" | "generic-jsonld" | "composite";
  adapterVersion: "1";
  extractedAt: string;
  discoveredCount: number;
  extractedCount: number;
  failures: DittoExtractionFailure[];
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deterministicExtractionDate(
  families: Array<{ entries: Array<{ document: { publishedAt?: string } }> }>,
): string {
  const dates = families
    .flatMap((family) =>
      family.entries.map((entry) => entry.document.publishedAt),
    )
    .filter(
      (value): value is string =>
        Boolean(value) && !Number.isNaN(Date.parse(value!)),
    )
    .map((value) => new Date(value).toISOString())
    .sort();
  return dates.at(-1) ?? "1970-01-01T00:00:00.000Z";
}
