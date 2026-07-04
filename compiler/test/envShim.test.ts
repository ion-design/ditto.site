import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  buildDeterministicEnvShim,
  captureEpochMs,
  DEFAULT_CAPTURE_EPOCH_MS,
  DEFAULT_PRNG_SEED,
} from "../src/util/envShim.js";

const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

// ---------------------------------------------------------------------------
// Item 1: deterministic-env shim — pure epoch resolution + in-browser behavior.
// ---------------------------------------------------------------------------

describe("envShim: captureEpochMs resolution", () => {
  it("defaults to the fixed epoch when no override is given", () => {
    assert.equal(captureEpochMs(), DEFAULT_CAPTURE_EPOCH_MS);
    assert.equal(captureEpochMs(undefined), DEFAULT_CAPTURE_EPOCH_MS);
  });

  it("passes a finite numeric override through unchanged", () => {
    assert.equal(captureEpochMs(1234567890), 1234567890);
  });

  it("parses a numeric string and an ISO date string", () => {
    assert.equal(captureEpochMs("1234567890"), 1234567890);
    assert.equal(captureEpochMs("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
  });

  it("falls back to the default for garbage input", () => {
    assert.equal(captureEpochMs("not-a-date"), DEFAULT_CAPTURE_EPOCH_MS);
    assert.equal(captureEpochMs(NaN), DEFAULT_CAPTURE_EPOCH_MS);
  });
});

describe("envShim: buildDeterministicEnvShim source safety", () => {
  it("interpolates only numeric literals (no injection surface)", () => {
    const src = buildDeterministicEnvShim({ seed: 42, epochMs: 1000 });
    assert.match(src, /let __s = 42 \| 0;/);
    assert.match(src, /const delta = 1000 - realNow\(\);/);
    // performance.now must remain untouched — the shim only patches Math.random + Date,
    // never assigns to performance.now (motion.ts velocity sampling depends on the real one).
    assert.equal(/performance\s*\.\s*now\s*=/.test(src), false);
    assert.equal(/defineProperty\s*\(\s*performance/.test(src), false);
  });

  it("truncates non-integer seed/epoch and uses defaults for non-finite", () => {
    const src = buildDeterministicEnvShim({ seed: 3.9, epochMs: 5.9 });
    assert.match(src, /let __s = 3 \| 0;/);
    assert.match(src, /const delta = 5 - realNow\(\);/);
    const dflt = buildDeterministicEnvShim({ seed: NaN, epochMs: Infinity });
    assert.match(dflt, new RegExp(`let __s = ${DEFAULT_PRNG_SEED} \\| 0;`));
    assert.match(dflt, new RegExp(`const delta = ${DEFAULT_CAPTURE_EPOCH_MS} - realNow\\(\\);`));
  });
});

const VW = 1280, VH = 800;

describe("envShim: in-browser behavior", () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  // Fresh page with the shim installed BEFORE any page script (via addInitScript),
  // exactly as capture.ts wires it. We navigate to a data: URL rather than setContent
  // so the document is CREATED via navigation — addInitScript fires on document
  // creation, which setContent (a content swap on the existing about:blank) skips.
  // The inline <script> then runs after the init scripts and samples the pinned env.
  const loadWithShim = async (opts: { seed?: number; epochMs?: number }, bodyScript: string): Promise<Page> => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: VW, height: VH });
    await page.addInitScript(ESBUILD_SHIM);
    await page.addInitScript(buildDeterministicEnvShim(opts));
    const html = `<!doctype html><html><body><script>${bodyScript}</script></body></html>`;
    await page.goto("data:text/html," + encodeURIComponent(html));
    return page;
  };

  it("seeds Math.random reproducibly across two independent loads (same seed → same sequence)", async () => {
    const script = "window.__draws = Array.from({length: 10}, () => Math.random());";
    const p1 = await loadWithShim({ seed: 12345, epochMs: DEFAULT_CAPTURE_EPOCH_MS }, script);
    const p2 = await loadWithShim({ seed: 12345, epochMs: DEFAULT_CAPTURE_EPOCH_MS }, script);
    const [a, b] = await Promise.all([
      p1.evaluate(() => (window as unknown as { __draws: number[] }).__draws),
      p2.evaluate(() => (window as unknown as { __draws: number[] }).__draws),
    ]);
    assert.deepEqual(a, b, "two loads with the same seed produce identical Math.random sequences");
    assert.ok(a.every((n) => n >= 0 && n < 1), "draws are in [0,1)");
    // Not a constant stream — a broken PRNG returning the same value would also be
    // "stable"; assert genuine variation so the test can't pass trivially.
    assert.ok(new Set(a).size > 1, "the sequence varies");
    await p1.close(); await p2.close();
  });

  it("a different seed yields a different sequence", async () => {
    const script = "window.__draws = Array.from({length: 10}, () => Math.random());";
    const p1 = await loadWithShim({ seed: 1, epochMs: DEFAULT_CAPTURE_EPOCH_MS }, script);
    const p2 = await loadWithShim({ seed: 2, epochMs: DEFAULT_CAPTURE_EPOCH_MS }, script);
    const [a, b] = await Promise.all([
      p1.evaluate(() => (window as unknown as { __draws: number[] }).__draws),
      p2.evaluate(() => (window as unknown as { __draws: number[] }).__draws),
    ]);
    assert.notDeepEqual(a, b);
    await p1.close(); await p2.close();
  });

  it("pins the Date epoch consistently across constructor / now() / getTime() / valueOf() / toISOString()", async () => {
    const epoch = Date.parse("2021-06-15T12:00:00Z");
    const page = await loadWithShim(
      { seed: 1, epochMs: epoch },
      `window.__t = {
         now: Date.now(),
         ctorGetTime: new Date().getTime(),
         ctorValueOf: new Date().valueOf(),
         iso: new Date().toISOString(),
       };`,
    );
    const t = await page.evaluate(() => (window as unknown as { __t: { now: number; ctorGetTime: number; ctorValueOf: number; iso: string } }).__t);
    // All reads land at the pinned epoch (within a few ms of real elapsed time between them).
    assert.ok(Math.abs(t.now - epoch) < 5000, `Date.now near epoch: ${t.now} vs ${epoch}`);
    assert.ok(Math.abs(t.ctorGetTime - epoch) < 5000, "new Date().getTime() near epoch");
    assert.ok(Math.abs(t.ctorValueOf - epoch) < 5000, "new Date().valueOf() near epoch");
    assert.match(t.iso, /^2021-06-15T12:00:0/, `toISOString pinned: ${t.iso}`);
    // now() and getTime() must agree (both read the same shifted instant).
    assert.ok(Math.abs(t.now - t.ctorGetTime) < 5000, "now() and getTime() agree");
    await page.close();
  });

  it("keeps the clock ADVANCING from the pinned epoch (timers still behave)", async () => {
    const epoch = DEFAULT_CAPTURE_EPOCH_MS;
    const page = await loadWithShim(
      { seed: 1, epochMs: epoch },
      `window.__adv = new Promise((res) => {
         const t0 = Date.now();
         setTimeout(() => res({ t0, t1: Date.now() }), 60);
       });`,
    );
    const { t0, t1 } = await page.evaluate(() => (window as unknown as { __adv: Promise<{ t0: number; t1: number }> }).__adv);
    assert.ok(t0 >= epoch - 5000 && t0 <= epoch + 5000, "start is pinned near epoch");
    assert.ok(t1 > t0, "time advances across a real setTimeout delay");
    await page.close();
  });

  it("leaves performance.now() REAL (motion sampling depends on it) and advancing", async () => {
    const page = await loadWithShim(
      { seed: 1, epochMs: DEFAULT_CAPTURE_EPOCH_MS },
      `window.__perf = new Promise((res) => {
         const p0 = performance.now();
         setTimeout(() => res({ p0, p1: performance.now() }), 40);
       });`,
    );
    const { p0, p1 } = await page.evaluate(() => (window as unknown as { __perf: Promise<{ p0: number; p1: number }> }).__perf);
    // performance.now() is a real monotonic clock from navigation start — small, not the epoch.
    assert.ok(p0 >= 0 && p0 < 60_000, `performance.now() is real (not pinned to epoch): ${p0}`);
    assert.ok(p1 > p0, "performance.now() advances");
    await page.close();
  });
});
