import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relativizeExportRefs } from "../src/ensureAppPreview.js";

describe("relativizeExportRefs", () => {
  it("rewrites attribute refs depth-aware", () => {
    const html = `<link href="/_next/static/css/a.css"><img src="/assets/cloned/images/x.png">`;
    assert.equal(
      relativizeExportRefs(html, 0, "html"),
      `<link href="./_next/static/css/a.css"><img src="./assets/cloned/images/x.png">`,
    );
    assert.equal(
      relativizeExportRefs(html, 2, "html"),
      `<link href="../../_next/static/css/a.css"><img src="../../assets/cloned/images/x.png">`,
    );
  });

  it("rewrites JSON-escaped flight-data refs", () => {
    const html = `<script>self.__next_f.push([1,":HL[\\"/_next/static/css/a.css\\",\\"style\\"]"])</script>`;
    const out = relativizeExportRefs(html, 0, "html");
    assert.ok(out.includes(`\\"./_next/static/css/a.css\\"`), out);
  });

  it("rewrites css url() refs and srcset lists", () => {
    assert.equal(relativizeExportRefs(`body{background:url(/assets/cloned/images/b.png)}`, 0, "css"), `body{background:url(./assets/cloned/images/b.png)}`);
    const out = relativizeExportRefs(`<img srcset="/assets/a.png 1x, /assets/b.png 2x">`, 0, "html");
    assert.equal(out, `<img srcset="./assets/a.png 1x, ./assets/b.png 2x">`);
    const camel = relativizeExportRefs(`<link imageSrcSet="/assets/a.webp 768w, /assets/b.webp 1536w">`, 0, "html");
    assert.equal(camel, `<link imageSrcSet="./assets/a.webp 768w, ./assets/b.webp 1536w">`);
    const mixed = relativizeExportRefs(`<img srcSet="/assets/x.png 1x">`, 0, "html");
    assert.equal(mixed, `<img srcSet="./assets/x.png 1x">`);
  });

  it("leaves external and already-relative refs alone", () => {
    const html = `<img src="https://cdn.example.com/_next/x.js"><img src="./assets/y.png">`;
    assert.equal(relativizeExportRefs(html, 0, "html"), html);
  });
});
