import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLatestPointer } from "../src/cli.js";

describe("writeLatestPointer", () => {
  it("writes latest.json and a `latest` symlink to the newest run, refreshing it in place", () => {
    const runs = mkdtempSync(join(tmpdir(), "ditto-runs-"));
    const siteId = "example.com";

    const run1 = join(runs, siteId, "20260701-100000");
    mkdirSync(join(run1, "generated", "app"), { recursive: true });
    const stable1 = writeLatestPointer(runs, siteId, run1);

    assert.ok(existsSync(join(runs, siteId, "latest.json")), "writes latest.json breadcrumb");
    assert.ok(stable1 && existsSync(stable1), "returned stable app path resolves through the symlink");
    assert.equal(realpathSync(readlinkSync(join(runs, siteId, "latest"))), realpathSync(run1));

    // A second run must re-point the existing symlink, not throw on the collision.
    const run2 = join(runs, siteId, "20260701-200000");
    mkdirSync(join(run2, "generated", "app"), { recursive: true });
    const stable2 = writeLatestPointer(runs, siteId, run2);

    assert.equal(realpathSync(readlinkSync(join(runs, siteId, "latest"))), realpathSync(run2));
    assert.ok(stable2 && existsSync(stable2));
    // The stable path is timestamp-free (goes through `latest`, not the run's timestamp).
    assert.match(stable2!, /example\.com\/latest\/generated\/app$/);
  });
});
