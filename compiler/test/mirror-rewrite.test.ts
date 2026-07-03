import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AssetEntry, AssetGraph } from "../src/infer/assets.js";
import { rewriteHtmlAssetUrls } from "../src/generate/mirror.js";

function entry(sourceUrl: string, localPath: string): AssetEntry {
  return { sourceUrl, type: "image", classification: "downloaded", localPath, storedFile: "x", bytes: 1, reason: null, impact: null, via: [] };
}

function graph(entries: AssetEntry[]): AssetGraph {
  return { entries, byUrl: new Map(entries.map((e) => [e.sourceUrl, e])) };
}

const ORIGIN = "https://example.com/";

describe("rewriteHtmlAssetUrls", () => {
  it("rewrites full attribute values and same-origin pathname refs", () => {
    const g = graph([entry("https://example.com/img/logo.png", "/assets/cloned/images/ab.png")]);
    const html = `<img src="https://example.com/img/logo.png"><img src="/img/logo.png">`;
    const out = rewriteHtmlAssetUrls(html, g, ORIGIN);
    assert.equal(out, `<img src="/static/assets/cloned/images/ab.png"><img src="/static/assets/cloned/images/ab.png">`);
  });

  it("does not corrupt substrings of unrelated tokens (the ooni type=\"text/css\" bug)", () => {
    // An asset whose same-origin pathname is "/css" must not rewrite the tail of
    // `text/css`, `font/css`, or any other token containing "/css".
    const g = graph([entry("https://example.com/css", "/assets/cloned/css/x.css")]);
    const html = `<link rel="stylesheet" type="text/css" href="/css"><style>a{}</style>`;
    const out = rewriteHtmlAssetUrls(html, g, ORIGIN);
    assert.ok(out.includes(`type="text/css"`), "type attribute must stay intact");
    assert.ok(out.includes(`href="/static/assets/cloned/css/x.css"`), "real href must rewrite");
  });

  it("does not rewrite a URL that is a prefix of a longer URL", () => {
    const g = graph([entry("https://example.com/img/a", "/assets/cloned/images/a.png")]);
    const html = `<img src="/img/a"><img src="/img/a.png">`;
    const out = rewriteHtmlAssetUrls(html, g, ORIGIN);
    assert.ok(out.includes(`src="/static/assets/cloned/images/a.png"`), "exact ref rewrites");
    assert.ok(out.includes(`src="/img/a.png"`), "longer sibling URL must not be clipped");
  });

  it("rewrites srcset items and url() references", () => {
    const g = graph([entry("https://example.com/img/w800.png", "/assets/cloned/images/w800.png")]);
    const html = `<img srcset="/img/w800.png 800w, /other.png 400w"><div style="background:url(/img/w800.png)"></div>`;
    const out = rewriteHtmlAssetUrls(html, g, ORIGIN);
    assert.ok(out.includes(`srcset="/static/assets/cloned/images/w800.png 800w, /other.png 400w"`));
    assert.ok(out.includes(`url(/static/assets/cloned/images/w800.png)`));
  });

  it("preserves query-string tails and rewrites JSON-escaped refs", () => {
    const g = graph([entry("https://example.com/img/q.png", "/assets/cloned/images/q.png")]);
    const html = `<img src="/img/q.png?v=3"><script>{"img":\\"/img/q.png\\"}</script>`;
    const out = rewriteHtmlAssetUrls(html, g, ORIGIN);
    assert.ok(out.includes(`src="/assets/cloned/images/q.png?v=3"`.replace("/assets", "/static/assets")));
    assert.ok(out.includes(`\\"/static/assets/cloned/images/q.png\\"`));
  });
});
