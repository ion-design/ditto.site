import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureResult } from "../src/capture/capture.js";
import type { AssetGraph } from "../src/infer/assets.js";
import type { IR } from "../src/normalize/ir.js";
import {
  buildSeoInventory,
  emitSeoAssetFiles,
  emitSeoRoutes,
  jsonLdHeadMarkup,
  metadataExport,
  routeSummaryFromIr,
  seoRouteFiles,
} from "../src/generate/seo.js";
import { agentsMd, architectureMd } from "../src/generate/docs.js";
import { NEXT_CONFIG } from "../src/generate/app.js";

function fixtureIr(): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/seo",
      title: "SEO Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: [375, 768, 1280, 1920],
      sampleViewports: [375, 768, 1280, 1920],
      canonicalViewport: 1280,
      perViewport: {
        1280: { scrollHeight: 800, scrollWidth: 1280, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" },
      },
      nodeCount: 2,
      keyframes: [],
      head: {
        description: "Source description",
        canonical: "https://example.test/seo",
        themeColor: "#123456",
        colorScheme: "light dark",
        meta: [
          { name: "description", content: "Source description" },
          { name: "keywords", content: "clone, seo" },
          { name: "robots", content: "index,follow" },
          { name: "referrer", content: "strict-origin" },
          { name: "theme-color", content: "#123456" },
          { name: "color-scheme", content: "light dark" },
          { property: "og:title", content: "OG Title" },
          { property: "og:description", content: "OG Description" },
          { property: "og:image", content: "https://example.test/og.png" },
          { name: "twitter:card", content: "summary_large_image" },
          { name: "twitter:title", content: "Twitter Title" },
        ],
        links: [
          { rel: "canonical", href: "https://example.test/seo" },
          { rel: "icon", href: "https://example.test/icon.png", type: "image/png", sizes: "32x32" },
          { rel: "shortcut icon", href: "https://example.test/favicon.ico" },
          { rel: "apple-touch-icon", href: "https://example.test/apple.png", sizes: "180x180" },
          { rel: "mask-icon", href: "https://example.test/mask.svg", color: "#123456" },
          { rel: "manifest", href: "https://example.test/site.webmanifest" },
          { rel: "alternate", hrefLang: "es", href: "https://example.test/es/seo" },
        ],
        jsonLd: [{ id: "schema", text: '{"@context":"https://schema.org","@type":"WebSite","name":"SEO Fixture"}' }],
      },
    },
    root: {
      id: "n0",
      tag: "body",
      attrs: {},
      visibleByVp: { 1280: true },
      bboxByVp: { 1280: { x: 0, y: 0, width: 1280, height: 800 } },
      computedByVp: { 1280: {} },
      children: [
        { id: "n1", tag: "main", attrs: {}, visibleByVp: { 1280: true }, bboxByVp: { 1280: { x: 0, y: 0, width: 1280, height: 800 } }, computedByVp: { 1280: {} }, children: [{ text: "Useful page text for llms generation." }] },
      ],
    },
  };
}

function fixtureAssets(): AssetGraph {
  const entries = [
    ["https://example.test/icon.png", "image", "/assets/cloned/images/icon.png", "icon.png", ["head link"]],
    ["https://example.test/favicon.ico", "image", "/assets/cloned/images/favicon.ico", "favicon.ico", ["head link"]],
    ["https://example.test/apple.png", "image", "/assets/cloned/images/apple.png", "apple.png", ["head link"]],
    ["https://example.test/site.webmanifest", "manifest", "/assets/cloned/manifest/site.webmanifest", "site.webmanifest", ["head link"]],
    ["https://example.test/manifest-icon.png", "image", "/assets/cloned/images/manifest-icon.png", "manifest-icon.png", ["manifest:icons"]],
  ].map(([sourceUrl, type, localPath, storedFile, via]) => ({
    sourceUrl: sourceUrl as string,
    type: type as string,
    classification: "downloaded" as const,
    localPath: localPath as string,
    storedFile: storedFile as string,
    bytes: 10,
    reason: null,
    impact: null,
    via: via as string[],
  }));
  return { entries, byUrl: new Map(entries.map((entry) => [entry.sourceUrl, entry])) };
}

