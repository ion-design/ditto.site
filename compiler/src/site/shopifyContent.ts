import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DittoContentDocument } from "./contentHandoff.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_STOREFRONT_CANDIDATES = 8;
const COLLECTION_PAGE_SIZE = 250;
const MAX_COLLECTION_PAGES = 4;
const MAX_CACHED_COLLECTION_PRODUCTS = 5_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(strings);
}

function text(value: unknown): string | undefined {
  return strings(value)[0];
}

function numberValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[^0-9.-]/g, ""))
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textFromHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(
      /&([a-z]+);/gi,
      (whole, name: string) => named[name.toLowerCase()] ?? whole,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return undefined;
  return new Date(value).toISOString();
}

function absoluteImage(value: unknown, sourceUrl: string): string | undefined {
  const source = text(record(value)?.src ?? value);
  if (!source) return undefined;
  try {
    return new URL(
      source.startsWith("//") ? `https:${source}` : source,
      sourceUrl,
    ).toString();
  } catch {
    return undefined;
  }
}

function titleFromHandle(handle: string): string {
  return handle
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function isMyshopifyOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchJson(
  url: string,
  allowedOrigins: ReadonlySet<string>,
): Promise<unknown> {
  const target = new URL(url);
  if (!allowedOrigins.has(target.origin))
    throw new Error(`Shopify request origin is not allowed: ${target.origin}`);
  const response = await fetch(target, {
    headers: {
      Accept: "application/json, text/javascript",
      "User-Agent": "ditto.site Shopify content handoff/1.0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const finalOrigin = new URL(response.url).origin;
  if (!response.ok || !allowedOrigins.has(finalOrigin))
    throw new Error(`Shopify request failed with HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_RESPONSE_BYTES)
    throw new Error("Shopify response exceeded the byte limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new Error("Shopify response exceeded the byte limit");
  return JSON.parse(new TextDecoder().decode(bytes));
}

function productDocument(
  payload: JsonRecord,
  sourceUrl: string,
  pricesAreCents: boolean,
): DittoContentDocument | null {
  const title = text(payload.title);
  const handle = text(payload.handle);
  if (!title || !handle) return null;
  const variants = Array.isArray(payload.variants)
    ? payload.variants.map(record).filter((item): item is JsonRecord => !!item)
    : [];
  const firstVariant = variants[0];
  const priceRaw = numberValue(firstVariant?.price ?? payload.price);
  const compareAtRaw = numberValue(
    firstVariant?.compare_at_price ?? payload.compare_at_price,
  );
  const price =
    priceRaw === undefined
      ? undefined
      : pricesAreCents
        ? priceRaw / 100
        : priceRaw;
  const compareAtPrice =
    compareAtRaw === undefined
      ? undefined
      : pricesAreCents
        ? compareAtRaw / 100
        : compareAtRaw;
  const imageValues = Array.isArray(payload.images) ? payload.images : [];
  const images = [
    ...new Set(
      [payload.featured_image, ...imageValues]
        .map((image) => absoluteImage(image, sourceUrl))
        .filter((image): image is string => !!image),
    ),
  ];
  const descriptionHtml =
    text(payload.description) ?? text(payload.body_html) ?? "";
  const description = textFromHtml(descriptionHtml);
  const vendor = text(payload.vendor);
  const sku = text(firstVariant?.sku);
  const optionDefinitions = Array.isArray(payload.options)
    ? payload.options.map(record).filter((item): item is JsonRecord => !!item)
    : [];
  const sizeDefinition = optionDefinitions.find(
    (option) => text(option.name)?.toLowerCase() === "size",
  );
  const sizes = sizeDefinition
    ? [...new Set(strings(sizeDefinition.values))]
    : [];
  const tags = [
    ...new Set(
      Array.isArray(payload.tags)
        ? strings(payload.tags)
        : (text(payload.tags) ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
    ),
  ];
  const publishedAt = isoDate(payload.published_at);
  const custom: NonNullable<DittoContentDocument["fields"]["custom"]> = {
    sourceUrl,
  };
  if (price !== undefined) custom.price = price;
  if (compareAtPrice !== undefined) custom.compareAtPrice = compareAtPrice;
  if (images.length) custom.images = images;
  if (typeof payload.available === "boolean")
    custom.available = payload.available;
  if (vendor) custom.vendor = vendor;
  if (sku) custom.sku = sku;
  if (sizes.length) custom.sizes = sizes;
  return {
    title,
    ...(publishedAt ? { publishedAt } : {}),
    fields: {
      ...(description ? { description } : {}),
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      ...(tags.length ? { tags } : {}),
      seo: {
        metaTitle: title,
        ...(description ? { metaDescription: description } : {}),
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom,
    },
    body: description,
  };
}

function collectionDocument(
  products: JsonRecord[],
  routePath: string,
  sourceUrl: string,
): DittoContentDocument {
  const handle = routePath.split("/").filter(Boolean).at(-1) ?? "collection";
  const title = titleFromHandle(handle);
  const productHandles = [
    ...new Set(
      products
        .map((product) => text(product.handle))
        .filter((value): value is string => !!value),
    ),
  ];
  const images = [
    ...new Set(
      products
        .map((product) => {
          const firstImage = Array.isArray(product.images)
            ? product.images[0]
            : undefined;
          return absoluteImage(
            record(firstImage)?.src ?? firstImage ?? product.image,
            sourceUrl,
          );
        })
        .filter((value): value is string => !!value),
    ),
  ];
  return {
    title,
    fields: {
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      seo: {
        metaTitle: title,
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom: {
        sourceUrl,
        ...(productHandles.length ? { productHandles } : {}),
        ...(images.length ? { images } : {}),
      },
    },
    body: "",
  };
}

function articleDocument(
  payload: JsonRecord,
  sourceUrl: string,
): DittoContentDocument | null {
  const article =
    record(payload.article) ?? record(payload.page) ?? record(payload);
  if (!article) return null;
  const title = text(article.title);
  if (!title) return null;
  const bodyHtml =
    text(article.body_html) ??
    text(article.content) ??
    text(article.description) ??
    "";
  const body = textFromHtml(bodyHtml);
  const description = textFromHtml(
    text(article.summary_html) ?? text(article.excerpt) ?? bodyHtml,
  );
  const image = absoluteImage(article.image, sourceUrl);
  const author = text(record(article.author)?.name ?? article.author);
  const publishedAt = isoDate(article.published_at ?? article.created_at);
  const tags = [
    ...new Set(
      Array.isArray(article.tags)
        ? strings(article.tags)
        : (text(article.tags) ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
    ),
  ];
  return {
    title,
    ...(publishedAt ? { publishedAt } : {}),
    fields: {
      ...(description ? { description } : {}),
      ...(image ? { heroImageUrl: image } : {}),
      ...(author ? { authorName: author } : {}),
      ...(tags.length ? { tags } : {}),
      seo: {
        metaTitle: title,
        ...(description ? { metaDescription: description } : {}),
        ...(image ? { ogImageUrl: image } : {}),
      },
      custom: { sourceUrl },
    },
    body,
  };
}

export function shopifyStorefrontOriginsFromCapture(
  sourceDir: string,
): string[] {
  const captureDir = join(sourceDir, "capture");
  let names: string[];
  try {
    names = readdirSync(captureDir)
      .filter((name) => /^dom-\d+\.json$/.test(name))
      .sort((left, right) => {
        const preferred = (name: string) => (name === "dom-1280.json" ? 0 : 1);
        return preferred(left) - preferred(right) || left.localeCompare(right);
      });
  } catch {
    return [];
  }
  for (const name of names) {
    const path = join(captureDir, name);
    try {
      if (statSync(path).size > MAX_CAPTURE_BYTES) continue;
      const raw = readFileSync(path, "utf8");
      const counts = new Map<string, number>();
      for (const match of raw.matchAll(
        /(?<![a-z0-9%.-])(?:https?:\\?\/\\?\/)?([a-z0-9][a-z0-9-]*\.myshopify\.com)/gi,
      )) {
        const origin = `https://${match[1]!.toLowerCase()}`;
        if (!isMyshopifyOrigin(origin)) continue;
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      }
      return [...counts]
        .sort(
          ([left, leftCount], [right, rightCount]) =>
            rightCount - leftCount || left.localeCompare(right),
        )
        .slice(0, MAX_STOREFRONT_CANDIDATES)
        .map(([origin]) => origin);
    } catch {
      // A missing or oversized viewport does not discard the other captures.
    }
  }
  return [];
}

export function capturedStructuredHtmlFromSourceDir(
  sourceDir: string,
): string | undefined {
  const path = join(sourceDir, "capture", "dom-1280.json");
  try {
    if (statSync(path).size > MAX_CAPTURE_BYTES) return undefined;
    const snapshot = record(JSON.parse(readFileSync(path, "utf8")));
    const doc = record(snapshot?.doc);
    const head = record(doc?.head);
    if (!doc || !head) return undefined;
    const title = text(doc.title);
    const description = text(head.description);
    const ogTitle = text(head.ogTitle);
    const ogDescription = text(head.ogDescription);
    const ogImage = text(head.ogImage);
    const jsonLd = Array.isArray(head.jsonLd)
      ? head.jsonLd
          .map((item) => text(record(item)?.text))
          .filter((item): item is string => !!item)
      : [];
    return [
      "<html><head>",
      ...(title ? [`<title>${escapeHtml(title)}</title>`] : []),
      ...(description
        ? [`<meta name="description" content="${escapeHtml(description)}">`]
        : []),
      ...(ogTitle
        ? [`<meta property="og:title" content="${escapeHtml(ogTitle)}">`]
        : []),
      ...(ogDescription
        ? [
            `<meta property="og:description" content="${escapeHtml(ogDescription)}">`,
          ]
        : []),
      ...(ogImage
        ? [`<meta property="og:image" content="${escapeHtml(ogImage)}">`]
        : []),
      ...jsonLd.map(
        (value) => `<script type="application/ld+json">${value}</script>`,
      ),
      "</head></html>",
    ].join("");
  } catch {
    return undefined;
  }
}

export async function resolveShopifyStorefrontOrigin(params: {
  sourceOrigin: string;
  candidates: string[];
  productPath?: string;
  collectionPath?: string;
}): Promise<string | undefined> {
  const candidates = [
    ...(isMyshopifyOrigin(params.sourceOrigin) ? [params.sourceOrigin] : []),
    ...params.candidates.filter(isMyshopifyOrigin),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const allowed = new Set([params.sourceOrigin, ...candidates]);
  for (const candidate of candidates.slice(0, MAX_STOREFRONT_CANDIDATES)) {
    if (params.productPath) {
      try {
        const handle = params.productPath.split("/").filter(Boolean).at(-1);
        const payload = record(
          await fetchJson(`${candidate}${params.productPath}.js`, allowed),
        );
        if (payload && text(payload.handle) === handle) return candidate;
      } catch {
        // A custom-domain product redirect can be protected while the native
        // collection endpoint remains a valid storefront ownership proof.
      }
    }
    if (params.collectionPath) {
      try {
        const payload = record(
          await fetchJson(
            `${candidate}${params.collectionPath}/products.json?limit=1`,
            allowed,
          ),
        );
        if (payload && Array.isArray(payload.products)) return candidate;
      } catch {
        // Captured pages can mention app-owned shops. Only a matching catalog proves
        // which myshopify host backs the source storefront.
      }
    }
  }
  return undefined;
}

export async function extractShopifyDocument(params: {
  sourceOrigin: string;
  storefrontOrigin?: string;
  routePath: string;
  kind: string;
  productDocuments?: Map<string, DittoContentDocument>;
}): Promise<DittoContentDocument | null> {
  const sourceUrl = params.sourceOrigin + params.routePath;
  const allowed = new Set([
    params.sourceOrigin,
    ...(params.storefrontOrigin ? [params.storefrontOrigin] : []),
  ]);
  try {
    if (params.kind === "product") {
      const expectedHandle = params.routePath.split("/").filter(Boolean).at(-1);
      const cached = expectedHandle
        ? params.productDocuments?.get(expectedHandle)
        : undefined;
      if (cached) return cached;
      const payload = record(await fetchJson(`${sourceUrl}.js`, allowed));
      if (payload && text(payload.handle) === expectedHandle)
        return productDocument(payload, sourceUrl, true);
    }
    if (params.kind === "collection" && params.storefrontOrigin) {
      const products: JsonRecord[] = [];
      for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
        const url = new URL(
          `${params.storefrontOrigin}${params.routePath}/products.json`,
        );
        url.search = new URLSearchParams({
          limit: String(COLLECTION_PAGE_SIZE),
          page: String(page),
        }).toString();
        const payload = record(await fetchJson(url.toString(), allowed));
        if (!payload || !Array.isArray(payload.products)) return null;
        const batch = payload.products
          .map(record)
          .filter((item): item is JsonRecord => !!item);
        products.push(...batch);
        if (params.productDocuments) {
          for (const product of batch) {
            if (params.productDocuments.size >= MAX_CACHED_COLLECTION_PRODUCTS)
              break;
            const handle = text(product.handle);
            if (!handle || params.productDocuments.has(handle)) continue;
            const productSourceUrl = `${params.sourceOrigin}/products/${handle}`;
            const document = productDocument(product, productSourceUrl, false);
            if (document) params.productDocuments.set(handle, document);
          }
        }
        if (batch.length < COLLECTION_PAGE_SIZE) break;
      }
      return collectionDocument(products, params.routePath, sourceUrl);
    }
    if (params.kind === "article") {
      for (const origin of [
        params.sourceOrigin,
        ...(params.storefrontOrigin ? [params.storefrontOrigin] : []),
      ]) {
        try {
          const payload = record(
            await fetchJson(`${origin}${params.routePath}.json`, allowed),
          );
          if (payload) {
            const document = articleDocument(payload, sourceUrl);
            if (document) return document;
          }
        } catch {
          // Native Shopify article JSON is optional; generic HTML remains next.
        }
      }
    }
  } catch {
    // Storefront JSON is an optimization/fallback. Generic structured HTML is
    // still attempted by the handoff builder.
  }
  return null;
}
