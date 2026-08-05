import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AssetEntry, AssetGraph } from "../src/infer/assets.js";
import { applyGeneratedSiteVisualBudget } from "../src/site/generateSite.js";

function entry(sourceUrl: string, bytes: number, type = "image"): AssetEntry {
  const storedFile = `${sourceUrl}.webp`;
  return {
    sourceUrl,
    type,
    classification: "downloaded",
    localPath: `/assets/cloned/images/${storedFile}`,
    storedFile,
    bytes,
    reason: null,
    impact: null,
    via: ["network"],
  };
}

function graph(entries: AssetEntry[]): AssetGraph {
  return { entries, byUrl: new Map(entries.map((item) => [item.sourceUrl, item])) };
}

describe("generated site visual budget", () => {
  it("allocates visual bytes round-robin so later routes retain assets", () => {
    const first = graph([entry("first-small", 4), entry("first-large", 8)]);
    const second = graph([entry("second-small", 4), entry("second-large", 8)]);

    const result = applyGeneratedSiteVisualBudget([first, second], 8);

    assert.equal(result.keptBytes, 8);
    assert.equal(first.byUrl.get("first-small")?.classification, "downloaded");
    assert.equal(second.byUrl.get("second-small")?.classification, "downloaded");
    assert.equal(first.byUrl.get("first-large")?.reason, "site_visual_budget");
    assert.equal(second.byUrl.get("second-large")?.reason, "site_visual_budget");
  });

  it("deduplicates shared public paths and never budgets fonts", () => {
    const sharedA = entry("shared-a", 6);
    const sharedB = { ...entry("shared-b", 6), localPath: sharedA.localPath, storedFile: sharedA.storedFile };
    const font = entry("font", 100, "font");
    const first = graph([sharedA, font]);
    const second = graph([sharedB]);

    const result = applyGeneratedSiteVisualBudget([first, second], 6);

    assert.equal(result.keptBytes, 6);
    assert.equal(sharedA.classification, "downloaded");
    assert.equal(sharedB.classification, "downloaded");
    assert.equal(font.classification, "downloaded");
  });
});