function fixtureCapture(): CaptureResult {
  return {
    sourceUrl: "https://example.test/seo",
    capturedAt: "2026-01-01T00:00:00.000Z",
    viewports: [375, 768, 1280, 1920],
    perViewport: [],
    assets: [],
    fontFaces: [],
    cssTexts: [],
    seoResources: [
      { kind: "llms", url: "https://example.test/llms.txt", status: 200, contentType: "text/plain", text: "# Source LLMS\n" },
      { kind: "llms-full", url: "https://example.test/llms-full.txt", status: 200, contentType: "text/plain", text: "# Source LLMS Full\n" },
      { kind: "sitemap", url: "https://example.test/sitemap.xml", status: 200, contentType: "application/xml" },
    ],
  };
}

describe("SEO inventory and emission", () => {
  it("captures rich SEO inventory and emits metadata, JSON-LD, llms, icons, and docs", () => {
    const ir = fixtureIr();
    const assets = fixtureAssets();
    const report = buildSeoInventory(ir, assets, fixtureCapture());
    assert.equal(report.metrics.iconLinks, 4);
    assert.equal(report.metrics.openGraphTags, 3);
    assert.equal(report.metrics.twitterTags, 2);
    assert.equal(report.metrics.jsonLdBlocks, 1);
    assert.equal(report.metrics.llmsTxt, true);
    assert.equal(report.metrics.llmsFullTxt, true);
    assert.equal(report.manifest?.localPath, "/assets/cloned/manifest/site.webmanifest");
    assert.equal(report.manifest?.assets.length, 1);
    assert.ok(metadataExport(report).includes("summary_large_image"));
    assert.ok(jsonLdHeadMarkup(report).includes("application/ld+json"));

    const files = seoRouteFiles(report, [routeSummaryFromIr(ir, "/", "/", ir.doc.sourceUrl)]);
    assert.ok(files.find(([path]) => path === join("llms.txt", "route.ts"))?.[1].includes("Source LLMS"));
    assert.ok(files.find(([path]) => path === join("llms-full.txt", "route.ts"))?.[1].includes("Source LLMS Full"));

    const temp = mkdtempSync(join(tmpdir(), "seo-emission-"));
    try {
      const sourceDir = join(temp, "source");
      const appDir = join(temp, "app");
      mkdirSync(join(sourceDir, "assets-store"), { recursive: true });
      for (const name of ["icon.png", "favicon.ico", "apple.png", "site.webmanifest", "manifest-icon.png"]) {
        writeFileSync(join(sourceDir, "assets-store", name), "asset");
      }
      emitSeoRoutes(appDir, report, [routeSummaryFromIr(ir, "/", "/", ir.doc.sourceUrl)]);
      emitSeoAssetFiles(appDir, sourceDir, assets, report);
      assert.ok(existsSync(join(appDir, "src", "app", "favicon.ico")));
      assert.ok(existsSync(join(appDir, "src", "app", "icon.png")));
      assert.ok(existsSync(join(appDir, "src", "app", "apple-icon.png")));
      assert.ok(existsSync(join(appDir, "src", "app", "llms.txt", "route.ts")));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }

    const docsInput = {
      sourceUrl: ir.doc.sourceUrl,
      routes: [routeSummaryFromIr(ir, "/", "/", ir.doc.sourceUrl)],
      styling: "tailwind" as const,
      framework: "next" as const,
      multiRoute: false,
      components: true,
      sectionCount: 1,
      componentCount: 2,
      svgCount: 1,
      hasContentModule: true,
      runtimeUtilities: ["DittoWire"],
    };
    assert.ok(agentsMd(docsInput).includes("src/app/ditto"));
    assert.ok(architectureMd(docsInput).includes("data-ditto-id"));
  });

  it("passes a Next-supported og:type through to openGraph", () => {
    const ir = fixtureIr();
    ir.doc.head!.meta!.push({ property: "og:type", content: "article" });
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const metadata = metadataExport(report);
    assert.ok(metadata.includes('"type": "article"'));
    assert.ok(!metadata.includes('"og:type"'));
  });

  it("routes an unsupported og:type into metadata.other (Next throws on unknown enum values)", () => {
    const ir = fixtureIr();
    ir.doc.head!.meta!.push({ property: "og:type", content: "product.group" });
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const metadata = metadataExport(report);
    assert.ok(metadata.includes('"og:type": "product.group"'));
    assert.ok(!metadata.includes('"type": "product.group"'));
  });
});

