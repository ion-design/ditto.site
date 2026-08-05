import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIonCloneInventory } from "../src/crawl/discovery.js";
import type { CrawlResult } from "../src/crawl/crawl.js";
import { selectRoutes } from "../src/crawl/routeTemplates.js";
import {
  buildIonPlannedCrawlResult,
  buildIonPlannedRoutePlan,
  resolveCloneCrawl,
  type IonClonePlanV1,
  validateIonClonePlan,
} from "../src/site/plannedClone.js";
import { routeCaptureEvidenceOptions } from "../src/site/cloneSite.js";

const paths = [
  "/",
  "/about",
  "/a/blog",
  "/a/blog/first-post",
  "/a/blog/second-post",
  "/a/blog/third-post",
  "/collections",
  "/collections/wallets",
  "/collections/wallets/alpha",
  "/products/alpha",
];

function crawlFixture(): CrawlResult {
  return {
    entryUrl: "https://shop.test/",
    origin: "https://shop.test",
    entryPath: "/",
    paths,
    depthByPath: Object.fromEntries(
      paths.map((path) => [path, path === "/" ? 0 : 1]),
    ),
    sourcesByPath: Object.fromEntries(
      paths.map((path) => [
        path,
        path === "/" ? ["entry"] : ["link", "sitemap"],
      ]),
    ),
    linkEvidenceByPath: {
      "/about": [{ label: "About us", sourcePath: "/", region: "footer" }],
      "/a/blog": [{ label: "Journal", sourcePath: "/", region: "nav" }],
      "/collections/wallets": [
        { label: "Wallets", sourcePath: "/", region: "nav" },
      ],
    },
    robotsDisallow: [],
  };
}

function planFixture(): IonClonePlanV1 {
  return {
    version: "ion-clone-plan-v1",
    entryRoute: "/",
    staticRoutes: ["/about"],
    manifests: [
      { key: "products", entityType: "product" },
      { key: "articles", entityType: "article" },
    ],
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
        captureUrl: "/a/blog/first-post",
        manifestKeys: ["articles"],
      },
      {
        key: "nested-product-detail",
        role: "detail",
        pattern: "/collections/[productType]/[id]",
        captureUrl: "/collections/wallets/alpha",
        manifestKeys: ["products"],
        aliases: ["/products/[id]"],
      },
      {
        key: "product-detail-alias",
        role: "detail",
        pattern: "/products/[id]",
        reuseRendererKey: "nested-product-detail",
        manifestKeys: ["products"],
      },
    ],
    dispositions: [
      { path: "/about", kind: "static" },
      { path: "/a/blog", kind: "renderer", rendererKey: "blog-index" },
      {
        path: "/a/blog/first-post",
        kind: "renderer",
        rendererKey: "article-detail",
      },
      {
        path: "/products/alpha",
        kind: "renderer",
        rendererKey: "product-detail-alias",
      },
    ],
  };
}

