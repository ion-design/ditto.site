import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlResult } from "../src/crawl/crawl.js";
import type { RoutePlan } from "../src/crawl/routeTemplates.js";
import { buildContentHandoffBundle } from "../src/site/contentHandoff.js";
import {
  buildSiteLinkTargets,
  plannedCloneFailedRoutes,
} from "../src/site/cloneSite.js";
import type { IonClonePlanV1 } from "../src/site/plannedClone.js";
import {
  capturedStructuredHtmlFromSourceDir,
  shopifyStorefrontOriginsFromCapture,
} from "../src/site/shopifyContent.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function productHtml(handle: string): string {
  return `<!doctype html><html><head>
    <title>${handle} – Example Shop</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ProductGroup",
      name: `Product ${handle}`,
      description: `Description for ${handle}`,
      image: [`https://cdn.test/${handle}.jpg`],
      brand: { "@type": "Brand", name: "Example" },
      hasVariant: [
        {
          "@type": "Product",
          name: `${handle} XS`,
          sku: `${handle}-xs`,
          size: "XS",
          offers: {
            "@type": "Offer",
            price: "64.00",
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
          },
        },
      ],
    })}</script>
  </head><body></body></html>`;
}

function collectionHtml(handle: string): string {
  return `<!doctype html><html><head>
    <title>${handle} – Example Shop</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Collection ${handle}`,
      description: `Description for ${handle}`,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "ListItem",
            item: {
              "@type": "Product",
              name: "Product alpha",
              url: "https://shop.test/products/alpha",
              image: "https://cdn.test/alpha.jpg",
            },
          },
        ],
      },
    })}</script>
  </head><body></body></html>`;
}

function fixture(): { crawl: CrawlResult; plan: RoutePlan } {
  const paths = [
    "/",
    "/account",
    "/collections/new",
    "/collections/sale",
    "/collections/underwear",
    "/products/alpha",
    "/products/beta",
    "/products/gamma",
  ];
  return {
    crawl: {
      entryUrl: "https://shop.test/",
      entryPath: "/",
      origin: "https://shop.test",
      paths,
      depthByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? 0 : 1]),
      ),
      sourcesByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? ["entry"] : ["link"]]),
      ),
      robotsDisallow: [],
    },
    plan: {
      entry: "/",
      maxRoutes: 12,
      selected: [
        { path: "/", role: "entry", template: "/", depth: 0 },
        {
          path: "/collections/new",
          role: "representative",
          template: "/collections/:id",
          depth: 2,
        },
        {
          path: "/products/alpha",
          role: "representative",
          template: "/products/:id",
          depth: 2,
        },
      ],
      collections: [
        {
          template: "/collections/:id",
          listing: null,
          representative: "/collections/new",
          siblingProbe: "/collections/sale",
          instanceCount: 3,
          instances: [
            "/collections/new",
            "/collections/sale",
            "/collections/underwear",
          ],
          confirmed: true,
        },
        {
          template: "/products/:id",
          listing: null,
          representative: "/products/alpha",
          siblingProbe: "/products/beta",
          instanceCount: 3,
          instances: ["/products/alpha", "/products/beta", "/products/gamma"],
          confirmed: true,
        },
      ],
      templates: [],
      skipped: [],
    },
  };
}

