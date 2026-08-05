import type { CrawlResult } from "../crawl/crawl.js";
import type {
  CollapsedCollection,
  RoutePlan,
} from "../crawl/routeTemplates.js";
import { routeToSegment } from "./generateSite.js";
import type {
  IonClonePlanV1,
  IonManifestPlan,
  IonPlannedCloneBundleExtension,
  IonRendererPlan,
} from "./plannedClone.js";
import {
  deterministicExtractionDate,
  sha256Json,
  type DittoExtractionMetadata,
  type DittoExtractionFailure,
} from "./contentManifest.js";
import {
  extractShopifyDocument,
  resolveShopifyStorefrontOrigin,
} from "./shopifyContent.js";
import { extractWordpressContent } from "./wordpressContent.js";

export const DITTO_CONTENT_BUNDLE_PATH = ".ion/ditto-content-bundle.json";
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ENTRY_LINKS = 500;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_CONTENT_ENTRIES = 10_000;
const MAX_COLLECTION_REFERENCED_PRODUCTS = 5_000;
const SHOPIFY_PRODUCT_HANDLE = /^[a-z0-9][a-z0-9-]{0,199}$/;

type FieldType =
  | "text"
  | "textarea"
  | "date"
  | "image"
  | "list"
  | "boolean"
  | "reference"
  | "number"
  | "select"
  | "url"
  | "color";

export type DittoCmsFieldDefinition = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  description?: string;
};

export type DittoContentDocument = {
  title: string;
  publishedAt?: string;
  fields: {
    description?: string;
    heroImageUrl?: string;
    authorName?: string;
    tags?: string[];
    seo?: {
      metaTitle?: string;
      metaDescription?: string;
      ogImageUrl?: string;
      noIndex?: boolean;
    };
    custom?: Record<string, string | number | boolean | string[]>;
  };
  body: string;
};

export type DittoContentEntry = {
  sourceUrl: string;
  routePath: string;
  slug: string;
  document: DittoContentDocument;
  contentHash: string;
};

export type DittoContentFamily = {
  key: string;
  label: string;
  description: string;
  origin: "import";
  kind: string;
  manifestKeys?: string[];
  routePattern: string;
  indexPath: string | null;
  representativeRoute: string;
  template: { module: string; exportName: "default" };
  fieldSchema: DittoCmsFieldDefinition[];
  entries: DittoContentEntry[];
};

export type DittoRouteDisposition = {
  routePath: string;
  disposition: "cloned" | "cms" | "passthrough" | "unresolved";
  familyKey?: string;
  targetUrl?: string;
  reason?: string;
};

export type DittoContentBundleV1 = {
  schema: "ion-cms-v1";
  version: 1;
  source: {
    url: string;
    origin: string;
    platform: string;
    scope: "entry-links" | "cms-manifests";
  };
  families: DittoContentFamily[];
  routes: DittoRouteDisposition[];
  coverage: {
    discovered: number;
    cloned: number;
    cms: number;
    passthrough: number;
    unresolved: number;
  };
  /** Additive, private route topology contract. Present only when Ion supplied
   *  an explicit plan under the `ion-cms-v1` opt-in. */
  plannedClone?: IonPlannedCloneBundleExtension;
  extraction?: DittoExtractionMetadata;
  manifestHash?: string;
};

type FamilySpec = Pick<
  DittoContentFamily,
  "key" | "label" | "kind" | "fieldSchema"
>;
type JsonRecord = Record<string, unknown>;

const PRODUCT_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "price", label: "Price", type: "number" },
  { key: "compareAtPrice", label: "Compare-at price", type: "number" },
  { key: "currency", label: "Currency", type: "text" },
  { key: "images", label: "Images", type: "list" },
  { key: "available", label: "Available", type: "boolean" },
  { key: "vendor", label: "Vendor", type: "text" },
  { key: "sku", label: "SKU", type: "text" },
  { key: "sizes", label: "Sizes", type: "list" },
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

const COLLECTION_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "productHandles", label: "Product handles", type: "list" },
  { key: "images", label: "Images", type: "list" },
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

const PAGE_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

function familySpec(collection: CollapsedCollection): FamilySpec | null {
  const segments = collection.template
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const first = segments[0];
  if (first === "products")
    return {
      key: "products",
      label: "Products",
      kind: "product",
      fieldSchema: PRODUCT_FIELDS,
    };
  if (first === "collections")
    return {
      key: "collections",
      label: "Collections",
      kind: "collection",
      fieldSchema: COLLECTION_FIELDS,
    };
  if (first === "pages")
    return {
      key: "pages",
      label: "Pages",
      kind: "page",
      fieldSchema: PAGE_FIELDS,
    };
  if (
    segments.some((segment) =>
      ["blog", "blogs", "articles", "news"].includes(segment),
    )
  ) {
    return {
      key: "articles",
      label: "Articles",
      kind: "article",
      fieldSchema: PAGE_FIELDS,
    };
  }
  return null;
}

