import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripUrlQueryAndHash, normalizeFetchUrl } from "../src/materialize/url-canonical.js";

describe("url-canonical", () => {
  it("strips query and hash", () => {
    assert.equal(stripUrlQueryAndHash("https://cdn.shopify.com/a.jpg?v=123#x"), "https://cdn.shopify.com/a.jpg");
  });

  it("fixes protocol-relative URLs", () => {
    assert.equal(normalizeFetchUrl("//cdn.example.com/font.woff2"), "https://cdn.example.com/font.woff2");
  });
});
