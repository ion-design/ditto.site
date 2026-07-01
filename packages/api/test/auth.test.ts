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

test("signup: public endpoint mints a stored-hash API key that can access protected routes", async () => {
  const created: { keyHash: string; label: string; rateLimit?: number }[] = [];
  const app = appWith({
    auth: {
      keyHashes: new Set(),
      lookup: async (h) => created.some((k) => k.keyHash === h),
    },
    signup: {
      createApiKey: async (input) => {
        created.push(input);
      },
      defaultRateLimit: 30,
      rateLimitPerHour: 3,
    },
  });

  const res = await app.request("/v1/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "2.2.2.2" },
    body: JSON.stringify({ email: "USER@Example.com", label: "Beta" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.apiKey, /^dtto_live_/);
  assert.equal(body.message, "Save this key now; it will not be shown again.");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.keyHash, hashApiKey(body.apiKey));
  assert.equal(created[0]!.label, "user@example.com (Beta)");
  assert.equal(created[0]!.rateLimit, 30);

  assert.equal((await app.request("/v1/clones")).status, 401, "clone routes still require auth");
  assert.equal((await app.request("/v1/clones", { headers: { authorization: `Bearer ${body.apiKey}` } })).status, 200);
});

test("signup: validates email and rate-limits per IP", async () => {
  const app = appWith({
    signup: {
      createApiKey: async () => {},
      rateLimitPerHour: 1,
    },
  });
  assert.equal(
    (await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "3.3.3.3" }, body: JSON.stringify({ email: "not-an-email" }) })).status,
    400,
  );
  const headers = { "content-type": "application/json", "x-forwarded-for": "4.4.4.4" };
  assert.equal((await app.request("/v1/signup", { method: "POST", headers, body: JSON.stringify({ email: "a@example.com" }) })).status, 201);
  assert.equal((await app.request("/v1/signup", { method: "POST", headers, body: JSON.stringify({ email: "b@example.com" }) })).status, 429);
});

test("signup email verification: request sends a one-time link; verify mints a working key", async () => {
  const createdKeys: { keyHash: string; label: string; rateLimit?: number }[] = [];
  const tokens = new Map<string, string>();
  let sent: { email: string; verifyUrl: string; expiresAt: Date } | undefined;
  const app = appWith({
    auth: {
      keyHashes: new Set(),
      lookup: async (h) => createdKeys.some((k) => k.keyHash === h),
    },
    signup: {
      createApiKey: async (input) => {
        createdKeys.push(input);
      },
      defaultRateLimit: 30,
      directEnabled: false,
      email: {
        createToken: async (input) => {
          tokens.set(input.tokenHash, input.email);
        },
        consumeToken: async (tokenHash) => {
          const email = tokens.get(tokenHash);
          if (!email) return undefined;
          tokens.delete(tokenHash);
          return { email };
        },
        sendVerificationEmail: async (input) => {
          sent = input;
        },
        verifyUrl: "https://ditto.site/api-key",
        tokenTtlMs: 30 * 60 * 1000,
      },
    },
  });

  assert.equal((await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) })).status, 404);
  const request = await app.request("/v1/signup/request", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" },
    body: JSON.stringify({ email: "USER@Example.com" }),
  });
  assert.equal(request.status, 202);
  assert.equal((await request.json()).message, "Check your email for a verification link.");
  assert.equal(sent?.email, "user@example.com");
  assert.ok(sent?.verifyUrl.startsWith("https://ditto.site/api-key?token=dtto_signup_"));

  const token = new URL(sent!.verifyUrl).searchParams.get("token")!;
  const verify = await app.request("/v1/signup/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verify.status, 201);
  const body = await verify.json();
  assert.match(body.apiKey, /^dtto_live_/);
  assert.equal(createdKeys.length, 1);
  assert.equal(createdKeys[0]!.label, "user@example.com");
  assert.equal((await app.request("/v1/clones", { headers: { authorization: `Bearer ${body.apiKey}` } })).status, 200);

  const replay = await app.request("/v1/signup/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(replay.status, 400);
});

test("signup: browser CORS is allowed only for configured origins", async () => {
  const app = appWith({
    signupCorsOrigins: ["https://ditto.site"],
    signup: {
      createApiKey: async () => {},
      rateLimitPerHour: 0,
      directEnabled: false,
      email: {
        createToken: async () => {},
        consumeToken: async () => undefined,
        sendVerificationEmail: async () => {},
        verifyUrl: "https://ditto.site/api-key",
        tokenTtlMs: 30 * 60 * 1000,
      },
    },
  });

  const preflight = await app.request("/v1/signup/request", {
    method: "OPTIONS",
    headers: {
      origin: "https://ditto.site",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://ditto.site");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i);

  const denied = await app.request("/v1/signup/request", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
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
