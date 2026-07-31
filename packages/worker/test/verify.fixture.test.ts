import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloneJob } from "@cloner/core";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";
import { provisionHarness, baseHarnessDir } from "../src/harness.js";

// Verify through the smallest real path: local capture + Vite production build + serve +
// re-render + grade. Mutable build output is isolated; the large, read-only dependency
// tree is linked from the provisioned base harness. Skipped without Chromium.
describe("runCloneJob verify (build + gates via provisioned harness)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
  let server: { url: string; close: () => Promise<void> };
  let harnessDir: string | null = null;
  let tempHarnessDir: string | null = null;

  before(async () => {
    server = await serveDir(FIXTURES_DIR);
    try {
      const base = baseHarnessDir();
      tempHarnessDir = mkdtempSync(join(tmpdir(), "worker-verify-harness-"));
      for (const file of ["package.json", "package-lock.json"]) {
        cpSync(join(base, file), join(tempHarnessDir, file));
      }
      symlinkSync(join(base, "node_modules"), join(tempHarnessDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      harnessDir = provisionHarness(tempHarnessDir, base);
    } catch (e) {
      console.error("harness provisioning failed:", String(e).slice(0, 200));
      harnessDir = null;
    }
  });
  after(async () => {
    await server.close();
    if (tempHarnessDir) rmSync(tempHarnessDir, { recursive: true, force: true });
  });

  it("builds the clone and attaches a verify report", { timeout: 600_000 }, async (t) => {
    if (!harnessDir) {
      t.skip("harness unavailable (npm install failed)");
      return;
    }
    const res = await runCloneJob({
      url: server.url + "/placeholder.html",
      options: { framework: "vite", viewports: [375], verify: true, interactions: false, components: false, motion: false },
      harnessDir,
      tier: "easy",
      log: (event) => console.log(JSON.stringify(event)),
    });
    assert.ok(res.verify, "verify report attached");
    const v = res.verify as { gates0to6Pass: boolean; scorecard: { total: number }; gates: Record<string, { pass?: boolean }> };
    assert.equal(v.gates0to6Pass, true, "deterministic fixture passes gates 0 through 6");
    assert.equal(v.gates.build?.pass, true, "generated Vite app builds and renders successfully");
    assert.ok(v.scorecard && typeof v.scorecard.total === "number", "scorecard present");
    assert.ok(res.timings.verifyMs !== undefined && res.timings.verifyMs > 0, "verifyMs recorded");
  });
});
