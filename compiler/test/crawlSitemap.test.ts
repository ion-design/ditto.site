import test from "node:test";
import assert from "node:assert/strict";
import { discoverSitemapPaths, MAX_SITEMAP_URLS } from "../src/crawl/crawl.js";

const urlset = (start: number, count: number): string =>
  `<urlset>${Array.from(
    { length: count },
    (_, index) =>
      `<url><loc>https://shop.test/products/item-${start + index}</loc></url>`,
  ).join("")}</urlset>`;

test("sitemap discovery traverses enough child documents to exceed the old 2,000-route ceiling", async () => {
  const childCount = 125;
  const childSize = 100;
  const index = `<sitemapindex>${Array.from(
    { length: childCount },
    (_, index) =>
      `<sitemap><loc>https://shop.test/sitemaps/${index}.xml</loc></sitemap>`,
  ).join("")}</sitemapindex>`;
  const fetched: string[] = [];

  const paths = await discoverSitemapPaths({
    origin: "https://shop.test",
    base: "https://shop.test/",
    cap: MAX_SITEMAP_URLS,
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith("/sitemap.xml")) return index;
      if (url.endsWith("/sitemap_index.xml")) return null;
      const match = /\/sitemaps\/(\d+)\.xml$/.exec(url);
      return match ? urlset(Number(match[1]) * childSize, childSize) : null;
    },
  });

  assert.equal(paths.length, MAX_SITEMAP_URLS);
  assert.ok(paths.length > 2_000);
  assert.ok(
    fetched.some((url) => url.endsWith("/sitemaps/99.xml")),
    "traversal reaches enough child sitemap documents to fill the 10,000 cap",
  );
  assert.equal(paths.includes("/products/item-10000"), false);
});

test("sitemap discovery respects a smaller caller-provided bound", async () => {
  const paths = await discoverSitemapPaths({
    origin: "https://shop.test",
    base: "https://shop.test/",
    cap: 3,
    fetch: async (url) => (url.endsWith("/sitemap.xml") ? urlset(0, 20) : null),
  });
  assert.deepEqual(paths, [
    "/products/item-0",
    "/products/item-1",
    "/products/item-2",
  ]);
});

test("sitemap discovery never exceeds the shared 10,000-route ceiling", async () => {
  const paths = await discoverSitemapPaths({
    origin: "https://shop.test",
    base: "https://shop.test/",
    cap: 50_000,
    fetch: async (url) =>
      url.endsWith("/sitemap.xml") ? urlset(0, 10_100) : null,
  });
  assert.equal(paths.length, MAX_SITEMAP_URLS);
});