function plannedFamilySpec(manifest: IonManifestPlan): FamilySpec {
  const value = `${manifest.key} ${manifest.entityType}`.toLowerCase();
  if (/\bproducts?\b/.test(value))
    return {
      key: "products",
      label: "Products",
      kind: "product",
      fieldSchema: PRODUCT_FIELDS,
    };
  if (/\bcollections?\b/.test(value))
    return {
      key: "collections",
      label: "Collections",
      kind: "collection",
      fieldSchema: COLLECTION_FIELDS,
    };
  if (/\b(articles?|posts?|blogs?|news)\b/.test(value))
    return {
      key: "articles",
      label: "Articles",
      kind: "article",
      fieldSchema: PAGE_FIELDS,
    };
  if (/\bpages?\b/.test(value))
    return {
      key: "pages",
      label: "Pages",
      kind: "page",
      fieldSchema: PAGE_FIELDS,
    };
  // Unknown agent-authored manifests are still safely extractable as page-like
  // JSON-LD documents. The emitted family preserves the manifest's own key/kind.
  return {
    key: "pages",
    label: "Pages",
    kind: "page",
    fieldSchema: PAGE_FIELDS,
  };
}

function matchesRoutePattern(pattern: string, routePath: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const routeSegments = routePath.split("/").filter(Boolean);
  return (
    patternSegments.length === routeSegments.length &&
    patternSegments.every(
      (segment, index) =>
        /^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment) ||
        segment === routeSegments[index],
    )
  );
}

function rootRenderer(
  renderer: IonRendererPlan,
  renderers: Map<string, IonRendererPlan>,
): IonRendererPlan {
  return renderer.reuseRendererKey
    ? rootRenderer(renderers.get(renderer.reuseRendererKey)!, renderers)
    : renderer;
}

function entryRenderersForManifest(
  plan: IonClonePlanV1,
  manifestKey: string,
  kind?: string,
): IonRendererPlan[] {
  const candidates = plan.renderers.filter(
    (renderer) =>
      renderer.pattern.includes("[") &&
      renderer.manifestKeys.includes(manifestKey),
  );
  const detail = candidates.filter(
    (renderer) =>
      renderer.role === "detail" && renderer.manifestKeys.length === 1,
  );
  if (detail.length) return detail;
  const unambiguous = candidates.filter(
    (renderer) => renderer.manifestKeys.length === 1,
  );
  if (unambiguous.length) return unambiguous;
  const preferredRole =
    /\b(articles?|posts?|products?|pages?|entries?|items?)\b/i.test(
      manifestKey.replace(/-/g, " "),
    )
      ? "detail"
      : /\b(collections?|categories?|blogs?|indexes?)\b/i.test(
            manifestKey.replace(/-/g, " "),
          )
        ? kind === "collection"
          ? "listing"
          : "index"
        : null;
  const preferred = preferredRole
    ? candidates.filter((renderer) => renderer.role === preferredRole)
    : [];
  if (preferred.length === 1) return preferred;
  // Commerce planners commonly model /collections/[slug] as one shared listing
  // renderer backed by both collection metadata and product entries. For the
  // collection manifest, that dynamic listing is also the entry route.
  return kind === "collection"
    ? candidates.filter((renderer) => renderer.role === "listing")
    : [];
}

function partitionPlannedFamilies(
  families: DittoContentFamily[],
  plan: IonClonePlanV1,
  origin: string,
): DittoContentFamily[] {
  const rendererByKey = new Map(
    plan.renderers.map((renderer) => [renderer.key, renderer]),
  );
  const partitioned: DittoContentFamily[] = [];

  for (const family of families) {
    const manifestKey =
      family.manifestKeys?.length === 1 ? family.manifestKeys[0] : undefined;
    if (!manifestKey) {
      partitioned.push(family);
      continue;
    }

    const renderers = entryRenderersForManifest(plan, manifestKey, family.kind);
    const entriesByPattern = new Map<string, DittoContentEntry[]>();
    for (const entry of family.entries) {
      const renderer = renderers.find((candidate) =>
        matchesRoutePattern(candidate.pattern, entry.routePath),
      );
      if (!renderer) continue;
      const entries = entriesByPattern.get(renderer.pattern) ?? [];
      entries.push(entry);
      entriesByPattern.set(renderer.pattern, entries);
    }

    const allManifestRenderers = plan.renderers.filter((renderer) =>
      renderer.manifestKeys.includes(manifestKey),
    );
    const indexPath =
      allManifestRenderers.find((renderer) => renderer.role === "index")
        ?.pattern ??
      allManifestRenderers.find((renderer) => renderer.role === "listing")
        ?.pattern ??
      null;
    for (const renderer of renderers) {
      const entries = entriesByPattern.get(renderer.pattern);
      if (!entries?.length) continue;
      const root = rootRenderer(renderer, rendererByKey);
      const representativeRoute =
        root.captureUrl &&
        entries.some((entry) => entry.routePath === root.captureUrl)
          ? root.captureUrl
          : entries[0]!.routePath;
      const representativeDir = routeToSegment(
        root.captureUrl ?? representativeRoute,
      ).dir;
      partitioned.push({
        ...family,
        description: `Imported from ${origin} for manifest ${manifestKey}`,
        routePattern: renderer.pattern,
        indexPath,
        representativeRoute,
        template: {
          module: `src/app/${representativeDir ? `${representativeDir}/` : ""}page.tsx`,
          exportName: "default",
        },
        entries,
      });
    }
  }

  return partitioned;
}

