import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { ensureDir, fileExists, writeText } from "../util/fsx.js";
import type { CaptureResult, SeoResource } from "../capture/capture.js";
import type { AssetEntry, AssetGraph } from "../infer/assets.js";
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";

export type SeoInventory = {
  sourceUrl: string;
  title: string;
  description: string;
  keywords: string;
  canonicalUrl: string;
  robots: string;
  referrer: string;
  themeColor: string;
  colorScheme: string;
  openGraph: Array<{ property: string; content: string }>;
  twitter: Array<{ name: string; content: string }>;
  icons: Array<{
    rel: string;
    href: string;
    localPath: string | null;
    type?: string;
    sizes?: string;
    media?: string;
    color?: string;
  }>;
  manifest: {
    href: string;
    localPath: string | null;
    assets: Array<{ sourceUrl: string; localPath: string | null; type: string }>;
  } | null;
  alternates: Array<{ hrefLang: string; href: string }>;
  jsonLd: Array<{ id?: string; text: string; types: string[] }>;
  resources: SeoResource[];
  metrics: {
    metaFields: number;
    openGraphTags: number;
    twitterTags: number;
    iconLinks: number;
    manifestAssets: number;
    alternates: number;
    jsonLdBlocks: number;
    llmsTxt: boolean;
    llmsFullTxt: boolean;
  };
};

export type SeoRouteSummary = {
  routePath: string;
  href: string;
  url: string;
  title: string;
  description: string;
  excerpt: string;
};

type HeadMeta = { name?: string; property?: string; httpEquiv?: string; content: string };

const clean = (value: string | undefined | null): string => (value ?? "").replace(/\s+/g, " ").trim();
const lower = (value: string | undefined): string => (value ?? "").toLowerCase();
const relTokens = (rel: string): Set<string> => new Set(rel.toLowerCase().split(/\s+/).filter(Boolean));

function metaContent(meta: HeadMeta[], key: string, kind: "name" | "property" | "httpEquiv" = "name"): string {
  const wanted = key.toLowerCase();
  for (const m of meta) {
    const actual = kind === "name" ? m.name : kind === "property" ? m.property : m.httpEquiv;
    if (actual && actual.toLowerCase() === wanted && m.content) return m.content.trim();
  }
  return "";
}

function metaPrefix(meta: HeadMeta[], prefix: string, kind: "name" | "property"): Array<{ key: string; content: string }> {
  const p = prefix.toLowerCase();
  const out: Array<{ key: string; content: string }> = [];
  for (const m of meta) {
    const key = kind === "name" ? m.name : m.property;
    const content = clean(m.content);
    if (key && key.toLowerCase().startsWith(p) && content) out.push({ key, content });
  }
  return out;
}

function assetFor(assetGraph: AssetGraph, url: string): AssetEntry | undefined {
  return assetGraph.byUrl.get(url);
}

function jsonLdTypes(text: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const types = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string" && t.trim()) types.add(t.trim());
    else if (Array.isArray(t)) for (const item of t) if (typeof item === "string" && item.trim()) types.add(item.trim());
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
  };
  visit(parsed);
  return [...types].sort();
}

function collectText(node: IRNode, out: string[]): void {
  for (const child of node.children) {
    if (isTextChild(child)) {
      const text = clean(child.text);
      if (text) out.push(text);
    } else {
      collectText(child, out);
    }
  }
}

export function routeSummaryFromIr(ir: IR, routePath: string, href: string, url: string): SeoRouteSummary {
  const parts: string[] = [];
  collectText(ir.root, parts);
  const excerpt = parts.join(" ").replace(/\s+/g, " ").slice(0, 700).trim();
  return {
    routePath,
    href,
    url,
    title: ir.doc.title || (routePath === "/" ? "Home" : routePath),
    description: ir.doc.head?.description || "",
    excerpt,
  };
}

