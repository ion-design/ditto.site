import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { doneSummary, shellQuote } from "../src/cliSummary.js";

describe("shellQuote", () => {
  it("wraps a path in double quotes so spaces survive copy-paste", () => {
    assert.equal(shellQuote("/Users/x/runs/site/20260701/generated/app"), '"/Users/x/runs/site/20260701/generated/app"');
    assert.equal(shellQuote("/Users/x/My Sites/app"), '"/Users/x/My Sites/app"');
  });

  it("escapes characters the shell would otherwise interpret inside double quotes", () => {
    assert.equal(shellQuote('/a/"b"/$c/`d`/e\\f'), '"/a/\\"b\\"/\\$c/\\`d\\`/e\\\\f"');
  });
});

describe("doneSummary", () => {
  const base = { url: "https://academyux.com/", appDir: "/runs/academyux.com/20260701-173012/generated/app", framework: "next" as const };

  it("emits a single quoted preview line (no mid-word wrap on the path)", () => {
    const out = doneSummary(base);
    const line = out.split("\n").find((l) => l.includes("cd "));
    assert.ok(line, "has a cd line");
    // one line, path is quoted so a wrapping terminal can't split the command
    assert.match(line!, /cd "\/runs\/academyux\.com\/20260701-173012\/generated\/app" && npm install && npm run dev/);
  });

  it("points at the Next safe-edit areas from AGENTS.md", () => {
    const out = doneSummary(base);
    assert.match(out, /src\/app\/content\.ts/);
    assert.match(out, /src\/app\/components\//);
    assert.match(out, /AGENTS\.md/);
  });

  it("uses the Vite src root when framework is vite", () => {
    const out = doneSummary({ ...base, framework: "vite" });
    assert.match(out, /cd .* && npm install && npm run dev/);
    assert.match(out, /• page copy & content {2}→ {2}src\/content\.ts/);
    assert.match(out, /• components {11}→ {2}src\/components\//);
  });

  it("prefers the stable path as the cd target and still shows the exact run", () => {
    const out = doneSummary({ ...base, stableAppDir: "/runs/academyux.com/latest/generated/app" });
    const cdLine = out.split("\n").find((l) => l.includes("cd "))!;
    assert.match(cdLine, /cd "\/runs\/academyux\.com\/latest\/generated\/app"/);
    assert.match(out, /This exact run/);
    assert.match(out, /\/runs\/academyux\.com\/20260701-173012\/generated\/app/);
  });

  it("mentions the --serve / --open shortcut", () => {
    assert.match(doneSummary(base), /--serve/);
    assert.match(doneSummary(base), /--open/);
  });
});
