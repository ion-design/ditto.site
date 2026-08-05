import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IonClonePlanV1 } from "../src/site/plannedClone.js";
import {
  extractWordpressContent,
  type WordpressJsonFetcher,
} from "../src/site/wordpressContent.js";

const plan: IonClonePlanV1 = {
  version: "ion-clone-plan-v1",
  entryRoute: "/",
  staticRoutes: [],
  manifests: [{ key: "press-releases", entityType: "press-release" }],
  renderers: [
    {
      key: "press-topic-listing",
      role: "listing",
      pattern: "/news/[topic]",
      captureUrl: "/news/company",
      manifestKeys: ["press-releases"],
    },
    {
      key: "press-release-detail",
      role: "detail",
      pattern: "/news/releases/[slug]",
      captureUrl: "/news/releases/launch",
      manifestKeys: ["press-releases"],
    },
  ],
  dispositions: [
    {
      path: "/news/releases/launch",
      kind: "renderer",
      rendererKey: "press-release-detail",
    },
  ],
};

describe("WordPress REST content extraction", () => {
  it("imports arbitrary planned post types with full bodies and deterministic hashes", async () => {
    const calls: string[] = [];
    const fetchJson: WordpressJsonFetcher = async <T>(url: string) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/wp-json/wp/v2/types") {
        return {
          data: {
            attachment: {
              slug: "attachment",
              rest_base: "media",
              viewable: true,
            },
            press: {
              slug: "press-release",
              rest_base: "press",
              viewable: true,
            },
          } as T,
          headers: new Headers(),
          url: parsed,
        };
      }
      assert.equal(parsed.pathname, "/wp-json/wp/v2/press");
      assert.equal(parsed.searchParams.get("per_page"), "100");
      assert.equal(parsed.searchParams.get("_embed"), "1");
      return {
        data: [
          {
            id: 42,
            type: "press-release",
            slug: "launch",
            link: "https://wp.test/news/releases/launch",
            date_gmt: "2026-01-02T03:04:05",
            title: { rendered: "Launch &amp; news" },
            excerpt: { rendered: "<p>Short summary</p>" },
            content: {
              rendered:
                '<h2>Details</h2><p>Full <strong>body</strong> with <a href="/safe">link</a> and <a href="javascript:alert(1)">bad</a>.</p>',
            },
            yoast_head_json: {
              title: "Launch SEO",
              description: "SEO description",
              robots: { index: "index" },
            },
            _embedded: {
              author: [{ name: "Ada" }],
              "wp:term": [[{ name: "Company" }]],
            },
          },
        ] as T,
        headers: new Headers({ "x-wp-totalpages": "1" }),
        url: parsed,
      };
    };

    const first = await extractWordpressContent({
      sourceUrl: "https://wp.test/",
      plan,
      fetchJson,
    });
    const second = await extractWordpressContent({
      sourceUrl: "https://wp.test/",
      plan,
      fetchJson,
    });

    assert.equal(first.detected, true);
    assert.equal(first.discoveredCount, 1);
    assert.equal(first.extractedCount, 1);
    assert.equal(first.families[0]?.key, "press_releases");
    assert.equal(first.families[0]?.kind, "press-release");
    assert.deepEqual(first.families[0]?.manifestKeys, ["press-releases"]);
    assert.equal(first.families[0]?.routePattern, "/news/releases/[slug]");
    assert.match(
      first.families[0]!.entries[0]!.document.body,
      /Full body with/,
    );
    assert.match(
      first.families[0]!.entries[0]!.document.body,
      /\[link\]\(https:\/\/wp\.test\/safe\)/,
    );
    assert.match(first.families[0]!.entries[0]!.document.body, /\[bad\]\(#\)/);
    assert.match(first.families[0]!.entries[0]!.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.families, second.families);
    assert.equal(
      calls.some((url) => url.includes("/wp-json/wp/v2/media")),
      false,
    );
  });

  it("attributes planned-manifest failures without fabricating a family", async () => {
    const fetchJson: WordpressJsonFetcher = async <T>(url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/wp-json/wp/v2/types") {
        return {
          data: {
            press: {
              slug: "press-release",
              rest_base: "press",
              viewable: true,
            },
          } as T,
          headers: new Headers(),
          url: parsed,
        };
      }
      throw new Error("REST listing unavailable");
    };

    const result = await extractWordpressContent({
      sourceUrl: "https://wp.test/",
      plan,
      fetchJson,
    });
    assert.equal(result.families.length, 0);
    assert.equal(result.failures[0]?.manifestKey, "press-releases");
    assert.equal(result.failures[0]?.familyKey, "press_releases");
    assert.match(result.failures[0]!.reason, /REST listing unavailable/);
  });
});
