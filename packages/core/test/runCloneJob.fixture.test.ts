import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClone } from "clone-static";
import { runCloneJob } from "../src/runCloneJob.js";
import { collectFileMap } from "../src/collectFileMap.js";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";

const CHROMIUM = hasChromium();

// End-to-end clone of a served fixture (zero external network). Skipped when no
// Playwright Chromium is installed (run `npx playwright install chromium` first).
describe("runCloneJob (served fixture)", { skip: CHROMIUM ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  before(async () => {
    server = await serveDir(FIXTURES_DIR);
  });
  after(async () => {
    await server.close();
  });

  it("produces the file-map contract for a single-page clone", async () => {
    const url = server.url + "/components.html";
    const res = await runCloneJob({
      url,
      options: { interactions: false, components: true, motion: false },
    });

    assert.equal(res.status, "succeeded");
    assert.equal(res.kind, "clone");
    assert.ok(res.compilerVersion);

    // The essential scaffold is present and typed correctly.
    for (const k of [
      "package.json",
      "tsconfig.json",
      "next.config.mjs",
      "src/app/layout.tsx",
      "src/app/page.tsx",
      "src/app/ditto.css",
      "src/app/globals.css",
    ]) {
      assert.ok(res.files[k], `expected file ${k}`);
      assert.equal(res.files[k]!.kind, "text");
    }
    assert.ok(res.files["src/app/page.tsx"]!.content!.includes("export default function Page"));

    // Extracted components are split into their own files (compiler change); the
    // service collects them as text automatically.
    const componentFiles = Object.keys(res.files).filter((k) => k.startsWith("src/app/components/"));
    assert.ok(componentFiles.length > 0, "extracted components emitted as separate files");
    for (const k of componentFiles) {
      assert.equal(res.files[k]!.kind, "text");
      assert.ok((res.files[k]!.content ?? "").length > 0, `${k} has content`);
    }

    // Service deliveries run the same delivery-cleanup pass as the CLI --out
    // export: no validation-only data-cid probe attrs, no `_cids.ts`, and never
    // an empty data-ditto-id={} expression (the historical RSC crash class).
    assert.equal(res.files["src/app/_cids.ts"], undefined, "_cids.ts is not shipped");
    for (const [path, f] of Object.entries(res.files)) {
      if (f.kind !== "text" || path.startsWith("public/")) continue;
      assert.ok(!(f.content ?? "").includes(" data-cid="), `${path}: no raw data-cid probe attrs`);
      assert.ok(!(f.content ?? "").includes("data-ditto-id={}"), `${path}: no empty data-ditto-id expression`);
    }

    // Capture sanity: a real fixture is not degenerate / bot-walled.
    assert.ok(res.capture.nodeCount > 0, "nodeCount > 0");
    assert.equal(res.capture.blocked, false);

    // temp dir is cleaned up by default.
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(res.runDir), false, "temp run dir removed");
  });

  it("can generate a Vite React app instead of Next", async () => {
    const url = server.url + "/components.html";
    const res = await runCloneJob({
      url,
      options: { framework: "vite", interactions: false, components: false, motion: false },
    });

    assert.equal(res.status, "succeeded");
    assert.equal(res.options.framework, "vite");
    for (const k of [
      "index.html",
      "vite.config.ts",
      "src/main.tsx",
      "src/page.tsx",
      "src/ditto.css",
      "src/globals.css",
      "public/robots.txt",
      "public/sitemap.xml",
      "public/llms.txt",
    ]) {
      assert.ok(res.files[k], `expected file ${k}`);
      assert.equal(res.files[k]!.kind, "text");
    }
    assert.ok(!res.files["next.config.mjs"], "Vite output should not include next.config.mjs");
    assert.ok(!res.files["src/app/layout.tsx"], "Vite output should not include App Router layout");
    assert.ok(res.files["package.json"]!.content!.includes('"dev": "vite"'));
    assert.ok(res.files["src/main.tsx"]!.content!.includes('from "react-dom/client"'));
    assert.ok((res.files["src/globals.css"]!.content ?? "").includes("#root { display: contents; }"));
  });

  it("names sections with valid JS identifiers even when a heading starts with a number", async () => {
    // Repro: a section whose heading reads "0019 Iterate Faster" previously became the
    // identifier `0019IterateSection` → `import 0019IterateSection` is a syntax error.
    const url = server.url + "/numeric-section.html";
    const res = await runCloneJob({ url, options: { interactions: false, components: false, motion: false } });
    assert.equal(res.status, "succeeded");

    const page = res.files["src/app/page.tsx"]!.content ?? "";
    const imports = [...page.matchAll(/^import\s+([A-Za-z0-9_$]+)\s+from/gm)].map((m) => m[1]!);
    assert.ok(imports.length > 0, "page imports section modules");
    for (const id of imports) {
      assert.match(id, /^[A-Za-z_$]/, `import identifier "${id}" must not start with a digit`);
    }
    // The numeric "0019" layer noise is dropped → a clean, valid name.
    assert.ok(imports.includes("IterateFasterSection"), `expected IterateFasterSection, got ${imports.join(", ")}`);
  });

  it("preserves generated SEO metadata, icons, JSON-LD, llms, and docs", async () => {
    const url = server.url + "/seo-rich.html";
    const res = await runCloneJob({
      url,
      options: { interactions: false, components: false, motion: false },
    });
    assert.equal(res.status, "succeeded");

    const layout = res.files["src/app/layout.tsx"]!.content ?? "";
    assert.ok(layout.includes("SEO Rich Fixture"));
    assert.ok(layout.includes("Open Graph description from the source page."));
    assert.ok(layout.includes("summary_large_image"));
    assert.ok(layout.includes("themeColor"));
    assert.ok(layout.includes("colorScheme"));
    assert.ok(layout.includes("application/ld+json"));

    assert.equal(res.files["src/app/favicon.ico"]?.kind, "binary");
    assert.equal(res.files["src/app/icon.png"]?.kind, "binary");
    assert.equal(res.files["src/app/apple-icon.png"]?.kind, "binary");
    assert.ok(Object.keys(res.files).some((k) => k.startsWith("public/assets/cloned/manifest/")), "web manifest materialized");
    assert.ok(Object.keys(res.files).some((k) => k.startsWith("public/assets/cloned/images/")), "manifest/icon image assets materialized");

    const llms = res.files["src/app/llms.txt/route.ts"]!.content ?? "";
    assert.ok(llms.includes("Source LLMS"), "source llms.txt preserved");
    const llmsFull = res.files["src/app/llms-full.txt/route.ts"]!.content ?? "";
    assert.ok(llmsFull.includes("Source LLMS Full"), "source llms-full.txt preserved");

    assert.ok(res.files["AGENTS.md"]!.content!.includes("generated ditto.site clone app"));
    assert.ok(res.files["ARCHITECTURE.md"]!.content!.includes("data-ditto-id"));
  });

  it("generates byte-identical output from one frozen capture (golden / Gate 6)", async () => {
    const url = server.url + "/components.html";
    const a = mkdtempSync(join(tmpdir(), "golden-a-"));
    const b = mkdtempSync(join(tmpdir(), "golden-b-"));
    try {
      const opts = { interactions: false, components: true, motion: false } as const;
      const r1 = await runClone({ url, runsDir: a, ...opts });
      // Regenerate from the SAME capture (no re-capture) → must be byte-identical.
      const r2 = await runClone({ url, runsDir: b, reuseSource: r1.sourceDir, ...opts });

      const m1 = collectFileMap(r1.runDir);
      const m2 = collectFileMap(r2.runDir);
      // Same file set + byte-identical contents across regenerations — covers the
      // scaffold AND the split components/*.tsx, all from one frozen capture.
      assert.deepEqual(Object.keys(m1).sort(), Object.keys(m2).sort(), "identical file set across regenerations");
      for (const f of Object.keys(m1)) {
        assert.equal(m1[f]!.sha256, m2[f]!.sha256, `${f} is byte-identical across regenerations`);
      }
      assert.ok(Object.keys(m1).some((k) => k.startsWith("src/app/components/")), "components are split into files");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
