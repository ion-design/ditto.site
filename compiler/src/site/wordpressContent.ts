import type {
  DittoCmsFieldDefinition,
  DittoContentDocument,
  DittoContentEntry,
  DittoContentFamily,
} from "./contentHandoff.js";
import { sha256Json, type DittoExtractionFailure } from "./contentManifest.js";
import type { IonClonePlanV1, IonRendererPlan } from "./plannedClone.js";
import { routeToSegment } from "./generateSite.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const TYPE_CONCURRENCY = 4;

type Rendered = { rendered?: string };
type WordpressType = {
  slug?: string;
  rest_base?: string;
  viewable?: boolean;
  name?: string;
};
type WordpressTerm = { name?: string; taxonomy?: string };
type WordpressPost = {
  id?: number;
  type?: string;
  slug?: string;
  link?: string;
  date?: string;
  date_gmt?: string;
  title?: Rendered;
  content?: Rendered;
  excerpt?: Rendered;
  yoast_head_json?: {
    title?: string;
    description?: string;
    robots?: { index?: string };
    og_image?: Array<{ url?: string }>;
    author?: string;
  };
  _embedded?: {
    author?: Array<{ name?: string }>;
    "wp:featuredmedia"?: Array<{ source_url?: string }>;
    "wp:term"?: WordpressTerm[][];
  };
};

export type WordpressJsonResponse<T> = { data: T; headers: Headers; url: URL };
export type WordpressJsonFetcher = <T>(
  url: string,
  origin: string,
) => Promise<WordpressJsonResponse<T>>;

export type WordpressExtractionResult = {
  detected: boolean;
  families: DittoContentFamily[];
  discoveredCount: number;
  extractedCount: number;
  failures: DittoExtractionFailure[];
};

const WORDPRESS_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "wordpressId", label: "WordPress ID", type: "number" },
  { key: "wordpressType", label: "WordPress Type", type: "text" },
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

function sameOrigin(left: URL, right: URL): boolean {
  const host = (value: string) => value.toLowerCase().replace(/^www\./, "");
  return (
    left.protocol === right.protocol &&
    left.port === right.port &&
    host(left.hostname) === host(right.hostname)
  );
}

async function defaultFetchJson<T>(
  url: string,
  origin: string,
): Promise<WordpressJsonResponse<T>> {
  const target = new URL(url);
  const allowed = new URL(origin);
  if (!sameOrigin(target, allowed))
    throw new Error(
      `cross-origin WordPress request rejected: ${target.origin}`,
    );
  const response = await fetch(target, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ditto.site WordPress content handoff/1.0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !sameOrigin(new URL(response.url), allowed)) {
    throw new Error(`WordPress request failed with HTTP ${response.status}`);
  }
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_RESPONSE_BYTES)
    throw new Error(`WordPress response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new Error(`WordPress response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  return {
    data: JSON.parse(new TextDecoder().decode(bytes)) as T,
    headers: response.headers,
    url: new URL(response.url),
  };
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
    .replace(/&#(\d+);/g, (_, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(
      /&([a-z]+);/gi,
      (whole, name: string) => named[name.toLowerCase()] ?? whole,
    );
}

function textFromHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function fullBodyMarkdown(html: string, sourceUrl: string): string {
  const absolute = (value: string): string => {
    if (/^\s*(?:javascript|data|blob):/i.test(decodeEntities(value)))
      return "#";
    try {
      return new URL(decodeEntities(value), sourceUrl).toString();
    } catch {
      return value;
    }
  };
  return decodeEntities(html)
    .replace(
      /<(script|style|noscript|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_, level: string, body: string) =>
        `\n\n${"#".repeat(Number(level) + 1)} ${textFromHtml(body)}\n\n`,
    )
    .replace(
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, href: string, body: string) =>
        `[${textFromHtml(body)}](${absolute(href)})`,
    )
    .replace(
      /<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi,
      (tag: string, src: string) => {
        const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
        return `\n\n![${decodeEntities(alt)}](${absolute(src)})\n\n`;
      },
    )
    .replace(
      /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi,
      (_, body: string) => `\n- ${textFromHtml(body)}`,
    )
    .replace(/<(p|div|section|article|blockquote|pre)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|blockquote|pre)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(import|export)(?=\s)/gm, "\\$1")
    .replace(/[{}]/g, (character) => `\\${character}`)
    .trim();
}

