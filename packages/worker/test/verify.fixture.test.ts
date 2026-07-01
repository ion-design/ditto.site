import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runCloneJob } from "@cloner/core";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";
import { provisionHarness, baseHarnessDir } from "../src/harness.js";

// verify = build the generated app (next build) + serve + re-render + grade. Uses an
// isolated, dep-installed harness. Skipped without Chromium; also skips gracefully if
// the harness can't be provisioned (e.g. no network for npm install).
describe("runCloneJob verify (build + gates via provisioned harness)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  let harnessDir: string | null = null;

  before(async () => {
    server = await serveDir(FIXTURES_DIR);
    try {
      harnessDir = provisionHarness(baseHarnessDir());
    } catch (e) {
      console.error("harness provisioning failed:", String(e).slice(0, 200));
      harnessDir = null;
    }
  });
  after(async () => {
    await server.close();
  });

  it("builds the clone and attaches a verify report", { timeout: 300_000 }, async (t) => {
    if (!harnessDir) {
      t.skip("harness unavailable (npm install failed)");
      return;
    }
    const res = await runCloneJob({
      url: server.url + "/components.html",
      options: { verify: true, interactions: false, components: true, motion: false },
      harnessDir,
      tier: "easy",
    });
    assert.ok(res.verify, "verify report attached");
    const v = res.verify as { gates0to6Pass: boolean; scorecard: { total: number }; gates: Record<string, unknown> };
    assert.equal(typeof v.gates0to6Pass, "boolean");
    assert.ok(v.scorecard && typeof v.scorecard.total === "number", "scorecard present");
    assert.ok(res.timings.verifyMs !== undefined && res.timings.verifyMs > 0, "verifyMs recorded");
  });
});
