import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { collectPage, type PageSnapshot } from "../src/capture/walker.js";

// A relative url() inside a stylesheet must resolve against THAT sheet's url, not the document.
// These tests serve real CSS files at a NESTED path so `../media/x` climbs differently depending
// on the base: against the css file it lands under the nested dir, against the page it clamps to
// the site root. We assert the harvested url (cssUrls) and the face's baseHref carry the sheet
// base — the exact fix for the "HTML saved as woff2" font-materialization cluster.

// The nested layout mirrors a real bundler output:
//   /page                                      (document)
//   /marketing-static/_next/static/css/x.css   (external sheet)
//   /marketing-static/_next/static/media/f.woff2  ← where ../media/f.woff2 SHOULD resolve
const CSS_PATH = "/marketing-static/_next/static/css/x.css";
const EXPECTED_MEDIA = "/marketing-static/_next/static/media/f.woff2";
// The WRONG (document-relative) resolution the old code produced:
const WRONG_MEDIA = "/media/f.woff2";

function serveText(body: string, type: string, res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": type });
  res.end(body);
}

describe("font url() resolution against the owning stylesheet", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let origin = "";

  before(async () => {
    server = createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      if (url === "/page") {
        return serveText(
          `<!doctype html><html><head><link rel="stylesheet" href="${CSS_PATH}"></head><body><p>hi</p></body></html>`,
          "text/html",
          res,
        );
      }
      if (url === "/import-host") {
        // A same-origin sheet that @imports the nested sheet; the imported sheet's own url must be
        // the base for its faces, not the host sheet or the page.
        return serveText(
          `<!doctype html><html><head><link rel="stylesheet" href="/top.css"></head><body><p>hi</p></body></html>`,
          "text/html",
          res,
        );
      }
      if (url === "/top.css") {
        return serveText(`@import url("${CSS_PATH}");`, "text/css", res);
      }
      if (url === CSS_PATH) {
        return serveText(
          `@font-face{font-family:"Gothic";font-style:normal;font-weight:400;` +
            `src:url("../media/f.woff2") format("woff2");}` +
            `.hero{background:url("../media/bg.png")}`,
          "text/css",
          res,
        );
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") origin = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  after(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const snap = async (path: string): Promise<PageSnapshot> => {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage) as Promise<PageSnapshot>;
  };

  it("resolves a font-face src against the external sheet's url, not the document", async () => {
    const s = await snap("/page");
    assert.ok(
      s.cssUrls.includes(`${origin}${EXPECTED_MEDIA}`),
      `expected sheet-relative ${EXPECTED_MEDIA} in cssUrls, got ${JSON.stringify(s.cssUrls)}`,
    );
    assert.ok(
      !s.cssUrls.includes(`${origin}${WRONG_MEDIA}`),
      "must NOT produce the document-relative (wrong) resolution",
    );
    const face = s.fontFaces.find((f) => f.family === "Gothic");
    assert.ok(face, "font face captured");
    assert.equal(face!.baseHref, `${origin}${CSS_PATH}`, "face carries its owning sheet's base");
  });

  it("resolves ordinary style-rule url() against the sheet too", async () => {
    const s = await snap("/page");
    assert.ok(
      s.cssUrls.includes(`${origin}/marketing-static/_next/static/media/bg.png`),
      `expected sheet-relative bg.png, got ${JSON.stringify(s.cssUrls)}`,
    );
  });

  it("resolves an @import-nested sheet's face against the IMPORTED sheet's url", async () => {
    const s = await snap("/import-host");
    // top.css @imports x.css; the face lives in x.css, so ../media resolves from x.css's dir.
    assert.ok(
      s.cssUrls.includes(`${origin}${EXPECTED_MEDIA}`),
      `@import base must be the imported sheet, got ${JSON.stringify(s.cssUrls)}`,
    );
    const face = s.fontFaces.find((f) => f.family === "Gothic");
    assert.equal(face?.baseHref, `${origin}${CSS_PATH}`);
  });

  it("falls back to the document base for an inline <style> (no sheet href)", async () => {
    await page.goto(`${origin}/page`, { waitUntil: "networkidle" });
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await page.evaluate(() => {
      const st = document.createElement("style");
      st.textContent =
        '@font-face{font-family:"Inline";src:url("./inline/g.woff2") format("woff2")}';
      document.head.appendChild(st);
    });
    const s = (await page.evaluate(collectPage)) as PageSnapshot;
    // document base is /page → ./inline/g.woff2 resolves to /inline/g.woff2 (page-relative).
    assert.ok(
      s.cssUrls.includes(`${origin}/inline/g.woff2`),
      `inline <style> resolves against the document, got ${JSON.stringify(s.cssUrls)}`,
    );
    const face = s.fontFaces.find((f) => f.family === "Inline");
    assert.equal(face?.baseHref, undefined, "inline face has no sheet href");
  });
});
