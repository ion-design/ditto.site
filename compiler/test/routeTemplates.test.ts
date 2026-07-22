import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectRoutes, applyConfirmation } from "../src/crawl/routeTemplates.js";

describe("applyConfirmation keeps an exploded collection's listing page", () => {
  it("does not drop the listing route when the collection turns out to be false-positive", () => {
    const plan = selectRoutes({
      entryPath: "/",
      paths: [
        "/insights",
        "/insights/a",
        "/insights/b",
        "/insights/c",
      ],
    });

    // Sanity: /insights was collapsed into a listing + representative for a
    // /insights/:id collection, as intended.
    const collection = plan.collections.find((c) => c.template === "/insights/:id");
    assert.ok(collection, "expected an /insights/:id collection");
    assert.equal(collection!.listing, "/insights");
    assert.ok(plan.selected.some((r) => r.path === "/insights" && r.role === "listing"));

    // The structural-similarity probe rules the collection a false positive
    // (distinct pages sharing a URL prefix, not a real template) and explodes it.
    const verdicts = new Map<string, boolean>([[collection!.template, false]]);
    const rebuilt = applyConfirmation(plan, verdicts);

    // All three instances should now be individual pages...
    for (const p of ["/insights/a", "/insights/b", "/insights/c"]) {
      assert.ok(rebuilt.selected.some((r) => r.path === p), `expected ${p} to survive the explosion`);
    }
    // ...and the listing itself — a real page, not one of the collapsed
    // instances — must still be reproduced, not silently dropped.
    assert.ok(
      rebuilt.selected.some((r) => r.path === "/insights"),
      "expected /insights (the listing page) to survive the explosion",
    );
  });
});
