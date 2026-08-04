import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namedOutDirs } from "../src/cli.js";

// siteName() collapses subdomains by design (blog.example.co.uk → "example"), so
// two different sites can map to the same --out folder; exportApp rmSyncs the
// prior deliverable, silently destroying the earlier clone. The guard must
// disambiguate when the folder already belongs to a different origin.
describe("namedOutDirs subdomain collision guard", () => {
  const makeOut = () => mkdtempSync(join(tmpdir(), "ditto-out-"));

  it("reuses the siteName folder for the same origin", () => {
    const out = makeOut();
    try {
      mkdirSync(join(out, "example", ".clone"), { recursive: true });
      writeFileSync(
        join(out, "example", ".clone", "crawl.json"),
        JSON.stringify({ origin: "https://example.com", entryUrl: "https://example.com/" }),
      );
      const d = namedOutDirs(out, "https://example.com/about");
      assert.equal(d.namedDir, join(out, "example"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("disambiguates with the subdomain slug when a different origin owns the folder", () => {
    const out = makeOut();
    try {
      mkdirSync(join(out, "example", ".clone"), { recursive: true });
      writeFileSync(
        join(out, "example", ".clone", "site-manifest.json"),
        JSON.stringify({ origin: "https://example.com", sourceUrl: "https://example.com/" }),
      );
      const d = namedOutDirs(out, "https://shop.example.com/");
      assert.equal(d.namedDir, join(out, "example-shop"), "subdomain slug appended instead of clobbering");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("handles multipart TLDs (lideranca.institutoferrarezi.com.br vs institutoferrarezi.com.br)", () => {
    const out = makeOut();
    try {
      mkdirSync(join(out, "institutoferrarezi", ".clone"), { recursive: true });
      writeFileSync(
        join(out, "institutoferrarezi", ".clone", "site-manifest.json"),
        JSON.stringify({ origin: "https://institutoferrarezi.com.br", sourceUrl: "https://institutoferrarezi.com.br/" }),
      );
      const d = namedOutDirs(out, "https://lideranca.institutoferrarezi.com.br/");
      assert.equal(d.namedDir, join(out, "institutoferrarezi-lideranca"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