describe("experimental Ion CMS content handoff", () => {
  it("emits deterministic product and collection groups for entry-page links", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const handle = path.split("/").filter(Boolean).at(-1)!;
      const html = path.startsWith("/products/")
        ? productHtml(handle)
        : collectionHtml(handle);
      return {
        ok: true,
        url,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      } as Response;
    }) as typeof fetch;

    const input = fixture();
    const first = await buildContentHandoffBundle({
      sourceUrl: "https://shop.test/",
      ...input,
    });
    const second = await buildContentHandoffBundle({
      sourceUrl: "https://shop.test/",
      ...input,
    });

    assert.deepEqual(first, second, "the handoff contains no time/randomness");
    assert.equal(first.schema, "ion-cms-v1");
    assert.equal(first.version, 1);
    assert.match(first.manifestHash!, /^[a-f0-9]{64}$/);
    assert.equal(first.extraction?.adapter, "generic-jsonld");
    assert.equal(first.extraction?.extractedCount, 6);
    assert.equal(first.source.platform, "shopify");
    assert.deepEqual(
      first.families.map((family) => family.key),
      ["collections", "products"],
    );
    assert.equal(first.coverage.cms, 6);
    assert.equal(first.coverage.passthrough, 1);
    assert.equal(first.coverage.unresolved, 0);

    const products = first.families.find(
      (family) => family.key === "products",
    )!;
    assert.equal(products.label, "Products");
    assert.equal(products.origin, "import");
    assert.equal(products.routePattern, "/products/[slug]");
    assert.equal(products.entries.length, 3);
    assert.equal(products.entries[1]!.routePath, "/products/beta");
    assert.equal(products.entries[1]!.document.fields.custom?.price, 64);
    assert.deepEqual(products.entries[1]!.document.fields.custom?.sizes, [
      "XS",
    ]);
    assert.match(products.entries[1]!.contentHash, /^[a-f0-9]{64}$/);

    const collections = first.families.find(
      (family) => family.key === "collections",
    )!;
    assert.deepEqual(
      collections.entries[0]!.document.fields.custom?.productHandles,
      ["alpha"],
    );
    assert.equal(
      first.routes.find((route) => route.routePath === "/account")?.disposition,
      "passthrough",
    );
    assert.equal(JSON.stringify(first).includes("capturedAt"), false);
  });

  it("does not expand collection dependencies for an unplanned handoff", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const handle = path.split("/").filter(Boolean).at(-1)!;
      const html = path.startsWith("/products/")
        ? productHtml(handle)
        : collectionHtml(handle).replace(
            /https:\/\/shop\.test\/products\/alpha/g,
            "https://shop.test/products/collection-only",
          );
      return {
        ok: true,
        url,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      } as Response;
    }) as typeof fetch;

    const bundle = await buildContentHandoffBundle({
      sourceUrl: "https://shop.test/",
      ...fixture(),
    });
    const products = bundle.families.find(
      (family) => family.key === "products",
    )!;
    assert.equal(products.entries.length, 3);
    assert.equal(
      products.entries.some((entry) => entry.slug === "collection-only"),
      false,
    );
  });

  it("fails closed when extraction cannot produce a content record", async () => {
    globalThis.fetch = (async (input) =>
      ({
        ok: true,
        url: String(input),
        headers: new Headers(),
        arrayBuffer: async () =>
          new TextEncoder().encode("<html><body>No metadata</body></html>")
            .buffer,
      }) as Response) as typeof fetch;

    const bundle = await buildContentHandoffBundle({
      sourceUrl: "https://shop.test/",
      ...fixture(),
    });
    assert.equal(bundle.families.length, 0);
    assert.equal(bundle.coverage.cms, 0);
    assert.equal(bundle.coverage.unresolved, 4);
    assert.equal(
      bundle.coverage.cloned,
      3,
      "captured representatives remain safe static routes",
    );
  });

  it("maps a planned nested blog renderer into the existing article family", async () => {
    globalThis.fetch = (async (input) =>
      ({
        ok: true,
        url: String(input),
        headers: new Headers(),
        arrayBuffer: async () =>
          new TextEncoder().encode(
            `<html><head><title>Planned article</title><meta name="description" content="Article description"></head><body><article><p>Body</p></article></body></html>`,
          ).buffer,
      }) as Response) as typeof fetch;
    const paths = ["/", "/a/blog", "/a/blog/first", "/a/blog/second"];
    const crawl: CrawlResult = {
      entryUrl: "https://shop.test/",
      entryPath: "/",
      origin: "https://shop.test",
      paths,
      depthByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? 0 : 1]),
      ),
      sourcesByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? ["entry"] : ["link"]]),
      ),
      robotsDisallow: [],
    };
    const routePlan: RoutePlan = {
      entry: "/",
      maxRoutes: 3,
      selected: [
        { path: "/", role: "entry", template: "/", depth: 0 },
        { path: "/a/blog", role: "listing", template: "/a/blog", depth: 2 },
        {
          path: "/a/blog/first",
          role: "representative",
          template: "/a/blog/[slug]",
          depth: 3,
        },
      ],
      collections: [],
      templates: [],
      skipped: [],
    };
    const experimentalClonePlan: IonClonePlanV1 = {
      version: "ion-clone-plan-v1",
      entryRoute: "/",
      staticRoutes: [],
      manifests: [{ key: "articles", entityType: "article" }],
      renderers: [
        {
          key: "blog-index",
          role: "index",
          pattern: "/a/blog",
          captureUrl: "/a/blog",
          manifestKeys: ["articles"],
        },
        {
          key: "blog-listing-alias",
          role: "listing",
          pattern: "/a/[section]",
          reuseRendererKey: "blog-index",
          manifestKeys: ["articles"],
        },
        {
          key: "article-detail",
          role: "detail",
          pattern: "/a/blog/[slug]",
          captureUrl: "/a/blog/first",
          manifestKeys: ["articles"],
        },
      ],
      dispositions: [
        { path: "/a/blog", kind: "renderer", rendererKey: "blog-index" },
        {
          path: "/a/blog/first",
          kind: "renderer",
          rendererKey: "article-detail",
        },
        {
          path: "/a/blog/second",
          kind: "renderer",
          rendererKey: "article-detail",
        },
      ],
    };
    const bundle = await buildContentHandoffBundle({
      sourceUrl: crawl.entryUrl,
      crawl,
      plan: routePlan,
      experimentalClonePlan,
    });
    assert.equal(bundle.families.length, 1);
    assert.equal(bundle.source.scope, "cms-manifests");
    assert.equal(bundle.families[0]?.key, "articles");
    assert.deepEqual(bundle.families[0]?.manifestKeys, ["articles"]);
    assert.equal(bundle.families[0]?.routePattern, "/a/blog/[slug]");
    assert.equal(bundle.families[0]?.indexPath, "/a/blog");
    assert.deepEqual(
      bundle.families[0]?.entries.map((entry) => entry.routePath),
      ["/a/blog/first", "/a/blog/second"],
    );
  });

  it("disambiguates nested blog containers and articles that share renderer dependencies", async () => {
    const plan = {
      version: "ion-clone-plan-v1" as const,
      entryRoute: "/",
      staticRoutes: ["/"],
      manifests: [
        { key: "solution-blogs", entityType: "solution-blog" },
        { key: "solution-articles", entityType: "solution-article" },
      ],
      renderers: [
        {
          key: "solution-blog-index",
          role: "index" as const,
          pattern: "/blogs/[blogSlug]",
          captureUrl: "/blogs/solutions",
          manifestKeys: ["solution-blogs", "solution-articles"],
        },
        {
          key: "solution-article-detail",
          role: "detail" as const,
          pattern: "/blogs/[blogSlug]/[slug]",
          captureUrl: "/blogs/solutions/are-thongs-comfortable-all-day",
          manifestKeys: ["solution-blogs", "solution-articles"],
        },
      ],
      dispositions: [
        { path: "/", kind: "static" as const, reason: "entry" },
        {
          path: "/blogs/solutions",
          kind: "renderer" as const,
          rendererKey: "solution-blog-index",
        },
        {
          path: "/blogs/solutions/are-thongs-comfortable-all-day",
          kind: "renderer" as const,
          rendererKey: "solution-article-detail",
        },
      ],
    };
    const bundle = await buildContentHandoffBundle({
      sourceUrl: "https://example.com",
      crawl: {
        entryUrl: "https://example.com/",
        origin: "https://example.com",
        entryPath: "/",
        paths: [
          "/",
          "/blogs/solutions",
          "/blogs/solutions/are-thongs-comfortable-all-day",
        ],
        links: [],
        depthByPath: {
          "/": 0,
          "/blogs/solutions": 1,
          "/blogs/solutions/are-thongs-comfortable-all-day": 2,
        },
        sourcesByPath: {
          "/": ["entry"],
          "/blogs/solutions": ["link"],
          "/blogs/solutions/are-thongs-comfortable-all-day": ["sitemap"],
        },
        robotsDisallow: [],
      },
      plan: {
        entry: "/",
        maxRoutes: 10,
        selected: [
          { path: "/", role: "entry", template: "/", depth: 0 },
          {
            path: "/blogs/solutions",
            role: "listing",
            template: "/blogs/[blogSlug]",
            depth: 2,
          },
          {
            path: "/blogs/solutions/are-thongs-comfortable-all-day",
            role: "representative",
            template: "/blogs/[blogSlug]/[slug]",
            depth: 3,
          },
        ],
        collections: [],
        templates: [],
        skipped: [],
      },
      experimentalClonePlan: plan,
      capturedHtmlByPath: {
        "/blogs/solutions":
          '<html><head><title>Solutions</title></head><body><h1>Solutions</h1></body></html>',
        "/blogs/solutions/are-thongs-comfortable-all-day":
          '<html><head><title>Are Thongs Comfortable?</title></head><body><article><h1>Are Thongs Comfortable?</h1><p>Yes.</p></article></body></html>',
      },
    });

    assert.equal(bundle.extractionFailures?.length ?? 0, 0);
    assert.ok(
      bundle.families.some(
        (family) =>
          family.routePattern === "/blogs/[blogSlug]" &&
          family.indexPath === "/blogs/[blogSlug]",
      ),
    );
    assert.ok(
      bundle.families.some(
        (family) =>
          family.routePattern === "/blogs/[blogSlug]/[slug]" &&
          family.indexPath === "/blogs/[blogSlug]",
      ),
    );
  });

  it("extracts sitemap-only deep entries while route planning remains entry-link scoped", async () => {
    globalThis.fetch = (async (input) =>
      ({
        ok: true,
        url: String(input),
        headers: new Headers(),
        arrayBuffer: async () =>
          new TextEncoder().encode(
            `<html><head><title>Deep article</title><meta name="description" content="Sitemap article"></head><body><article><p>Body</p></article></body></html>`,
          ).buffer,
      }) as Response) as typeof fetch;
    const paths = ["/", "/a/blog", "/a/blog/first", "/a/blog/sitemap-only"];
    const crawl: CrawlResult = {
      entryUrl: "https://shop.test/",
      entryPath: "/",
      origin: "https://shop.test",
      paths,
      depthByPath: {
        "/": 0,
        "/a/blog": 1,
        "/a/blog/first": 1,
        "/a/blog/sitemap-only": 3,
      },
      sourcesByPath: {
        "/": ["entry"],
        "/a/blog": ["link"],
        "/a/blog/first": ["link"],
        "/a/blog/sitemap-only": ["sitemap"],
      },
      robotsDisallow: [],
    };
    const routePlan: RoutePlan = {
      entry: "/",
      maxRoutes: 3,
      selected: [
        { path: "/", role: "entry", template: "/", depth: 0 },
        { path: "/a/blog", role: "listing", template: "/a/blog", depth: 1 },
        {
          path: "/a/blog/first",
          role: "representative",
          template: "/a/blog/[slug]",
          depth: 1,
        },
      ],
      collections: [],
      templates: [],
      skipped: [],
    };
    const experimentalClonePlan: IonClonePlanV1 = {
      version: "ion-clone-plan-v1",
      entryRoute: "/",
      staticRoutes: [],
      manifests: [{ key: "articles", entityType: "article" }],
      renderers: [
        {
          key: "blog-index",
          role: "index",
          pattern: "/a/blog",
          captureUrl: "/a/blog",
          manifestKeys: ["articles"],
        },
        {
          key: "article-detail",
          role: "detail",
          pattern: "/a/blog/[slug]",
          captureUrl: "/a/blog/first",
          manifestKeys: ["articles"],
        },
      ],
      dispositions: [
        { path: "/a/blog", kind: "renderer", rendererKey: "blog-index" },
        {
          path: "/a/blog/first",
          kind: "renderer",
          rendererKey: "article-detail",
        },
      ],
    };
    const bundle = await buildContentHandoffBundle({
      sourceUrl: crawl.entryUrl,
      crawl,
      plan: routePlan,
      experimentalClonePlan,
    });

    assert.deepEqual(
      bundle.families[0]?.entries.map((entry) => entry.routePath),
      ["/a/blog/first", "/a/blog/sitemap-only"],
    );
    assert.deepEqual(
      experimentalClonePlan.dispositions.map((item) => item.path),
      ["/a/blog", "/a/blog/first"],
      "the agent plan remains scoped to entry-link evidence",
    );
    assert.equal(
      bundle.routes.find((route) => route.routePath === "/a/blog/sitemap-only")
        ?.disposition,
      "cms",
      "the extracted deep entry receives the required CMS route disposition",
    );
  });

  it("treats a reused /best-selling renderer alias as satisfied", () => {
    const plan: IonClonePlanV1 = {
      version: "ion-clone-plan-v1",
      entryRoute: "/",
      staticRoutes: ["/"],
      manifests: [{ key: "products", entityType: "product" }],
      renderers: [
        {
          key: "collection-listing",
          role: "listing",
          pattern: "/collections/[type]",
          captureUrl: "/collections/wallets",
          manifestKeys: ["products"],
        },
        {
          key: "best-selling",
          role: "listing",
          pattern: "/best-selling",
          reuseRendererKey: "collection-listing",
          manifestKeys: ["products"],
        },
      ],
      dispositions: [
        { path: "/", kind: "static" },
        {
          path: "/collections/wallets",
          kind: "renderer",
          rendererKey: "collection-listing",
        },
        {
          path: "/best-selling",
          kind: "renderer",
          rendererKey: "best-selling",
        },
      ],
    };

    assert.deepEqual(
      plannedCloneFailedRoutes({
        plan,
        plannedRenderers: [
          {
            rendererKey: "collection-listing",
            captureUrl: "/collections/wallets",
            routePath: "/collections/wallets",
          },
        ],
        capturedPaths: new Set(["/", "/collections/wallets"]),
        cmsRoutes: new Set(),
        mappedManifestKeys: new Set(["products"]),
      }),
      [],
    );
  });

  it("partitions one manifest across detail patterns and keeps shared renderers entry-free", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const handle = path.split("/").filter(Boolean).at(-1)!;
      const html = path.startsWith("/collection-types/")
        ? collectionHtml(handle)
        : productHtml(handle);
      return {
        ok: true,
        url,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      } as Response;
    }) as typeof fetch;

    const paths = [
      "/",
      "/best-selling",
      "/collection-types/wallets",
      "/collections/wallets",
      "/collections/wallets/alpha",
      "/products/alpha",
    ];
    const crawl: CrawlResult = {
      entryUrl: "https://shop.test/",
      entryPath: "/",
      origin: "https://shop.test",
      paths,
      depthByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? 0 : 1]),
      ),
      sourcesByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? ["entry"] : ["link"]]),
      ),
      robotsDisallow: [],
    };
    const routePlan: RoutePlan = {
      entry: "/",
      maxRoutes: paths.length,
      selected: paths.map((path) => ({
        path,
        role: path === "/" ? "entry" : "page",
        template: path,
        depth: path === "/" ? 0 : 1,
      })),
      collections: [],
      templates: [],
      skipped: [],
    };
    const experimentalClonePlan: IonClonePlanV1 = {
      version: "ion-clone-plan-v1",
      entryRoute: "/",
      staticRoutes: ["/"],
      manifests: [
        { key: "products", entityType: "product" },
        { key: "collections", entityType: "collection" },
      ],
      renderers: [
        {
          key: "product-detail",
          role: "detail",
          pattern: "/products/[slug]",
          captureUrl: "/products/alpha",
          manifestKeys: ["products"],
        },
        {
          key: "nested-product-detail",
          role: "detail",
          pattern: "/collections/[type]/[id]",
          captureUrl: "/collections/wallets/alpha",
          manifestKeys: ["products"],
        },
        {
          key: "collection-detail",
          role: "detail",
          pattern: "/collection-types/[slug]",
          captureUrl: "/collection-types/wallets",
          manifestKeys: ["collections"],
        },
        {
          key: "collection-listing",
          role: "listing",
          pattern: "/collections/[type]",
          captureUrl: "/collections/wallets",
          manifestKeys: ["products", "collections"],
        },
        {
          key: "best-selling",
          role: "listing",
          pattern: "/best-selling",
          reuseRendererKey: "collection-listing",
          manifestKeys: ["products", "collections"],
        },
      ],
      dispositions: paths.map((path) =>
        path === "/"
          ? { path, kind: "static" as const }
          : {
              path,
              kind: "renderer" as const,
              rendererKey:
                path === "/products/alpha"
                  ? "product-detail"
                  : path === "/collections/wallets/alpha"
                    ? "nested-product-detail"
                    : path === "/collection-types/wallets"
                      ? "collection-detail"
                      : path === "/best-selling"
                        ? "best-selling"
                        : "collection-listing",
            },
      ),
    };

    const bundle = await buildContentHandoffBundle({
      sourceUrl: crawl.entryUrl,
      crawl,
      plan: routePlan,
      experimentalClonePlan,
    });
    const productFamilies = bundle.families.filter(
      (family) => family.key === "products",
    );
    assert.deepEqual(
      productFamilies.map((family) => family.routePattern),
      ["/collections/[type]/[id]", "/products/[slug]"],
    );
    assert.deepEqual(
      productFamilies.map((family) =>
        family.entries.map((entry) => entry.routePath),
      ),
      [["/collections/wallets/alpha"], ["/products/alpha"]],
    );
    assert.deepEqual(
      bundle.families
        .filter((family) => family.key === "collections")
        .flatMap((family) => family.entries.map((entry) => entry.routePath)),
      ["/collection-types/wallets"],
    );
    const importedRoutes = bundle.families.flatMap((family) =>
      family.entries.map((entry) => entry.routePath),
    );
    assert.equal(new Set(importedRoutes).size, importedRoutes.length);
    assert.equal(importedRoutes.includes("/collections/wallets"), false);
    assert.equal(bundle.extraction?.failures.length, 0);
  });

  it("uses a captured Shopify storefront host for complete products, collections, and articles", async () => {
    const sourceOrigin = "https://shop.test";
    const storefrontOrigin = "https://example-store.myshopify.com";
    const fetchedUrls: string[] = [];
    const productPayload = (handle: string) => ({
      id: handle,
      title: `Product ${handle}`,
      handle,
      description: `<p>Description for ${handle}</p>`,
      published_at: "2026-01-02T03:04:05Z",
      vendor: "Example",
      available: true,
      price: 4900,
      featured_image: `//cdn.test/${handle}.jpg`,
      images: [`//cdn.test/${handle}.jpg`],
      options: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        {
          price: 4900,
          available: true,
          sku: `${handle}-sku`,
        },
      ],
    });
    const jsonResponse = (url: string, value: unknown) =>
      ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({
          "content-type": "application/json",
        }),
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify(value)).buffer,
      }) as Response;
    const failedResponse = (url: string) =>
      ({
        ok: false,
        status: 403,
        url,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as Response;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.startsWith("/products/") && path.endsWith(".js")) {
        const handle = path.split("/").at(-1)!.replace(/\.js$/, "");
        if (parsed.origin === storefrontOrigin) return failedResponse(url);
        return jsonResponse(url, productPayload(handle));
      }
      if (
        parsed.origin === storefrontOrigin &&
        path.startsWith("/collections/") &&
        path.endsWith("/products.json")
      ) {
        const collection = path.split("/")[2]!;
        return jsonResponse(url, {
          products: [
            {
              handle: `${collection}-one`,
              title: `Product ${collection}-one`,
              body_html: `<p>Description for ${collection}-one</p>`,
              images: [{ src: `//cdn.test/${collection}-one.jpg` }],
              variants: [{ price: "49.00" }],
            },
            {
              handle: `${collection}-two`,
              title: `Product ${collection}-two`,
              body_html: `<p>Description for ${collection}-two</p>`,
              images: [{ src: `//cdn.test/${collection}-two.jpg` }],
              variants: [{ price: "49.00" }],
            },
          ],
        });
      }
      if (path.endsWith(".json")) return failedResponse(url);
      if (path.endsWith(".js") && path.startsWith("/a/blog/")) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers(),
          arrayBuffer: async () =>
            new TextEncoder().encode(
              `<html><head><title>Shop</title><meta name="description" content="Article body"></head></html>`,
            ).buffer,
        } as Response;
      }
      return failedResponse(url);
    }) as typeof fetch;

    const paths = [
      "/",
      "/a/blog/first-story",
      "/a/blog/second-story",
      "/collections/rings",
      "/collections/wallets",
      "/products/alpha",
      "/products/beta",
    ];
    const crawl: CrawlResult = {
      entryUrl: `${sourceOrigin}/`,
      entryPath: "/",
      origin: sourceOrigin,
      paths,
      depthByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? 0 : 1]),
      ),
      sourcesByPath: Object.fromEntries(
        paths.map((path) => [path, path === "/" ? ["entry"] : ["link"]]),
      ),
      robotsDisallow: [],
    };
    const routePlan: RoutePlan = {
      entry: "/",
      maxRoutes: 4,
      selected: [
        { path: "/", role: "entry", template: "/", depth: 0 },
        {
          path: "/a/blog/first-story",
          role: "representative",
          template: "/a/blog/[slug]",
          depth: 1,
        },
        {
          path: "/collections/rings",
          role: "representative",
          template: "/collections/[slug]",
          depth: 1,
        },
        {
          path: "/products/alpha",
          role: "representative",
          template: "/products/[slug]",
          depth: 1,
        },
      ],
      collections: [],
      templates: [],
      skipped: [],
    };
    const experimentalClonePlan: IonClonePlanV1 = {
      version: "ion-clone-plan-v1",
      entryRoute: "/",
      staticRoutes: ["/"],
      manifests: [
        { key: "blog-posts", entityType: "blog-post" },
        { key: "collections", entityType: "collection" },
        { key: "products", entityType: "product" },
      ],
      renderers: [
        {
          key: "blog-detail",
          role: "detail",
          pattern: "/a/blog/[slug]",
          captureUrl: "/a/blog/first-story",
          manifestKeys: ["blog-posts"],
        },
        {
          key: "collection-listing",
          role: "listing",
          pattern: "/collections/[slug]",
          captureUrl: "/collections/rings",
          manifestKeys: ["collections", "products"],
        },
        {
          key: "product-detail",
          role: "detail",
          pattern: "/products/[slug]",
          captureUrl: "/products/alpha",
          manifestKeys: ["products"],
        },
      ],
      dispositions: paths.map((path) =>
        path === "/"
          ? { path, kind: "static" as const }
          : {
              path,
              kind: "renderer" as const,
              rendererKey: path.startsWith("/products/")
                ? "product-detail"
                : path.startsWith("/collections/")
                  ? "collection-listing"
                  : "blog-detail",
            },
      ),
    };
    const bundle = await buildContentHandoffBundle({
      sourceUrl: crawl.entryUrl,
      crawl,
      plan: routePlan,
      experimentalClonePlan,
      shopifyStorefrontOrigins: [storefrontOrigin],
    });

    assert.equal(bundle.extraction?.extractedCount, 10);
    assert.deepEqual(bundle.extraction?.failures, []);
    assert.equal(bundle.coverage.cms, 10);
    assert.deepEqual(
      bundle.families.map((family) => [
        family.key,
        family.routePattern,
        family.entries.length,
      ]),
      [
        ["blog_posts", "/a/blog/[slug]", 2],
        ["collections", "/collections/[slug]", 2],
        ["products", "/products/[slug]", 6],
      ],
    );
    const rings = bundle.families
      .find((family) => family.key === "collections")!
      .entries.find((entry) => entry.slug === "rings")!;
    assert.deepEqual(rings.document.fields.custom?.productHandles, [
      "rings-one",
      "rings-two",
    ]);
    const products = bundle.families.find(
      (family) => family.key === "products",
    )!;
    assert.deepEqual(
      products.entries.map((entry) => entry.slug),
      ["alpha", "beta", "rings-one", "rings-two", "wallets-one", "wallets-two"],
    );
    for (const collection of bundle.families.find(
      (family) => family.key === "collections",
    )!.entries) {
      for (const handle of collection.document.fields.custom?.productHandles ??
        []) {
        assert.equal(
          products.entries.some((entry) => entry.slug === handle),
          true,
          `collection product ${handle} is materialized`,
        );
      }
    }
    assert.equal(
      fetchedUrls.some((url) => url.endsWith("/products/rings-one.js")),
      false,
      "collection product payloads are reused instead of refetched",
    );
    assert.equal(
      fetchedUrls.some(
        (url) =>
          url.startsWith(`${storefrontOrigin}/collections/`) &&
          url.includes("limit=1"),
      ),
      true,
      "collection ownership verifies the storefront when product redirects are protected",
    );
    assert.equal(products.entries[0]!.document.fields.custom?.price, 49);
    assert.equal(
      bundle.families.find((family) => family.key === "blog_posts")!.entries[1]!
        .document.title,
      "Second Story",
    );
  });

  it("ranks captured myshopify origins and ignores unrelated hosts", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "ditto-shopify-capture-"));
    temporaryDirectories.push(sourceDir);
    mkdirSync(join(sourceDir, "capture"));
    writeFileSync(
      join(sourceDir, "capture", "dom-1280.json"),
      JSON.stringify({
        doc: {
          title: "Captured title",
          head: {
            description: "Captured description",
            ogTitle: "Captured OG title",
            ogDescription: "Captured OG description",
            ogImage: "https://cdn.test/captured.jpg",
            jsonLd: [{ text: '{"@type":"Article","headline":"Captured"}' }],
          },
        },
        canonical: "https://real-store.myshopify.com/#redirectoff",
        analytics: {
          shopDomain: "real-store.myshopify.com",
          app: "https://app-store.myshopify.com/pages/widget",
        },
        ignored: "https://not-myshopify.com",
      }),
    );
    assert.deepEqual(shopifyStorefrontOriginsFromCapture(sourceDir), [
      "https://real-store.myshopify.com",
      "https://app-store.myshopify.com",
    ]);
    const capturedHtml = capturedStructuredHtmlFromSourceDir(sourceDir)!;
    assert.match(capturedHtml, /<title>Captured title<\/title>/);
    assert.match(capturedHtml, /application\/ld\+json/);
    assert.match(capturedHtml, /"headline":"Captured"/);
  });

  it("changes representative rewriting only for explicitly CMS-backed instances", () => {
    const { plan } = fixture();
    const legacy = buildSiteLinkTargets(plan);
    assert.equal(legacy.get("/products/beta"), "/products/alpha");

    const flagged = buildSiteLinkTargets(plan, new Set(["/products/beta"]));
    assert.equal(flagged.get("/products/beta"), "/products/beta");
    assert.equal(
      flagged.get("/products/gamma"),
      "/products/alpha",
      "unextracted routes retain the safe legacy target",
    );
  });
});