function nextPattern(template: string): string | null {
  const matches = [...template.matchAll(/:id/g)];
  if (matches.length !== 1) return null;
  return template.replace(":id", "[slug]");
}

function slugOf(routePath: string): string {
  const last = routePath.split("/").filter(Boolean).at(-1) ?? "home";
  const slug = decodeURIComponent(last)
    .replace(/\.[A-Za-z0-9]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "entry";
}

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

function firstString(...values: unknown[]): string | undefined {
  return values.flatMap(strings).find(Boolean);
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value.replace(/[^0-9.-]/g, ""))
          : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function typesOf(value: JsonRecord): string[] {
  return strings(value["@type"]).map((type) => type.toLowerCase());
}

function allRecords(value: unknown, out: JsonRecord[] = []): JsonRecord[] {
  const valueRecord = record(value);
  if (valueRecord) {
    out.push(valueRecord);
    for (const child of Object.values(valueRecord)) allRecords(child, out);
  } else if (Array.isArray(value)) {
    for (const child of value) allRecords(child, out);
  }
  return out;
}

function jsonLdRecords(html: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  const scripts =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    const text = match[1]?.trim();
    if (!text) continue;
    try {
      allRecords(JSON.parse(text), records);
    } catch {
      // A malformed third-party block must not discard other usable structured data.
    }
  }
  return records;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(Number.parseInt(n, 16)),
    )
    .replace(
      /&([a-z]+);/gi,
      (whole, name: string) => named[name.toLowerCase()] ?? whole,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "));
}

