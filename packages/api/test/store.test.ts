import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStore, type JobRecord } from "../src/store.js";

function record(
  status: JobRecord["status"],
  createdAt: number,
  finishedAt?: number,
): JobRecord {
  return {
    id: `${status}-${createdAt}`,
    status,
    url: "https://example.com",
    kind: "clone_site",
    options: {},
    createdAt,
    finishedAt,
  };
}

test("TTL eviction never removes an active clone", () => {
  const store = new InMemoryStore(1_000);
  const running = record("running", 1_000);
  store.put(running);
  const originalNow = Date.now;
  Date.now = () => 20_000;
  try {
    store.sweep();
    assert.deepEqual(store.get(running.id), running);
  } finally {
    Date.now = originalNow;
  }
});

test("terminal retention starts at completion instead of submission", () => {
  const store = new InMemoryStore(1_000);
  const succeeded = record("succeeded", 1_000, 20_000);
  store.put(succeeded);
  const originalNow = Date.now;
  let now = 20_500;
  Date.now = () => now;
  try {
    store.sweep();
    assert.deepEqual(store.get(succeeded.id), succeeded);

    now = 21_001;
    store.sweep();
    assert.equal(store.get(succeeded.id), undefined);
  } finally {
    Date.now = originalNow;
  }
});
