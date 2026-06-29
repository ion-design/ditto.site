import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { InMemoryBackend, type RunJob } from "../src/backends/inMemory.js";
import { hashApiKey } from "../src/auth.js";

const noopRun: RunJob = async () => {
  throw new Error("clone should not run in these tests");
};

function appWith(opts: Partial<Parameters<typeof createApp>[0]>) {
  return createApp({ backend: new InMemoryBackend({ store: new InMemoryStore(1000), runJob: noopRun }), ...opts });
}

test("auth: 401 without key / with wrong key, 200 with a valid key; /healthz stays open", async () => {
  const app = appWith({ auth: { keyHashes: new Set([hashApiKey("s3cret")]) } });
  assert.equal((await app.request("/v1/clones")).status, 401);
  assert.equal((await app.request("/v1/clones", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await app.request("/v1/clones", { headers: { "x-api-key": "s3cret" } })).status, 200);
  assert.equal((await app.request("/v1/clones", { headers: { authorization: "Bearer s3cret" } })).status, 200);
  assert.equal((await app.request("/healthz")).status, 200, "health check is unauthenticated");
});

test("rate limit: 429 once the per-minute cap is exceeded", async () => {
  const app = appWith({ rateLimitPerMinute: 2 });
  const headers = { "x-forwarded-for": "9.9.9.9" };
  assert.equal((await app.request("/v1/clones", { headers })).status, 200);
  assert.equal((await app.request("/v1/clones", { headers })).status, 200);
  const limited = await app.request("/v1/clones", { headers });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
});

test("ssrf: a submit is rejected (400) when the URL guard throws", async () => {
  const app = appWith({
    assertUrl: async (u) => {
      if (u.includes("169.254")) throw new Error("blocked address");
    },
  });
  const res = await app.request("/v1/clones", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://169.254.169.254/" }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "url not allowed");
});