function publishedAt(post: WordpressPost): string | undefined {
  const raw = post.date_gmt ?? post.date;
  if (!raw) return undefined;
  const parsed = new Date(/[z+-]\d*:?/i.test(raw.slice(10)) ? raw : `${raw}Z`);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function routeFor(post: WordpressPost, origin: string): string {
  if (post.link) {
    const url = new URL(post.link, origin);
    return url.pathname.replace(/\/+$/, "") || "/";
  }
  return `/${post.type ?? "post"}/${post.slug ?? post.id ?? "entry"}`;
}

function slugFor(post: WordpressPost, routePath: string): string {
  const candidate =
    post.slug ??
    routePath.split("/").filter(Boolean).at(-1) ??
    `entry-${post.id ?? 0}`;
  return (
    candidate
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || `entry-${post.id ?? 0}`
  );
}

function documentFor(
  post: WordpressPost,
  sourceUrl: string,
): DittoContentDocument {
  const routeUrl = new URL(routeFor(post, sourceUrl), sourceUrl).toString();
  const yoast = post.yoast_head_json;
  const description =
    yoast?.description ?? textFromHtml(post.excerpt?.rendered ?? "");
  const heroImageUrl =
    post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ??
    yoast?.og_image?.[0]?.url;
  const authorName = post._embedded?.author?.[0]?.name ?? yoast?.author;
  const tags = [
    ...new Set(
      (post._embedded?.["wp:term"] ?? [])
        .flat()
        .map((term) => term.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const body = fullBodyMarkdown(
    post.content?.rendered ?? post.excerpt?.rendered ?? description,
    routeUrl,
  );
  const published = publishedAt(post);
  return {
    title:
      textFromHtml(post.title?.rendered ?? "") ||
      `WordPress entry ${post.id ?? ""}`.trim(),
    ...(published ? { publishedAt: published } : {}),
    fields: {
      ...(description ? { description } : {}),
      ...(heroImageUrl
        ? { heroImageUrl: new URL(heroImageUrl, sourceUrl).toString() }
        : {}),
      ...(authorName ? { authorName } : {}),
      ...(tags.length ? { tags } : {}),
      seo: {
        ...(yoast?.title ? { metaTitle: textFromHtml(yoast.title) } : {}),
        ...(description ? { metaDescription: description } : {}),
        ...(heroImageUrl
          ? { ogImageUrl: new URL(heroImageUrl, sourceUrl).toString() }
          : {}),
        ...(yoast?.robots?.index
          ? { noIndex: yoast.robots.index === "noindex" }
          : {}),
      },
      custom: {
        wordpressId: post.id ?? 0,
        wordpressType: post.type ?? "post",
        sourceUrl: routeUrl,
      },
    },
    body,
  };
}

function matchesPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every(
      (segment, index) =>
        /^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment) ||
        segment === pathSegments[index],
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

function labelFor(key: string): string {
  return (
    key
      .split(/[_-]/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ") || key
  );
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

async function listType(
  origin: string,
  type: WordpressType,
  fetchJson: WordpressJsonFetcher,
): Promise<WordpressPost[]> {
  const records: WordpressPost[] = [];
  for (let page = 1; records.length < MAX_ENTRIES; page += 1) {
    const url = new URL(`/wp-json/wp/v2/${type.rest_base}`, origin);
    url.search = new URLSearchParams({
      per_page: "100",
      page: String(page),
      _embed: "1",
      context: "view",
    }).toString();
    const response = await fetchJson<WordpressPost[]>(url.toString(), origin);
    if (!Array.isArray(response.data))
      throw new Error(
        `WordPress type ${type.slug} returned a non-array payload`,
      );
    records.push(...response.data);
    const totalPages = Math.max(
      1,
      Number(response.headers.get("x-wp-totalpages") ?? 1) || 1,
    );
    if (page >= totalPages || response.data.length === 0) break;
  }
  return records.slice(0, MAX_ENTRIES);
}

export async function extractWordpressContent(params: {
  sourceUrl: string;
  plan: IonClonePlanV1;
  fetchJson?: WordpressJsonFetcher;
}): Promise<WordpressExtractionResult> {
  const origin = new URL(params.sourceUrl).origin;
  const fetchJson = params.fetchJson ?? defaultFetchJson;
  let types: Record<string, WordpressType>;
  try {
    const response = await fetchJson<Record<string, WordpressType>>(
      new URL("/wp-json/wp/v2/types", origin).toString(),
      origin,
    );
    if (
      !response.data ||
      typeof response.data !== "object" ||
      Array.isArray(response.data)
    ) {
      throw new Error("WordPress types endpoint returned an invalid payload");
    }
    types = response.data;
  } catch {
    return {
      detected: false,
      families: [],
      discoveredCount: 0,
      extractedCount: 0,
      failures: [],
    };
  }

  const failures: DittoExtractionFailure[] = [];
  const eligible = Object.values(types)
    .filter(
      (type) =>
        type.slug &&
        type.rest_base &&
        type.viewable !== false &&
        type.slug !== "attachment",
    )
    .sort((left, right) => {
      const priority = (type: WordpressType): number =>
        params.plan.manifests.some(
          (manifest) =>
            manifest.key === type.slug || manifest.entityType === type.slug,
        )
          ? 0
          : 1;
      return (
        priority(left) - priority(right) ||
        left.slug!.localeCompare(right.slug!)
      );
    });
  const listed = await mapLimit(eligible, TYPE_CONCURRENCY, async (type) => {
    try {
      return { type, posts: await listType(origin, type, fetchJson) };
    } catch (error) {
      const matchingManifests = params.plan.manifests.filter(
        (manifest) =>
          manifest.key === type.slug || manifest.entityType === type.slug,
      );
      const failure = {
        reason: String((error as Error).message ?? error).slice(0, 1000),
        sourceType: type.slug,
        sourceId: type.slug,
        sourceUrl: new URL(
          `/wp-json/wp/v2/${type.rest_base}`,
          origin,
        ).toString(),
      };
      if (matchingManifests.length) {
        for (const manifest of matchingManifests) {
          failures.push({
            ...failure,
            manifestKey: manifest.key,
            familyKey: manifest.key.replace(/-/g, "_"),
          });
        }
      } else {
        failures.push(failure);
      }
      return { type, posts: [] };
    }
  });
  const records = listed
    .flatMap(({ type, posts }) => posts.map((post) => ({ post, type })))
    .slice(0, MAX_ENTRIES);
  const rendererByKey = new Map(
    params.plan.renderers.map((renderer) => [renderer.key, renderer]),
  );
  const families: DittoContentFamily[] = [];
  let emittedEntries = 0;

  for (const manifest of params.plan.manifests) {
    const renderers = params.plan.renderers.filter((renderer) =>
      renderer.manifestKeys.includes(manifest.key),
    );
    const dynamicRenderers = renderers.filter((renderer) =>
      renderer.pattern.includes("["),
    );
    const detailRenderers = dynamicRenderers.filter(
      (renderer) => renderer.role === "detail",
    );
    const entryRenderers = detailRenderers.length
      ? detailRenderers
      : dynamicRenderers;
    const representative =
      entryRenderers[0] ??
      renderers.find(
        (renderer) => renderer.captureUrl || renderer.reuseRendererKey,
      );
    if (!representative) {
      failures.push({
        reason: `planned manifest ${manifest.key} has no renderer`,
        manifestKey: manifest.key,
        familyKey: manifest.key.replace(/-/g, "_"),
        sourceType: manifest.entityType,
      });
      continue;
    }
    const matched = records.filter(({ post }) => {
      const routePath = routeFor(post, origin);
      return entryRenderers.some((renderer) =>
        matchesPattern(renderer.pattern, routePath),
      );
    });
    const entries = matched
      .map(({ post }): DittoContentEntry => {
        const routePath = routeFor(post, origin);
        const sourceUrl = new URL(routePath, origin).toString();
        const slug = slugFor(post, routePath);
        const document = documentFor(post, origin);
        return {
          sourceUrl,
          routePath,
          slug,
          document,
          contentHash: sha256Json({ sourceUrl, routePath, slug, document }),
        };
      })
      .sort((left, right) => left.routePath.localeCompare(right.routePath))
      .slice(0, Math.max(0, MAX_ENTRIES - emittedEntries));
    if (!entries.length) {
      failures.push({
        reason: `WordPress returned no entries matching planned manifest ${manifest.key}`,
        manifestKey: manifest.key,
        familyKey: manifest.key.replace(/-/g, "_"),
        sourceType: manifest.entityType,
      });
      continue;
    }
    const root = rootRenderer(representative, rendererByKey);
    const representativeRoute = root.captureUrl!;
    const representativeDir = routeToSegment(representativeRoute).dir;
    families.push({
      key: manifest.key.replace(/-/g, "_"),
      label: labelFor(manifest.key),
      description: `Imported from WordPress for ${entryRenderers[0]?.pattern ?? representative.pattern}`,
      origin: "import",
      kind: manifest.entityType,
      manifestKeys: [manifest.key],
      routePattern: entryRenderers[0]?.pattern ?? representative.pattern,
      indexPath:
        renderers.find(
          (renderer) =>
            renderer.role === "index" && !renderer.pattern.includes("["),
        )?.pattern ?? null,
      representativeRoute: entries.some(
        (entry) => entry.routePath === representativeRoute,
      )
        ? representativeRoute
        : entries[0]!.routePath,
      template: {
        module: `src/app/${representativeDir ? `${representativeDir}/` : ""}page.tsx`,
        exportName: "default",
      },
      fieldSchema: WORDPRESS_FIELDS,
      entries,
    });
    emittedEntries += entries.length;
  }

  const extractedCount = families.reduce(
    (sum, family) => sum + family.entries.length,
    0,
  );
  return {
    detected: true,
    families,
    discoveredCount: records.length,
    extractedCount,
    failures,
  };
}