describe("Ion clone discovery and explicit planning", () => {
  it("uses the validated plan inventory without invoking the live crawler", async () => {
    const plan = planFixture();
    plan.dispositions.push({
      path: "/account",
      kind: "passthrough",
      reason: "authenticated route",
    });
    let liveCrawls = 0;
    const crawl = await resolveCloneCrawl({
      sourceUrl: "https://shop.test/",
      experimentalClonePlan: plan,
      liveCrawl: async () => {
        liveCrawls += 1;
        return crawlFixture();
      },
    });

    assert.equal(liveCrawls, 0);
    assert.deepEqual(crawl, buildIonPlannedCrawlResult(crawl.entryUrl, plan));
    assert.equal(crawl.origin, "https://shop.test");
    assert.equal(crawl.entryPath, "/");
    assert.deepEqual(crawl.paths, [
      "/",
      "/a/blog",
      "/a/blog/first-post",
      "/about",
      "/account",
      "/collections/wallets/alpha",
      "/products/alpha",
    ]);
    assert.equal(crawl.depthByPath["/"], 0);
    assert.equal(crawl.depthByPath["/collections/wallets/alpha"], 1);
    assert.deepEqual(crawl.sourcesByPath["/"], ["entry"]);
    assert.deepEqual(crawl.sourcesByPath["/products/alpha"], ["link"]);
    assert.deepEqual(
      validateIonClonePlan(plan).manifests,
      planFixture().manifests,
      "constructing the planned crawl preserves the authored CMS manifests",
    );

    const inferred = selectRoutes({
      entryPath: crawl.entryPath,
      paths: crawl.paths,
    });
    const planned = buildIonPlannedRoutePlan(plan, crawl, inferred);
    assert.deepEqual(
      planned.routePlan.selected.map((route) => route.path),
      [
        "/",
        "/about",
        "/a/blog",
        "/a/blog/first-post",
        "/collections/wallets/alpha",
      ],
      "entry, static routes, and one capture per renderer remain selected",
    );
  });

  it("retains the legacy live-crawl path when no experimental plan is present", async () => {
    const expected = crawlFixture();
    let liveCrawls = 0;
    const actual = await resolveCloneCrawl({
      sourceUrl: expected.entryUrl,
      liveCrawl: async () => {
        liveCrawls += 1;
        return expected;
      },
    });
    assert.equal(liveCrawls, 1);
    assert.equal(actual, expected);
  });

  it("honors disabled motion for planned route captures", () => {
    assert.deepEqual(
      routeCaptureEvidenceOptions(
        { interactions: false, motion: false },
        true,
      ),
      { interactions: false, motion: false },
    );
    assert.deepEqual(routeCaptureEvidenceOptions({}, true), {
      interactions: false,
      motion: true,
    });
    assert.deepEqual(
      routeCaptureEvidenceOptions(
        { interactions: true, motion: true },
        false,
      ),
      { interactions: false, motion: false },
    );
  });

  it("returns route evidence and nested template candidates for the planning agent", () => {
    const inventory = buildIonCloneInventory(crawlFixture());
    assert.equal(inventory.version, "ion-clone-discovery-v1");
    assert.deepEqual(
      inventory.routes.find((route) => route.path === "/a/blog")?.entryLinks,
      [{ label: "Journal", sourcePath: "/", region: "nav" }],
    );
    const articles = inventory.clusters.find(
      (cluster) => cluster.pattern === "/a/blog/:id",
    );
    assert.ok(articles);
    assert.equal(articles.instances.length, 3);
    assert.equal(articles.candidateRepresentatives[0], "/a/blog/first-post");
  });

  it("captures entry, every static route, and one representative per distinct renderer", () => {
    const crawl = crawlFixture();
    const inferred = selectRoutes({ entryPath: "/", paths });
    const result = buildIonPlannedRoutePlan(planFixture(), crawl, inferred);
    assert.deepEqual(
      result.routePlan.selected.map((route) => route.path),
      [
        "/",
        "/about",
        "/a/blog",
        "/a/blog/first-post",
        "/collections/wallets/alpha",
      ],
    );
    assert.deepEqual(
      result.capturedRenderers.map((renderer) => renderer.rendererKey),
      ["blog-index", "article-detail", "nested-product-detail"],
    );
  });

  it("rejects unsafe, dangling, and cyclic renderer plans", () => {
    assert.throws(
      () =>
        validateIonClonePlan({
          ...planFixture(),
          staticRoutes: ["https://evil.test/"],
        }),
      /unsafe static route/,
    );
    const dangling = planFixture();
    dangling.renderers[0] = {
      ...dangling.renderers[0]!,
      manifestKeys: ["missing"],
    };
    assert.throws(() => validateIonClonePlan(dangling), /unknown manifest/);
    const emptyManifestKeys = planFixture();
    emptyManifestKeys.renderers[0] = {
      ...emptyManifestKeys.renderers[0]!,
      manifestKeys: [],
    };
    assert.throws(
      () => validateIonClonePlan(emptyManifestKeys),
      /at least one manifestKey/,
    );
    const unusedManifest = planFixture();
    unusedManifest.manifests.push({
      key: "press-releases",
      entityType: "press-release",
    });
    assert.throws(
      () => validateIonClonePlan(unusedManifest),
      /not referenced by a renderer/,
    );
    const cyclic = planFixture();
    cyclic.renderers[0] = {
      ...cyclic.renderers[0]!,
      captureUrl: undefined,
      reuseRendererKey: "article-detail",
    };
    cyclic.renderers[1] = {
      ...cyclic.renderers[1]!,
      captureUrl: undefined,
      reuseRendererKey: "blog-index",
    };
    assert.throws(() => validateIonClonePlan(cyclic), /reuse cycle/);
  });
});
