import test from "node:test";
import assert from "node:assert/strict";
import { cacheKey, normalizeUrl, canonicalOptions } from "../src/cacheKey.js";
import { normalizeCloneRequestOptions } from "../src/options.js";
import type { IonClonePlanV1 } from "../src/index.js";

test("normalizeUrl: canonicalizes scheme/host/port/trailing-slash/fragment/query", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.com:443/foo/#frag"),
    "https://example.com/foo",
  );
  assert.equal(normalizeUrl("http://example.com:80/"), "http://example.com/");
  assert.equal(normalizeUrl("https://x.com"), "https://x.com/");
  assert.equal(
    normalizeUrl("https://example.com/a?b=2&a=1"),
    "https://example.com/a?a=1&b=2",
  );
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("cacheKey: stable for equivalent input, varies by options + compilerVersion", () => {
  const k1 = cacheKey(
    "https://x.com/",
    { mode: "single", styling: "tailwind" },
    "0.1.0",
  );
  const k2 = cacheKey(
    "https://x.com",
    { mode: "single", styling: "tailwind" },
    "0.1.0",
  );
  assert.equal(k1, k2, "trailing slash is normalized away");

  assert.notEqual(
    k1,
    cacheKey("https://x.com/", { mode: "multi", styling: "tailwind" }, "0.1.0"),
    "mode changes the key",
  );
  assert.notEqual(
    k1,
    cacheKey("https://x.com/", { mode: "single", styling: "css" }, "0.1.0"),
    "styling changes the key",
  );
  assert.notEqual(
    k1,
    cacheKey(
      "https://x.com/",
      { mode: "single", styling: "tailwind", framework: "vite" },
      "0.1.0",
    ),
    "framework changes the key",
  );
  assert.notEqual(
    k1,
    cacheKey(
      "https://x.com/",
      { mode: "single", styling: "tailwind" },
      "0.2.0",
    ),
    "version bump invalidates",
  );
  assert.notEqual(
    k1,
    cacheKey(
      "https://x.com/",
      { mode: "single", styling: "tailwind", verify: true },
      "0.1.0",
    ),
    "verify is part of the key",
  );
  assert.notEqual(
    k1,
    cacheKey(
      "https://x.com/",
      { mode: "single", styling: "tailwind", asyncVerify: true },
      "0.1.0",
    ),
    "asyncVerify is part of the key",
  );
  assert.notEqual(
    cacheKey("https://x.com/", { mode: "multi" }, "0.1.0"),
    cacheKey(
      "https://x.com/",
      { mode: "multi", experimentalContentHandoff: "ion-cms-v1" },
      "0.1.0",
    ),
    "experimental handoff is isolated from the legacy cache",
  );

  // noCache is a request-time switch, not an output determinant — must not change the key.
  assert.equal(
    k1,
    cacheKey(
      "https://x.com/",
      { mode: "single", styling: "tailwind", noCache: true },
      "0.1.0",
    ),
  );
});

test("canonicalOptions: deprecated aliases normalize to product options", () => {
  assert.equal(
    canonicalOptions({ mode: "multi", styling: "css" }),
    canonicalOptions({ multiPage: true, humanizeMode: "css" }),
  );
});

test("canonicalOptions: sorts viewports and is stable", () => {
  assert.equal(
    canonicalOptions({ viewports: [1920, 375, 768] }),
    canonicalOptions({ viewports: [375, 768, 1920] }),
  );
});

test("experimental content handoff is explicit, versioned, and multi-only", () => {
  assert.throws(
    () =>
      normalizeCloneRequestOptions({
        mode: "multi",
        experimentalContentHandoff: "ion-cms-v1",
      }),
    /experimentalClonePlan/,
  );
  assert.throws(
    () =>
      normalizeCloneRequestOptions({
        mode: "single",
        experimentalContentHandoff: "ion-cms-v1",
      }),
    /multi-page/,
  );
  assert.throws(
    () =>
      normalizeCloneRequestOptions({
        mode: "multi",
        framework: "vite",
        experimentalContentHandoff: "ion-cms-v1",
      }),
    /Next\.js/,
  );
  assert.throws(
    () =>
      normalizeCloneRequestOptions({
        mode: "multi",
        experimentalContentHandoff: "wrong",
      } as never),
    /ion-cms-v1/,
  );

  const experimentalClonePlan: IonClonePlanV1 = {
    version: "ion-clone-plan-v1",
    entryRoute: "/",
    staticRoutes: ["/about"],
    manifests: [],
    renderers: [],
    dispositions: [{ path: "/about", kind: "static" }],
  };
  assert.throws(
    () =>
      normalizeCloneRequestOptions({ mode: "multi", experimentalClonePlan }),
    /requires experimentalContentHandoff/,
  );
  const planned = normalizeCloneRequestOptions({
    mode: "multi",
    experimentalContentHandoff: "ion-cms-v1",
    experimentalClonePlan,
    experimentalReuseCaptureJobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(planned.experimentalClonePlan, experimentalClonePlan);
  assert.equal(
    planned.experimentalReuseCaptureJobId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.notEqual(
    cacheKey(
      "https://x.com/",
      { mode: "multi", experimentalContentHandoff: "ion-cms-v1" },
      "0.1.0",
    ),
    cacheKey("https://x.com/", planned, "0.1.0"),
    "planned and unplanned experimental jobs have isolated cache entries",
  );
  assert.throws(
    () =>
      normalizeCloneRequestOptions({
        mode: "multi",
        experimentalContentHandoff: "ion-cms-v1",
        experimentalClonePlan,
      }),
    /experimentalReuseCaptureJobId/,
  );
});