export function buildSeoInventory(ir: IR, assetGraph: AssetGraph, capture?: CaptureResult): SeoInventory {
  const head = ir.doc.head ?? {};
  const meta = head.meta ?? [];
  const links = head.links ?? [];
  const title = ir.doc.title || "";
  const description = metaContent(meta, "description") || head.description || "";
  const keywords = metaContent(meta, "keywords") || head.keywords || "";
  const canonicalUrl = links.find((l) => relTokens(l.rel).has("canonical"))?.href || head.canonical || "";
  const robots = metaContent(meta, "robots") || head.robots || "";
  const referrer = metaContent(meta, "referrer") || head.referrer || "";
  const themeColor = metaContent(meta, "theme-color") || head.themeColor || "";
  const colorScheme = metaContent(meta, "color-scheme") || head.colorScheme || "";

  const openGraph = metaPrefix(meta, "og:", "property");
  if (!openGraph.length) {
    if (head.ogTitle) openGraph.push({ key: "og:title", content: head.ogTitle });
    if (head.ogDescription) openGraph.push({ key: "og:description", content: head.ogDescription });
    if (head.ogImage) openGraph.push({ key: "og:image", content: head.ogImage });
    if (head.ogType) openGraph.push({ key: "og:type", content: head.ogType });
    if (head.ogSiteName) openGraph.push({ key: "og:site_name", content: head.ogSiteName });
  }
  const twitter = metaPrefix(meta, "twitter:", "name");
  if (!twitter.length && head.twitterCard) twitter.push({ key: "twitter:card", content: head.twitterCard });

  const icons = links.filter((link) => {
    const rel = link.rel.toLowerCase();
    return /\b(?:icon|shortcut|apple-touch-icon|mask-icon)\b/.test(rel);
  }).map((link) => ({
    rel: link.rel,
    href: link.href,
    localPath: assetFor(assetGraph, link.href)?.localPath ?? null,
    ...(link.type ? { type: link.type } : {}),
    ...(link.sizes ? { sizes: link.sizes } : {}),
    ...(link.media ? { media: link.media } : {}),
    ...(link.color ? { color: link.color } : {}),
  }));

  const manifestLink = links.find((link) => relTokens(link.rel).has("manifest"));
  const manifestAssets = assetGraph.entries
    .filter((entry) => entry.via.some((via) => via.startsWith("manifest:")))
    .map((entry) => ({ sourceUrl: entry.sourceUrl, localPath: entry.localPath, type: entry.type }));
  const manifest = manifestLink ? {
    href: manifestLink.href,
    localPath: assetFor(assetGraph, manifestLink.href)?.localPath ?? null,
    assets: manifestAssets,
  } : null;

  const alternates = links.filter((link) => relTokens(link.rel).has("alternate") && link.hrefLang && link.href)
    .map((link) => ({ hrefLang: link.hrefLang!, href: link.href }));
  const jsonLd = (head.jsonLd ?? []).map((entry) => ({ ...entry, types: jsonLdTypes(entry.text) }));
  const resources = [...(capture?.seoResources ?? [])].sort((a, b) => a.url.localeCompare(b.url) || a.kind.localeCompare(b.kind));

  const metaFields = [title, description, keywords, canonicalUrl, robots, referrer, themeColor, colorScheme].filter(Boolean).length;
  return {
    sourceUrl: ir.doc.sourceUrl,
    title,
    description,
    keywords,
    canonicalUrl,
    robots,
    referrer,
    themeColor,
    colorScheme,
    openGraph: openGraph.map((m) => ({ property: m.key, content: m.content })),
    twitter: twitter.map((m) => ({ name: m.key, content: m.content })),
    icons,
    manifest,
    alternates,
    jsonLd,
    resources,
    metrics: {
      metaFields,
      openGraphTags: openGraph.length,
      twitterTags: twitter.length,
      iconLinks: icons.length,
      manifestAssets: manifestAssets.length,
      alternates: alternates.length,
      jsonLdBlocks: jsonLd.length,
      llmsTxt: resources.some((r) => r.kind === "llms" && r.status === 200 && !!r.text),
      llmsFullTxt: resources.some((r) => r.kind === "llms-full" && r.status === 200 && !!r.text),
    },
  };
}