function attr(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const a = new RegExp(
      `<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
      "i",
    ).exec(html);
    const b = new RegExp(
      `<meta\\b[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*>`,
      "i",
    ).exec(html);
    const value = a?.[1] ?? b?.[1];
    if (value) return decodeEntities(value);
  }
  return undefined;
}

function titleFromHtml(html: string): string | undefined {
  return (
    attr(html, ["og:title", "twitter:title"]) ??
    (() => {
      const value = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      return value ? stripTags(value) : undefined;
    })()
  );
}

function titleFromRoute(sourceUrl: string): string | undefined {
  const segment = new URL(sourceUrl).pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return undefined;
  const title = decodeURIComponent(segment)
    .replace(/\.[A-Za-z0-9]+$/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return title || undefined;
}

function imageUrls(value: unknown): string[] {
  const out: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (/^https?:\/\//i.test(candidate)) out.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const candidateRecord = record(candidate);
    if (candidateRecord)
      visit(candidateRecord.url ?? candidateRecord.contentUrl);
  };
  visit(value);
  return [...new Set(out)];
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return undefined;
  return new Date(value).toISOString();
}

function availability(value: unknown): boolean | undefined {
  if (typeof value !== "string") return undefined;
  if (/InStock$/i.test(value)) return true;
  if (/OutOfStock|SoldOut|Discontinued$/i.test(value)) return false;
  return undefined;
}

function offerRecords(node: JsonRecord): JsonRecord[] {
  return allRecords(node.offers).filter((candidate) =>
    typesOf(candidate).some((type) => type.includes("offer")),
  );
}

function productDocument(
  records: JsonRecord[],
  html: string,
  sourceUrl: string,
): DittoContentDocument | null {
  const product =
    records.find((candidate) =>
      typesOf(candidate).some((type) => type === "productgroup"),
    ) ??
    records.find((candidate) =>
      typesOf(candidate).some((type) => type === "product"),
    );
  const title = firstString(product?.name, titleFromHtml(html));
  if (!title) return null;
  const variants = allRecords(product?.hasVariant).filter((candidate) =>
    typesOf(candidate).includes("product"),
  );
  const offers = product ? offerRecords(product) : [];
  for (const variant of variants) offers.push(...offerRecords(variant));
  const price = numberValue(
    offers[0]?.price,
    offers[0]?.lowPrice,
    attr(html, ["product:price:amount"]),
  );
  const compareAtPrice = numberValue(
    product?.compareAtPrice,
    product?.priceSpecification,
  );
  const currency = firstString(
    offers[0]?.priceCurrency,
    attr(html, ["product:price:currency"]),
  );
  const images = [
    ...new Set([
      ...imageUrls(product?.image),
      ...variants.flatMap((variant) => imageUrls(variant.image)),
      ...strings(attr(html, ["og:image", "twitter:image"])),
    ]),
  ];
  const availableValues = offers
    .map((offer) => availability(offer.availability))
    .filter((value): value is boolean => value !== undefined);
  const brand = record(product?.brand);
  const sizes = [
    ...new Set(
      variants.flatMap((variant) =>
        strings(
          variant.size ??
            variant.name
              ?.toString()
              .match(/\b(?:XXS|XS|S|M|L|XL|XXL|\d{1,2}[A-Z]{1,2})\b/gi) ??
            [],
        ),
      ),
    ),
  ];
  const description = firstString(
    product?.description,
    attr(html, ["description", "og:description"]),
  );
  const custom: NonNullable<DittoContentDocument["fields"]["custom"]> = {
    sourceUrl,
  };
  if (price !== undefined) custom.price = price;
  if (compareAtPrice !== undefined) custom.compareAtPrice = compareAtPrice;
  if (currency) custom.currency = currency;
  if (images.length) custom.images = images;
  if (availableValues.length) custom.available = availableValues.some(Boolean);
  const vendor = firstString(brand?.name, product?.brand);
  if (vendor) custom.vendor = vendor;
  const sku = firstString(product?.sku, variants[0]?.sku);
  if (sku) custom.sku = sku;
  if (sizes.length) custom.sizes = sizes;
  return {
    title: stripTags(title),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom,
    },
    body: description ? stripTags(description) : "",
  };
}

function itemRecord(value: unknown): JsonRecord | null {
  const valueRecord = record(value);
  return record(valueRecord?.item) ?? valueRecord;
}

function handleFromUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    const productIndex = segments.lastIndexOf("products");
    return productIndex >= 0 ? (segments[productIndex + 1] ?? null) : null;
  } catch {
    return null;
  }
}

function collectionDocument(
  records: JsonRecord[],
  html: string,
  sourceUrl: string,
): DittoContentDocument | null {
  const collection = records.find((candidate) =>
    typesOf(candidate).includes("collectionpage"),
  );
  const list = allRecords(collection ?? records).find((candidate) =>
    typesOf(candidate).includes("itemlist"),
  );
  const items = Array.isArray(list?.itemListElement)
    ? list.itemListElement
        .map(itemRecord)
        .filter((item): item is JsonRecord => Boolean(item))
    : [];
  const title = firstString(collection?.name, list?.name, titleFromHtml(html));
  if (!title) return null;
  const description = firstString(
    collection?.description,
    attr(html, ["description", "og:description"]),
  );
  const productHandles = [
    ...new Set(
      items
        .map((item) => handleFromUrl(item.url ?? item["@id"]))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const images = [
    ...new Set([
      ...items.flatMap((item) => imageUrls(item.image)),
      ...strings(attr(html, ["og:image", "twitter:image"])),
    ]),
  ];
  return {
    title: stripTags(title),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom: {
        sourceUrl,
        ...(productHandles.length ? { productHandles } : {}),
        ...(images.length ? { images } : {}),
      },
    },
    body: description ? stripTags(description) : "",
  };
}

function pageDocument(
  records: JsonRecord[],
  html: string,
  sourceUrl: string,
  article: boolean,
): DittoContentDocument | null {
  const wanted = article
    ? ["article", "blogposting", "newsarticle"]
    : ["webpage", "aboutpage", "contactpage"];
  const page = records.find((candidate) =>
    typesOf(candidate).some((type) => wanted.includes(type)),
  );
  const htmlTitle = titleFromHtml(html);
  const hostLabel = new URL(sourceUrl).hostname
    .replace(/^www\./, "")
    .split(".")[0]
    ?.replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
  const routeTitle = article ? titleFromRoute(sourceUrl) : undefined;
  const genericHtmlTitle =
    article &&
    htmlTitle &&
    (htmlTitle.trim().toLowerCase() === hostLabel ||
      ["blog", "article", "news"].includes(htmlTitle.trim().toLowerCase()));
  const title = firstString(
    page?.headline,
    page?.name,
    genericHtmlTitle ? routeTitle : htmlTitle,
    routeTitle,
  );
  if (!title) return null;
  const description = firstString(
    page?.description,
    attr(html, ["description", "og:description"]),
  );
  const image = firstString(
    ...imageUrls(page?.image),
    attr(html, ["og:image", "twitter:image"]),
  );
  const author = firstString(record(page?.author)?.name, page?.author);
  const publishedAt = isoDate(page?.datePublished);
  return {
    title: stripTags(title),
    ...(publishedAt ? { publishedAt } : {}),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(image ? { heroImageUrl: image } : {}),
      ...(author ? { authorName: author } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(image ? { ogImageUrl: image } : {}),
      },
      custom: { sourceUrl },
    },
    body: description ? stripTags(description) : "",
  };
}

async function extractEntry(
  origin: string,
  routePath: string,
  spec: FamilySpec,
  shopifyStorefrontOrigin?: string,
  capturedHtml?: string,
  shopifyProductDocuments?: Map<string, DittoContentDocument>,
): Promise<DittoContentEntry | null> {
  const sourceUrl = origin + (routePath === "/" ? "/" : routePath);
  const shopifyDocument = await extractShopifyDocument({
    sourceOrigin: origin,
    ...(shopifyStorefrontOrigin
      ? { storefrontOrigin: shopifyStorefrontOrigin }
      : {}),
    routePath,
    kind: spec.kind,
    ...(shopifyProductDocuments
      ? { productDocuments: shopifyProductDocuments }
      : {}),
  });
  if (shopifyDocument) {
    const slug = slugOf(routePath);
    return {
      sourceUrl,
      routePath,
      slug,
      document: shopifyDocument,
      contentHash: sha256Json({
        sourceUrl,
        routePath,
        slug,
        document: shopifyDocument,
      }),
    };
  }
  const readHtml = async (url: string): Promise<string | null> => {
    const response = await fetch(url, {
      headers: { "User-Agent": "ditto.site content handoff/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || new URL(response.url).origin !== origin) return null;
    const declaredBytes = Number(
      response.headers?.get?.("content-length") ?? 0,
    );
    if (declaredBytes > MAX_PAGE_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PAGE_BYTES) return null;
    return new TextDecoder().decode(bytes);
  };
  let html: string | null = capturedHtml ?? null;
  if (!html) {
    try {
      html = await readHtml(sourceUrl);
    } catch {
      // Shopify storefront WAFs may protect the canonical HTML while leaving
      // suffix routes available. The structured storefront adapter ran first.
    }
  }
  if (!html && spec.kind === "article") {
    try {
      html = await readHtml(`${sourceUrl}.js`);
    } catch {
      // Third-party Shopify blog apps are not required to expose this fallback.
    }
  }
  if (!html) return null;
  const records = jsonLdRecords(html);
  const document =
    spec.kind === "product"
      ? productDocument(records, html, sourceUrl)
      : spec.kind === "collection"
        ? collectionDocument(records, html, sourceUrl)
        : pageDocument(records, html, sourceUrl, spec.kind === "article");
  if (!document) return null;
  const slug = slugOf(routePath);
  return {
    sourceUrl,
    routePath,
    slug,
    document,
    contentHash: sha256Json({ sourceUrl, routePath, slug, document }),
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++)
      output[index] = await fn(items[index]!);
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, items.length || 1)) },
      worker,
    ),
  );
  return output;
}

async function addCollectionReferencedProducts(params: {
  origin: string;
  families: DittoContentFamily[];
  shopifyStorefrontOrigin?: string;
  shopifyProductDocuments: Map<string, DittoContentDocument>;
  log?: (event: Record<string, unknown>) => void;
}): Promise<{
  discoveredCount: number;
  failures: DittoExtractionFailure[];
}> {
  const referencedHandles = [
    ...new Set(
      params.families
        .filter((family) => /\bcollections?\b/i.test(family.kind))
        .flatMap((family) =>
          family.entries.flatMap((entry) => {
            const value = entry.document.fields.custom?.productHandles;
            return Array.isArray(value)
              ? value.filter(
                  (handle): handle is string =>
                    typeof handle === "string" &&
                    SHOPIFY_PRODUCT_HANDLE.test(handle),
                )
              : [];
          }),
        ),
    ),
  ].sort();
  if (!referencedHandles.length) return { discoveredCount: 0, failures: [] };

  const productFamilies = params.families.filter((family) =>
    /\bproducts?\b/i.test(family.kind),
  );
  const canonicalFamily = productFamilies.find((family) =>
    matchesRoutePattern(family.routePattern, "/products/ditto-reference-probe"),
  );
  if (!canonicalFamily) {
    return {
      discoveredCount: 0,
      failures: [
        {
          sourceType: "product",
          reason:
            "collection entries reference Shopify products but the clone plan has no canonical product renderer",
        },
      ],
    };
  }

  const existingHandles = new Set(
    productFamilies.flatMap((family) =>
      family.entries.map((entry) => entry.slug),
    ),
  );
  const missingHandles = referencedHandles.filter(
    (handle) => !existingHandles.has(handle),
  );
  const existingEntryCount = params.families.reduce(
    (sum, family) => sum + family.entries.length,
    0,
  );
  const availableEntries = Math.max(
    0,
    MAX_CONTENT_ENTRIES - existingEntryCount,
  );
  const extractionHandles = missingHandles.slice(
    0,
    Math.min(availableEntries, MAX_COLLECTION_REFERENCED_PRODUCTS),
  );
  const failures: DittoExtractionFailure[] = [];
  if (extractionHandles.length < missingHandles.length) {
    failures.push({
      manifestKey: canonicalFamily.manifestKeys?.[0],
      familyKey: canonicalFamily.key,
      sourceType: "product",
      reason: `collection-referenced Shopify products exceeded the bounded expansion limit (${extractionHandles.length} of ${missingHandles.length})`,
    });
  }

  const extracted = await mapLimit(
    extractionHandles,
    FETCH_CONCURRENCY,
    async (handle) => {
      const routePath = `/products/${handle}`;
      try {
        return await extractEntry(
          params.origin,
          routePath,
          {
            key: canonicalFamily.key,
            label: canonicalFamily.label,
            kind: "product",
            fieldSchema: canonicalFamily.fieldSchema,
          },
          params.shopifyStorefrontOrigin,
          undefined,
          params.shopifyProductDocuments,
        );
      } catch (error) {
        params.log?.({
          event: "content_handoff_extract_failed",
          path: routePath,
          dependency: "collection-product",
          error: String(error).slice(0, 200),
        });
        return null;
      }
    },
  );
  for (let index = 0; index < extractionHandles.length; index += 1) {
    const entry = extracted[index];
    if (entry) {
      canonicalFamily.entries.push(entry);
      continue;
    }
    const handle = extractionHandles[index]!;
    failures.push({
      manifestKey: canonicalFamily.manifestKeys?.[0],
      familyKey: canonicalFamily.key,
      sourceType: "product",
      sourceUrl: `${params.origin}/products/${handle}`,
      routePath: `/products/${handle}`,
      reason:
        "structured content extraction failed for collection-referenced Shopify product",
    });
  }
  if (extracted.some(Boolean)) {
    params.log?.({
      event: "content_handoff_collection_products_expanded",
      referenced: referencedHandles.length,
      alreadyPresent: referencedHandles.length - missingHandles.length,
      extracted: extracted.filter(Boolean).length,
      failed: failures.length,
    });
  }
  return { discoveredCount: extractionHandles.length, failures };
}

function passthroughReason(routePath: string): string | null {
  const first = routePath.split("/").filter(Boolean)[0]?.toLowerCase();
  if (first === "account") return "authenticated account route";
  if (first === "cart" || first === "checkout")
    return "transactional commerce route";
  if (first === "search") return "source-backed search route";
  return null;
}

export async function buildContentHandoffBundle(params: {
  sourceUrl: string;
  crawl: CrawlResult;
  plan: RoutePlan;
  experimentalClonePlan?: IonClonePlanV1;
  shopifyStorefrontOrigins?: string[];
  capturedHtmlByPath?: Record<string, string>;
  log?: (event: Record<string, unknown>) => void;
}): Promise<DittoContentBundleV1> {
  const origin = params.crawl.origin;
  const shopifyProductDocuments = params.experimentalClonePlan
    ? new Map<string, DittoContentDocument>()
    : undefined;
  const discoveredPaths = new Set(params.crawl.paths);
  const eligibleList = params.crawl.paths
    .filter(
      (path) =>
        (params.crawl.depthByPath[path] ?? Number.POSITIVE_INFINITY) <= 1,
    )
    .sort();
  const eligiblePaths = new Set(eligibleList);
  const unresolved = new Map<string, string>();
  const extractablePaths = new Set(eligibleList.slice(0, MAX_ENTRY_LINKS));
  for (const path of eligibleList.slice(MAX_ENTRY_LINKS))
    unresolved.set(path, "entry-link extraction limit exceeded");
  eligiblePaths.add(params.crawl.entryPath);
  extractablePaths.add(params.crawl.entryPath);
  const wordpress = params.experimentalClonePlan
    ? await extractWordpressContent({
        sourceUrl: params.sourceUrl,
        plan: params.experimentalClonePlan,
      })
    : {
        detected: false,
        families: [] as DittoContentFamily[],
        discoveredCount: 0,
        extractedCount: 0,
        failures: [] as DittoExtractionFailure[],
      };
  const productPath = params.experimentalClonePlan?.dispositions.find(
    (item) => item.kind === "renderer" && item.path.startsWith("/products/"),
  )?.path;
  const collectionPath = params.experimentalClonePlan?.dispositions.find(
    (item) => item.kind === "renderer" && item.path.startsWith("/collections/"),
  )?.path;
  const shopifyStorefrontOrigin =
    params.experimentalClonePlan &&
    (productPath || collectionPath) &&
    params.shopifyStorefrontOrigins?.length
      ? await resolveShopifyStorefrontOrigin({
          sourceOrigin: origin,
          candidates: params.shopifyStorefrontOrigins,
          ...(productPath ? { productPath } : {}),
          ...(collectionPath ? { collectionPath } : {}),
        })
      : undefined;
  if (shopifyStorefrontOrigin) {
    params.log?.({
      event: "content_handoff_shopify_storefront_resolved",
      storefrontOrigin: shopifyStorefrontOrigin,
    });
  }
  const families: DittoContentFamily[] = [...wordpress.families];
  const extractionFailures: DittoExtractionFailure[] = [...wordpress.failures];
  let genericDiscovered = 0;

  for (const collection of params.experimentalClonePlan
    ? []
    : params.plan.collections) {
    const spec = familySpec(collection);
    const routePattern = nextPattern(collection.template);
    const scopedInstances = collection.instances
      .filter((path) => extractablePaths.has(path))
      .sort();
    if (
      !spec ||
      !routePattern ||
      scopedInstances.length === 0 ||
      families.some((family) => family.key === spec.key)
    )
      continue;
    genericDiscovered += scopedInstances.length;
    const extracted = await mapLimit(
      scopedInstances,
      FETCH_CONCURRENCY,
      async (routePath) => {
        try {
          return await extractEntry(
            origin,
            routePath,
            spec,
            shopifyStorefrontOrigin,
            params.capturedHtmlByPath?.[routePath],
            shopifyProductDocuments,
          );
        } catch (error) {
          params.log?.({
            event: "content_handoff_extract_failed",
            path: routePath,
            error: String(error).slice(0, 200),
          });
          return null;
        }
      },
    );
    const entries = extracted.filter(
      (entry): entry is DittoContentEntry => entry !== null,
    );
    for (let index = 0; index < scopedInstances.length; index += 1) {
      if (!extracted[index]) {
        const routePath = scopedInstances[index]!;
        unresolved.set(routePath, "structured content extraction failed");
        extractionFailures.push({
          reason: "structured content extraction failed",
          sourceType: spec.kind,
          sourceUrl: origin + routePath,
          routePath,
        });
      }
    }
    if (entries.length === 0) continue;
    const representativeDir = routeToSegment(collection.representative).dir;
    families.push({
      ...spec,
      description: `Imported from ${origin} for ${routePattern}`,
      origin: "import",
      routePattern,
      indexPath: collection.listing,
      representativeRoute: entries.some(
        (entry) => entry.routePath === collection.representative,
      )
        ? collection.representative
        : entries[0]!.routePath,
      template: {
        module: `src/app/${representativeDir ? `${representativeDir}/` : ""}page.tsx`,
        exportName: "default",
      },
      entries,
    });
  }

  // An Ion-authored plan may identify a valid CMS family from only one or two
  // routes, below Ditto's legacy URL-clustering threshold. Fill that gap without
  // replacing or changing any inferred legacy family.
  if (params.experimentalClonePlan) {
    const rendererByKey = new Map(
      params.experimentalClonePlan.renderers.map((renderer) => [
        renderer.key,
        renderer,
      ]),
    );
    for (const manifest of params.experimentalClonePlan.manifests) {
      const spec = plannedFamilySpec(manifest);
      const collectionKey = manifest.key.replace(/-/g, "_");
      if (families.some((family) => family.key === collectionKey)) continue;
      const renderers = params.experimentalClonePlan.renderers.filter(
        (renderer) => renderer.manifestKeys.includes(manifest.key),
      );
      const entryRenderers = entryRenderersForManifest(
        params.experimentalClonePlan,
        manifest.key,
        spec.kind,
      );
      const rendererKeys = new Set(
        entryRenderers.map((renderer) => renderer.key),
      );
      const routePattern = entryRenderers[0]?.pattern;
      const representativeRenderer =
        entryRenderers[0] ??
        renderers.find(
          (renderer) => renderer.captureUrl || renderer.reuseRendererKey,
        );
      if (!routePattern || !representativeRenderer) {
        extractionFailures.push({
          manifestKey: manifest.key,
          familyKey: collectionKey,
          sourceType: manifest.entityType,
          reason: `planned manifest ${manifest.key} has no unambiguous dynamic entry renderer`,
        });
        continue;
      }
      const representativeRoute = rootRenderer(
        representativeRenderer,
        rendererByKey,
      ).captureUrl;
      if (!representativeRoute) {
        extractionFailures.push({
          manifestKey: manifest.key,
          familyKey: collectionKey,
          sourceType: manifest.entityType,
          reason: `planned manifest ${manifest.key} has no reusable renderer capture`,
        });
        continue;
      }
      const plannedPaths = new Set(
        params.experimentalClonePlan.dispositions
          .filter(
            (item) =>
              item.kind === "renderer" &&
              item.rendererKey &&
              rendererKeys.has(item.rendererKey),
          )
          .map((item) => item.path),
      );
      for (const routePath of params.crawl.paths) {
        if (
          entryRenderers.some((renderer) =>
            matchesRoutePattern(renderer.pattern, routePath),
          )
        )
          plannedPaths.add(routePath);
      }
      const scopedInstances = [...plannedPaths]
        .filter((path) => discoveredPaths.has(path))
        .sort()
        .slice(0, MAX_CONTENT_ENTRIES);
      if (!scopedInstances.length) {
        extractionFailures.push({
          manifestKey: manifest.key,
          familyKey: collectionKey,
          sourceType: manifest.entityType,
          reason: `no discovered routes matched planned manifest ${manifest.key}`,
        });
        continue;
      }
      genericDiscovered += scopedInstances.length;
      const extracted = await mapLimit(
        scopedInstances,
        FETCH_CONCURRENCY,
        async (routePath) => {
          try {
            return await extractEntry(
              origin,
              routePath,
              spec,
              shopifyStorefrontOrigin,
              params.capturedHtmlByPath?.[routePath],
              shopifyProductDocuments,
            );
          } catch (error) {
            params.log?.({
              event: "content_handoff_extract_failed",
              path: routePath,
              error: String(error).slice(0, 200),
            });
            return null;
          }
        },
      );
      const entries = extracted.filter(
        (entry): entry is DittoContentEntry => entry !== null,
      );
      for (let index = 0; index < scopedInstances.length; index += 1) {
        if (!extracted[index]) {
          const routePath = scopedInstances[index]!;
          unresolved.set(routePath, "structured content extraction failed");
          extractionFailures.push({
            reason: "structured content extraction failed",
            manifestKey: manifest.key,
            familyKey: collectionKey,
            sourceType: manifest.entityType,
            sourceUrl: origin + routePath,
            routePath,
          });
        }
      }
      if (!entries.length) continue;
      const representativeDir = routeToSegment(representativeRoute).dir;
      const indexPath =
        renderers.find(
          (renderer) =>
            renderer.role === "index" && !renderer.pattern.includes("["),
        )?.pattern ?? null;
      families.push({
        key: collectionKey,
        label: manifest.key
          .split("-")
          .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
          .join(" "),
        kind: manifest.entityType,
        fieldSchema: spec.fieldSchema,
        manifestKeys: [manifest.key],
        description: `Imported from ${origin} for ${routePattern}`,
        origin: "import",
        routePattern,
        indexPath,
        representativeRoute: entries.some(
          (entry) => entry.routePath === representativeRoute,
        )
          ? representativeRoute
          : entries[0]!.routePath,
        template: {
          module: `src/app/${representativeDir ? `${representativeDir}/` : ""}page.tsx`,
          exportName: "default",
        },
        entries,
      });
    }

    const normalizedFamilies = partitionPlannedFamilies(
      families,
      params.experimentalClonePlan,
      origin,
    );
    families.splice(0, families.length, ...normalizedFamilies);
    const collectionProducts = await addCollectionReferencedProducts({
      origin,
      families,
      shopifyProductDocuments: shopifyProductDocuments!,
      ...(shopifyStorefrontOrigin ? { shopifyStorefrontOrigin } : {}),
      ...(params.log ? { log: params.log } : {}),
    });
    genericDiscovered += collectionProducts.discoveredCount;
    extractionFailures.push(...collectionProducts.failures);
    const mappedManifestKeys = new Set(
      families.flatMap((family) => family.manifestKeys ?? []),
    );
    const failedManifestKeys = new Set(
      extractionFailures
        .map((failure) => failure.manifestKey)
        .filter((key): key is string => Boolean(key)),
    );
    for (const manifest of params.experimentalClonePlan.manifests) {
      if (
        !mappedManifestKeys.has(manifest.key) &&
        !failedManifestKeys.has(manifest.key)
      ) {
        extractionFailures.push({
          manifestKey: manifest.key,
          sourceType: manifest.entityType,
          reason: `planned manifest ${manifest.key} had no entries matching an unambiguous entry renderer`,
        });
      }
    }
  }

  families.sort(
    (left, right) =>
      left.key.localeCompare(right.key) ||
      left.routePattern.localeCompare(right.routePattern),
  );
  let remainingEntries = MAX_CONTENT_ENTRIES;
  for (let index = 0; index < families.length; index += 1) {
    const family = families[index]!;
    if (remainingEntries <= 0) {
      families.splice(index);
      break;
    }
    if (family.entries.length > remainingEntries)
      family.entries = family.entries.slice(0, remainingEntries);
    if (
      !family.entries.some(
        (entry) => entry.routePath === family.representativeRoute,
      )
    ) {
      family.representativeRoute = family.entries[0]!.routePath;
    }
    remainingEntries -= family.entries.length;
  }
  const cmsByPath = new Map<string, DittoContentFamily["key"]>();
  for (const family of families)
    for (const entry of family.entries)
      cmsByPath.set(entry.routePath, family.key);
  const clonedPaths = new Set(params.plan.selected.map((route) => route.path));
  // Every imported CMS entry must have a route disposition, including deep
  // sitemap/REST-only records. Entry-link-scoped legacy dispositions remain
  // unchanged because cmsByPath is empty outside extracted families.
  const dispositionPaths = new Set([...eligiblePaths, ...cmsByPath.keys()]);
  const routes: DittoRouteDisposition[] = [...dispositionPaths]
    .sort()
    .map((routePath) => {
      const familyKey = cmsByPath.get(routePath);
      if (familyKey) return { routePath, disposition: "cms", familyKey };
      if (clonedPaths.has(routePath))
        return { routePath, disposition: "cloned" };
      const reason = passthroughReason(routePath);
      if (reason)
        return {
          routePath,
          disposition: "passthrough",
          targetUrl: origin + routePath,
          reason,
        };
      return {
        routePath,
        disposition: "unresolved",
        reason: unresolved.get(routePath) ?? "no safe cloned or CMS route",
      };
    });
  const count = (disposition: DittoRouteDisposition["disposition"]) =>
    routes.filter((route) => route.disposition === disposition).length;
  const familyKeys = new Set(families.map((family) => family.key));
  for (const failure of extractionFailures) {
    if (failure.familyKey && !familyKeys.has(failure.familyKey))
      delete failure.familyKey;
  }
  extractionFailures.sort(
    (left, right) =>
      (left.familyKey ?? "").localeCompare(right.familyKey ?? "") ||
      (left.manifestKey ?? "").localeCompare(right.manifestKey ?? "") ||
      (left.routePath ?? "").localeCompare(right.routePath ?? "") ||
      String(left.sourceId ?? "").localeCompare(String(right.sourceId ?? "")) ||
      left.reason.localeCompare(right.reason),
  );
  const extractedCount = families.reduce(
    (sum, family) => sum + family.entries.length,
    0,
  );
  const extraction: DittoExtractionMetadata = {
    adapter:
      wordpress.detected && genericDiscovered
        ? "composite"
        : wordpress.detected
          ? "wordpress-rest"
          : "generic-jsonld",
    adapterVersion: "1",
    extractedAt: deterministicExtractionDate(families),
    discoveredCount: Math.min(
      MAX_CONTENT_ENTRIES,
      Math.max(extractedCount, wordpress.discoveredCount + genericDiscovered),
    ),
    extractedCount,
    failures: extractionFailures,
  };
  const bundle: Omit<DittoContentBundleV1, "manifestHash"> = {
    schema: "ion-cms-v1",
    version: 1,
    source: {
      url: params.sourceUrl,
      origin,
      platform: wordpress.detected
        ? "wordpress"
        : families.some(
              (family) =>
                family.key === "products" || family.key === "collections",
            )
          ? "shopify"
          : "unknown",
      scope: params.experimentalClonePlan ? "cms-manifests" : "entry-links",
    },
    families,
    routes,
    coverage: {
      discovered: routes.length,
      cloned: count("cloned"),
      cms: count("cms"),
      passthrough: count("passthrough"),
      unresolved: count("unresolved"),
    },
    extraction,
  };
  return { ...bundle, manifestHash: sha256Json(bundle) };
}