describe("generated Next config", () => {
  it("disables the dev-tools badge so it cannot leak into screenshots", () => {
    assert.ok(NEXT_CONFIG.includes("devIndicators: false"));
  });
});

describe("SEO origin references the clone, not the source domain (fix 6)", () => {
  it("sitemap.ts / robots.ts resolve against SITE_ORIGIN, not the source origin", () => {
    const ir = fixtureIr();
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const files = seoRouteFiles(report, [routeSummaryFromIr(ir, "/", "/", ir.doc.sourceUrl)]);
    const robots = files.find(([p]) => p === "robots.ts")![1];
    const sitemap = files.find(([p]) => p === "sitemap.ts")![1];
    for (const body of [robots, sitemap]) {
      assert.ok(body.includes('import { SITE_ORIGIN } from "../lib/site";'), "imports SITE_ORIGIN");
      assert.ok(body.includes("SITE_ORIGIN +"), "builds URLs from SITE_ORIGIN");
      assert.ok(!body.includes("example.test"), "never bakes the source domain");
    }
    // sitemap path is relativized off the source origin.
    assert.ok(sitemap.includes('SITE_ORIGIN + "/seo"') || sitemap.includes('SITE_ORIGIN + "/"'));
  });

  it("metadata sets metadataBase from SITE_ORIGIN and relativizes the canonical", () => {
    const ir = fixtureIr();
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const metadata = metadataExport(report);
    assert.ok(metadata.includes('new URL(SITE_ORIGIN || "http://localhost:3000")'), "metadataBase from SITE_ORIGIN");
    assert.ok(metadata.includes('"canonical": "/seo"'), "canonical relativized to a path");
    // The source domain must not survive in canonical (og:image assets are localized elsewhere).
    assert.ok(!metadata.includes('"canonical": "https://example.test'), "canonical is not absolute to source");
  });

  it("relativizes og:url off the source origin", () => {
    const ir = fixtureIr();
    ir.doc.head!.meta!.push({ property: "og:url", content: "https://example.test/seo" });
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const metadata = metadataExport(report);
    assert.ok(metadata.includes('"url": "/seo"'), "og:url relativized to a path");
    assert.ok(!metadata.includes('"url": "https://example.test/seo"'), "og:url not absolute to source");
  });

  it("rewrites on-origin JSON-LD @id/url off the source domain via SITE_ORIGIN", () => {
    const ir = fixtureIr();
    // JSON-LD carrying the source origin in @id/url (escaped-slash form, like WordPress emits).
    ir.doc.head!.jsonLd = [{
      id: "graph",
      text: '{"@context":"https:\\/\\/schema.org","@id":"https:\\/\\/example.test\\/#website","url":"https:\\/\\/example.test\\/"}',
    }];
    const report = buildSeoInventory(ir, fixtureAssets(), fixtureCapture());
    const markup = jsonLdHeadMarkup(report);
    assert.ok(markup.includes(".join(SITE_ORIGIN)"), "rejoins segments with SITE_ORIGIN at runtime");
    // The source origin must not survive as a literal (schema.org context is off-origin, kept).
    assert.ok(!markup.includes("example.test"), "source origin removed from JSON-LD");
    assert.ok(markup.includes("schema.org"), "off-origin @context left untouched");
  });
});