export function seoInventoryToMarkdown(report: SeoInventory): string {
  const lines: string[] = [];
  lines.push("# SEO Inventory", "");
  lines.push(`- source: ${report.sourceUrl}`);
  lines.push(`- title: ${report.title || "(missing)"}`);
  lines.push(`- description: ${report.description || "(missing)"}`);
  lines.push(`- keywords: ${report.keywords || "(missing)"}`);
  lines.push(`- canonical: ${report.canonicalUrl || "(missing)"}`);
  lines.push(`- robots: ${report.robots || "(missing)"}`);
  lines.push(`- referrer: ${report.referrer || "(missing)"}`);
  lines.push(`- theme-color: ${report.themeColor || "(missing)"}`);
  lines.push(`- color-scheme: ${report.colorScheme || "(missing)"}`);
  lines.push("");
  lines.push("## Coverage", "");
  lines.push(`- Open Graph tags: ${report.metrics.openGraphTags}`);
  lines.push(`- Twitter card tags: ${report.metrics.twitterTags}`);
  lines.push(`- icon links: ${report.metrics.iconLinks}`);
  lines.push(`- manifest assets: ${report.metrics.manifestAssets}`);
  lines.push(`- alternates/hreflang: ${report.metrics.alternates}`);
  lines.push(`- JSON-LD blocks: ${report.metrics.jsonLdBlocks}`);
  lines.push(`- source llms.txt: ${report.metrics.llmsTxt ? "yes" : "no"}`);
  lines.push(`- source llms-full.txt: ${report.metrics.llmsFullTxt ? "yes" : "no"}`);
  if (report.icons.length) {
    lines.push("", "## Icons", "");
    for (const icon of report.icons) lines.push(`- ${icon.rel}: ${icon.localPath || icon.href}${icon.sizes ? ` (${icon.sizes})` : ""}`);
  }
  if (report.manifest) {
    lines.push("", "## Manifest", "");
    lines.push(`- link: ${report.manifest.localPath || report.manifest.href}`);
    for (const asset of report.manifest.assets) lines.push(`- asset: ${asset.localPath || asset.sourceUrl}`);
  }
  if (report.jsonLd.length) {
    lines.push("", "## Structured Data", "");
    for (const block of report.jsonLd) lines.push(`- ${block.types.length ? block.types.join(", ") : "JSON-LD"}${block.id ? ` (#${block.id})` : ""}`);
  }
  if (report.resources.length) {
    lines.push("", "## Discovered Files", "");
    for (const resource of report.resources) lines.push(`- ${resource.kind}: ${resource.status ?? "unreachable"} ${resource.url}`);
  }
  return lines.join("\n") + "\n";
}

function firstValue(entries: Array<{ property?: string; name?: string; content: string }>, key: string): string {
  const wanted = key.toLowerCase();
  const found = entries.find((entry) => (entry.property ?? entry.name ?? "").toLowerCase() === wanted);
  return found?.content ?? "";
}

function keywordList(keywords: string): string[] | undefined {
  const parts = keywords.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function iconUrl(icon: SeoInventory["icons"][number]): string {
  return icon.localPath || icon.href;
}

// Next validates metadata.openGraph.type against this fixed enum and THROWS at
// render on anything else (e.g. Shopify's `product.group`). Unsupported values
// are emitted via metadata.other instead so the tag survives without the crash.
const NEXT_OG_TYPES = new Set([
  "website", "article", "book", "profile",
  "music.song", "music.album", "music.playlist", "music.radio_station",
  "video.movie", "video.episode", "video.tv_show", "video.other",
]);

function metadataObject(report: SeoInventory): Record<string, unknown> {
  const metadata: Record<string, unknown> = { title: report.title || "Cloned Page" };
  if (report.description) metadata.description = report.description;
  const keywords = keywordList(report.keywords);
  if (keywords) metadata.keywords = keywords;
  if (report.robots) metadata.robots = report.robots;
  if (report.referrer) metadata.referrer = report.referrer;
  const sourceOrigin = originOf(report.sourceUrl);
  const alternates: Record<string, unknown> = {};
  // Canonical is relativized to the source origin path so metadataBase (the clone's own
  // origin) resolves it — never hard-coding the source domain. Off-origin canonicals are rare;
  // keep them verbatim.
  if (report.canonicalUrl) {
    const c = relativizeToSource(report.canonicalUrl, sourceOrigin);
    alternates.canonical = c.path;
  }
  if (report.alternates.length) {
    const languages: Record<string, string> = {};
    for (const alt of report.alternates) languages[alt.hrefLang] = alt.href;
    alternates.languages = languages;
  }
  if (Object.keys(alternates).length) metadata.alternates = alternates;

  const ogEntries = report.openGraph.map((entry) => ({ property: entry.property, content: entry.content }));
  const og: Record<string, unknown> = {};
  const ogTitle = firstValue(ogEntries, "og:title");
  const ogDescription = firstValue(ogEntries, "og:description");
  const ogType = firstValue(ogEntries, "og:type");
  const ogSiteName = firstValue(ogEntries, "og:site_name");
  const ogUrl = firstValue(ogEntries, "og:url");
  const ogImages = ogEntries.filter((entry) => entry.property?.toLowerCase() === "og:image").map((entry) => entry.content);
  const other: Record<string, string> = {};
  if (ogTitle) og.title = ogTitle;
  if (ogDescription) og.description = ogDescription;
  if (ogType) {
    if (NEXT_OG_TYPES.has(ogType)) og.type = ogType;
    else other["og:type"] = ogType;
  }
  if (ogSiteName) og.siteName = ogSiteName;
  if (ogUrl) og.url = relativizeToSource(ogUrl, sourceOrigin).path;
  if (ogImages.length) og.images = ogImages;
  if (Object.keys(og).length) metadata.openGraph = og;

  const twEntries = report.twitter.map((entry) => ({ name: entry.name, content: entry.content }));
  const twitter: Record<string, unknown> = {};
  const twCard = firstValue(twEntries, "twitter:card");
  const twTitle = firstValue(twEntries, "twitter:title");
  const twDescription = firstValue(twEntries, "twitter:description");
  const twSite = firstValue(twEntries, "twitter:site");
  const twCreator = firstValue(twEntries, "twitter:creator");
  const twImages = twEntries.filter((entry) => entry.name?.toLowerCase() === "twitter:image").map((entry) => entry.content);
  if (twCard) twitter.card = twCard;
  if (twTitle) twitter.title = twTitle;
  if (twDescription) twitter.description = twDescription;
  if (twSite) twitter.site = twSite;
  if (twCreator) twitter.creator = twCreator;
  if (twImages.length) twitter.images = twImages;
  if (Object.keys(twitter).length) metadata.twitter = twitter;

  const icons: Record<string, unknown[]> = {};
  for (const icon of report.icons) {
    const rel = icon.rel.toLowerCase();
    const item: Record<string, unknown> = { url: iconUrl(icon) };
    if (icon.type) item.type = icon.type;
    if (icon.sizes) item.sizes = icon.sizes;
    if (icon.media) item.media = icon.media;
    if (rel.includes("apple-touch-icon")) (icons.apple ??= []).push(item);
    else if (rel.includes("shortcut")) (icons.shortcut ??= []).push(item);
    else if (rel.includes("mask-icon")) (icons.other ??= []).push({ ...item, rel: "mask-icon", ...(icon.color ? { color: icon.color } : {}) });
    else (icons.icon ??= []).push(item);
  }
  if (Object.keys(icons).length) metadata.icons = icons;
  if (report.manifest) metadata.manifest = report.manifest.localPath || report.manifest.href;
  if (Object.keys(other).length) metadata.other = other;
  return metadata;
}

// A sentinel object value that metadataExport rewrites into the runtime `metadataBase`
// expression (JSON can't hold `new URL(...)`). Chosen so it never collides with real content.
const METADATA_BASE_SENTINEL = "__DITTO_METADATA_BASE__";

// The metadata/JSON-LD layout module references SITE_ORIGIN — callers must hoist this import.
export const SITE_ORIGIN_LAYOUT_IMPORT = siteOriginImportLine(1);

export function metadataExport(report: SeoInventory): string {
  const obj = metadataObject(report);
  // metadataBase lets Next resolve the (now relative) canonical/openGraph URLs against the
  // clone's OWN origin — SITE_ORIGIN when set, localhost in dev. Placed first for readability.
  const withBase = { metadataBase: METADATA_BASE_SENTINEL, ...obj };
  const body = JSON.stringify(withBase, null, 2).replace(
    JSON.stringify(METADATA_BASE_SENTINEL),
    `new URL(SITE_ORIGIN || "http://localhost:3000")`,
  );
  return `export const metadata = ${body};\n`;
}

export function viewportExport(report: SeoInventory): string {
  const viewport: Record<string, unknown> = { width: "device-width", initialScale: 1 };
  if (report.themeColor) viewport.themeColor = report.themeColor;
  if (report.colorScheme) viewport.colorScheme = report.colorScheme;
  return `export const viewport = ${JSON.stringify(viewport, null, 2)};\n`;
}

function safeJsonLd(text: string): string {
  return text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/** Rewrite a JSON-LD block's on-origin @id/url/contentUrl/target values off the SOURCE domain.
 *  The frozen JSON escapes slashes (`https:\/\/host\/…`), so we split on both the escaped and
 *  plain origin forms and rejoin with SITE_ORIGIN at RUNTIME — the source domain never appears
 *  in output, and setting NEXT_PUBLIC_SITE_ORIGIN re-hosts the ids under the clone's own origin.
 *  Returns a JS expression string. Off-origin links (genuinely external) are left untouched. */
function jsonLdHtmlExpr(text: string, sourceOrigin: string): string {
  const safe = safeJsonLd(text);
  if (!sourceOrigin) return JSON.stringify(safe);
  const escaped = sourceOrigin.replace(/\//g, "\\/");
  // Split on whichever origin form appears; only one form is present in a given block.
  const forms = safe.includes(escaped) ? escaped : (safe.includes(sourceOrigin) ? sourceOrigin : null);
  if (!forms) return JSON.stringify(safe);
  const segments = safe.split(forms);
  if (segments.length === 1) return JSON.stringify(safe);
  return `[${segments.map((s) => JSON.stringify(s)).join(", ")}].join(SITE_ORIGIN)`;
}

export function jsonLdHeadMarkup(report: SeoInventory, indent = 8): string {
  if (!report.jsonLd.length) return "";
  const pad = " ".repeat(indent);
  const sourceOrigin = originOf(report.sourceUrl);
  return report.jsonLd.map((entry, index) => `${pad}<script
${pad}  key="ditto-json-ld-${index}"
${pad}  type="application/ld+json"
${pad}  dangerouslySetInnerHTML={{ __html: ${jsonLdHtmlExpr(entry.text, sourceOrigin)} }}
${pad}/>`).join("\n");
}

function resourceText(report: SeoInventory, kind: SeoResource["kind"]): string | null {
  const resource = report.resources.find((r) => r.kind === kind && r.status === 200 && r.text);
  return resource?.text ?? null;
}

function plainTextRoute(text: string): string {
  return `export const dynamic = "force-static";

export function GET() {
  return new Response(${JSON.stringify(text)}, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
`;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return "https://example.com"; }
}

/** The single origin constant every generated SEO/metadata route resolves against. Empty by
 *  default so canonical/sitemap/JSON-LD URLs render RELATIVE to wherever the clone is served
 *  (never the source domain); set NEXT_PUBLIC_SITE_ORIGIN to make them absolute to the clone's
 *  own origin. Emitted once as src/lib/site.ts. */
export const SITE_ORIGIN_MODULE = `export const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "").replace(/\\/$/, "");\n`;

/** The `import { SITE_ORIGIN } from "…/lib/site"` line; `depth` mirrors cnImportLine. */
export function siteOriginImportLine(depth: number): string {
  return `import { SITE_ORIGIN } from "${"../".repeat(Math.max(1, depth))}lib/site";`;
}

/** Path portion of a URL that sits on the source origin (so it can be re-hosted under
 *  SITE_ORIGIN); returns the input unchanged for off-origin (genuinely external) URLs. */
function relativizeToSource(url: string, sourceOrigin: string): { onOrigin: boolean; path: string } {
  if (sourceOrigin && url.startsWith(sourceOrigin)) {
    const path = url.slice(sourceOrigin.length) || "/";
    return { onOrigin: true, path: path.startsWith("/") ? path : "/" + path };
  }
  return { onOrigin: false, path: url };
}

function generatedLlms(report: SeoInventory, routes: SeoRouteSummary[]): string {
  const title = report.title || routes[0]?.title || "Generated Clone";
  const lines: string[] = [`# ${title}`, ""];
  if (report.description) lines.push(report.description, "");
  lines.push("This is a generated ditto.site clone. It preserves captured page content, metadata, route structure, and static assets where available.", "");
  lines.push("## Routes", "");
  for (const route of routes) {
    const label = route.title || route.routePath || route.href;
    const desc = route.description ? ` - ${route.description}` : "";
    lines.push(`- [${label}](${route.url})${desc}`);
  }
  const contentRoutes = routes.filter((route) => route.excerpt);
  if (contentRoutes.length) {
    lines.push("", "## Captured Content", "");
    for (const route of contentRoutes.slice(0, 8)) {
      lines.push(`### ${route.title || route.routePath}`);
      lines.push(route.excerpt);
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function seoRouteFiles(report: SeoInventory, routes: SeoRouteSummary[]): Array<[string, string]> {
  const origin = originOf(report.sourceUrl);
  // robots.ts / sitemap.ts live at src/app → depth 1 below src.
  const siteImport = siteOriginImportLine(1);
  const robots = `import type { MetadataRoute } from "next";
${siteImport}

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: SITE_ORIGIN + "/sitemap.xml",
  };
}
`;
  const sitemapEntries = (routes.length ? routes : [{
    routePath: "/",
    href: "/",
    url: report.canonicalUrl || report.sourceUrl || origin + "/",
    title: report.title || "Home",
    description: report.description,
    excerpt: "",
  }]).map((route, index) => ({ path: relativizeToSource(route.url, origin).path, changeFrequency: "weekly", priority: index === 0 ? 1 : 0.7 }));
  // Emit `url: SITE_ORIGIN + "<path>"` so URLs resolve to the clone's own origin (relative by
  // default), never the source domain.
  const entryLines = sitemapEntries.map((e) =>
    `  {\n    url: SITE_ORIGIN + ${JSON.stringify(e.path)},\n    changeFrequency: ${JSON.stringify(e.changeFrequency)},\n    priority: ${e.priority},\n  }`
  ).join(",\n");
  const sitemap = `import type { MetadataRoute } from "next";
${siteImport}

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
${entryLines},
  ];
}
`;
  const sourceLlms = resourceText(report, "llms");
  const sourceLlmsFull = resourceText(report, "llms-full");
  const files: Array<[string, string]> = [
    ["robots.ts", robots],
    ["sitemap.ts", sitemap],
    [join("llms.txt", "route.ts"), plainTextRoute(sourceLlms ?? generatedLlms(report, routes))],
  ];
  if (sourceLlmsFull) files.push([join("llms-full.txt", "route.ts"), plainTextRoute(sourceLlmsFull)]);
  return files;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function seoStaticFiles(report: SeoInventory, routes: SeoRouteSummary[]): Array<[string, string]> {
  const origin = originOf(report.sourceUrl);
  // Static output (Vite) has no runtime env: emit the clone's own paths RELATIVE to the source
  // origin so the source domain is never baked in (the requirement's relative default).
  const robots = [
    "User-agent: *",
    "Allow: /",
    "Sitemap: /sitemap.xml",
    "",
  ].join("\n");
  const sitemapRoutes = routes.length ? routes : [{
    routePath: "/",
    href: "/",
    url: report.canonicalUrl || report.sourceUrl || origin + "/",
    title: report.title || "Home",
    description: report.description,
    excerpt: "",
  }];
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapRoutes.map((route, index) => [
      "  <url>",
      `    <loc>${xmlEscape(relativizeToSource(route.url, origin).path)}</loc>`,
      "    <changefreq>weekly</changefreq>",
      `    <priority>${index === 0 ? "1.0" : "0.7"}</priority>`,
      "  </url>",
    ].join("\n")),
    "</urlset>",
    "",
  ].join("\n");
  const sourceLlms = resourceText(report, "llms");
  const sourceLlmsFull = resourceText(report, "llms-full");
  const files: Array<[string, string]> = [
    ["robots.txt", robots],
    ["sitemap.xml", sitemap],
    ["llms.txt", sourceLlms ?? generatedLlms(report, routes)],
  ];
  if (sourceLlmsFull) files.push(["llms-full.txt", sourceLlmsFull]);
  return files;
}

function storedAssetPath(sourceDir: string, entry: AssetEntry): string | null {
  if (!entry.storedFile) return null;
  const store = join(sourceDir, "assets-store", entry.storedFile);
  if (fileExists(store)) return store;
  const css = join(sourceDir, "capture", "css", entry.storedFile);
  return fileExists(css) ? css : null;
}

function extFor(entry: AssetEntry, href: string): string {
  const fromStored = entry.storedFile ? extname(entry.storedFile).toLowerCase() : "";
  if (fromStored) return fromStored;
  try { return extname(new URL(href).pathname).toLowerCase(); } catch { return extname(href).toLowerCase(); }
}

function copyIcon(appDir: string, sourceDir: string, entry: AssetEntry | undefined, href: string, destName: string): boolean {
  if (!entry) return false;
  const src = storedAssetPath(sourceDir, entry);
  if (!src) return false;
  const dest = join(appDir, "src", "app", destName);
  ensureDir(join(dest, ".."));
  copyFileSync(src, dest);
  return true;
}

export function emitSeoAssetFiles(appDir: string, sourceDir: string, assetGraph: AssetGraph, report: SeoInventory): void {
  const appRoot = join(appDir, "src", "app");
  if (fileExists(appRoot)) {
    for (const name of readdirSync(appRoot)) {
      if (/^(?:favicon\.ico|icon\d*\.(?:ico|jpg|jpeg|png|svg)|apple-icon\d*\.(?:jpg|jpeg|png))$/.test(name)) {
        rmSync(join(appRoot, name), { force: true });
      }
    }
  }
  const firstIcon = report.icons.find((icon) => /\bicon\b/i.test(icon.rel) && !/apple-touch-icon|mask-icon/i.test(icon.rel));
  const firstIco = report.icons.find((icon) => /\.ico(?:$|[?#])/i.test(icon.href) || lower(icon.type).includes("icon"));
  if (firstIco) copyIcon(appDir, sourceDir, assetFor(assetGraph, firstIco.href), firstIco.href, "favicon.ico");
  if (firstIcon) {
    const entry = assetFor(assetGraph, firstIcon.href);
    const ext = entry ? extFor(entry, firstIcon.href) : "";
    if (/^\.(?:ico|jpg|jpeg|png|svg)$/.test(ext)) copyIcon(appDir, sourceDir, entry, firstIcon.href, `icon${ext}`);
  }
  const apple = report.icons.find((icon) => /apple-touch-icon/i.test(icon.rel));
  if (apple) {
    const entry = assetFor(assetGraph, apple.href);
    const ext = entry ? extFor(entry, apple.href) : "";
    if (/^\.(?:jpg|jpeg|png)$/.test(ext)) copyIcon(appDir, sourceDir, entry, apple.href, `apple-icon${ext}`);
  }
}

export function emitSeoRoutes(appDir: string, report: SeoInventory, routes: SeoRouteSummary[]): void {
  rmSync(join(appDir, "src", "app", "llms-full.txt"), { recursive: true, force: true });
  for (const [rel, body] of seoRouteFiles(report, routes)) writeText(join(appDir, "src", "app", rel), body);
}
