import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCloneRequestOptions, resolveCloneOptions } from "../src/options.js";

test("respectRobots defaults to true", () => {
  assert.equal(resolveCloneOptions({}).respectRobots, true);
  assert.equal(normalizeCloneRequestOptions({}).respectRobots, undefined);
});

test("respectRobots can be disabled per request", () => {
  const normalized = normalizeCloneRequestOptions({ respectRobots: false });
  assert.equal(normalized.respectRobots, false);
  assert.equal(resolveCloneOptions(normalized).respectRobots, false);
});

test("ion-cms-v1 skips expensive enrichment by default without changing legacy defaults", () => {
  const legacy = resolveCloneOptions({ mode: "multi" });
  assert.equal(legacy.interactions, true);
  assert.equal(legacy.components, true);
  assert.equal(legacy.motion, true);

  const handoff = resolveCloneOptions({
    mode: "multi",
    experimentalContentHandoff: "ion-cms-v1",
  });
  assert.equal(handoff.interactions, false);
  assert.equal(handoff.components, false);
  assert.equal(handoff.motion, false);

  const explicit = resolveCloneOptions({
    mode: "multi",
    experimentalContentHandoff: "ion-cms-v1",
    interactions: true,
    components: true,
    motion: true,
  });
  assert.equal(explicit.interactions, true);
  assert.equal(explicit.components, true);
  assert.equal(explicit.motion, true);
});
