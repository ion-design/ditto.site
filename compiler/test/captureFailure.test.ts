import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WALL_RE,
  isWallText,
  isBotWall,
  diagnoseBotWall,
  WALL_MAX_NODES,
  CaptureRejectedError,
  CAPTURE_REJECTED_CODE,
  classifyNavFailure,
  isRetryableNavFailure,
  type WallProbe,
} from "../src/util/captureFailure.js";

const RIDGE_CLOUDFLARE = JSON.parse(
  readFileSync(new URL("../fixtures/ridge-cloudflare-challenge.json", import.meta.url), "utf8"),
) as WallProbe;

// ---------------------------------------------------------------------------
// Item 3: capture-side fast-fail predicates (pure — no browser).
// ---------------------------------------------------------------------------

describe("captureFailure: wall-text detection", () => {
  it("matches common bot/auth-wall fingerprints", () => {
    for (const t of [
      "Just a moment...",
      "Checking your browser before accessing",
      "Please enable JavaScript to continue",
      "Access to this page has been denied",
      "Are you a human?",
      "Verify you are human",
      "Attention Required! | Cloudflare",
      "Please complete the CAPTCHA",
      "DDoS protection by Cloudflare",
      "Your connection needs to be verified before you can proceed",
      "Incorrect device time",
      "Performing security verification",
    ]) {
      assert.ok(isWallText(t), `expected wall text to match: ${t}`);
    }
  });

  it("does not match ordinary marketing/body copy", () => {
    for (const t of [
      "Welcome to our store — shop the new collection",
      "Our team of humans is here to help you 24/7",
      "Enable notifications to get the latest deals",
      "About us · Careers · Contact",
    ]) {
      assert.equal(isWallText(t), false, `expected NOT to match: ${t}`);
    }
  });

  it("WALL_RE is the same instance shared with the pollution gate (single source of truth)", () => {
    // gates.ts imports WALL_RE from this module; assert the export is a real RegExp
    // so a refactor that turns it into a function would fail here.
    assert.ok(WALL_RE instanceof RegExp);
  });
});

describe("captureFailure: isBotWall (matches the pollution gate's small+wall rule)", () => {
  it("flags a small page with wall text", () => {
    assert.ok(isBotWall({ text: "Just a moment...", nodes: 8 }));
    assert.ok(isBotWall({ text: "checking your browser", nodes: WALL_MAX_NODES - 1 }));
  });

  it("does NOT flag a large page that merely mentions a wall phrase", () => {
    // A real page can say "captcha" in its help docs — node count is the discriminator.
    assert.equal(isBotWall({ text: "how our captcha works", nodes: WALL_MAX_NODES }), false);
    assert.equal(isBotWall({ text: "how our captcha works", nodes: 5000 }), false);
  });

  it("does NOT flag a small page with no wall text", () => {
    assert.equal(isBotWall({ text: "Home · About · Contact", nodes: 10 }), false);
  });

  it("is null-safe", () => {
    assert.equal(isBotWall(null), false);
    assert.equal(isBotWall(undefined), false);
  });
});

describe("captureFailure: structured challenge diagnosis", () => {
  it("rejects the captured Ridge/Cloudflare incorrect-device-time fixture", () => {
    const diagnosis = diagnoseBotWall(RIDGE_CLOUDFLARE);
    assert.equal(diagnosis.isWall, true);
    assert.equal(diagnosis.provider, "cloudflare");
    assert.equal(diagnosis.nodeCount, 347, "fixture intentionally exceeds the legacy 220-node ceiling");
    assert.ok(diagnosis.matchedSignals.includes("text.incorrect-device-time"));
    assert.ok(diagnosis.matchedSignals.includes("cloudflare.challenge-platform-url"));
  });

  it("uses a challenge-style title with supporting body text even on a large DOM", () => {
    const diagnosis = diagnoseBotWall({
      title: "Just a moment...",
      bodyText: "Enable JavaScript and cookies to continue.",
      finalUrl: "https://example.com/",
      nodeCount: 900,
    });
    assert.equal(diagnosis.isWall, true);
    assert.ok(diagnosis.matchedSignals.includes("title.challenge"));
  });

  it("treats Cloudflare challenge-platform and cf-chl identifiers as strong signals", () => {
    for (const probe of [
      { nodeCount: 5000, resourceUrls: ["https://example.com/cdn-cgi/challenge-platform/x"] },
      { nodeCount: 5000, identifiers: ["cf-chl-widget-abc"] },
      { nodeCount: 5000, identifiers: ["challenge-form"] },
      { nodeCount: 5000, identifiers: ["_cf_chl_opt"] },
    ] satisfies WallProbe[]) {
      assert.equal(diagnoseBotWall(probe).isWall, true, JSON.stringify(probe));
    }
  });

  it("does not reject an ordinary page that merely mentions Cloudflare or CAPTCHA", () => {
    const diagnosis = diagnoseBotWall({
      title: "How our security works",
      bodyText: "Our documentation explains Cloudflare, CAPTCHA accessibility, and bot protection.",
      finalUrl: "https://docs.example.com/security",
      nodeCount: 1800,
      resourceUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
      identifiers: ["newsletter-turnstile"],
    });
    assert.equal(diagnosis.isWall, false);
  });

  it("creates a typed, stable, HTML-free rejection", () => {
    const error = new CaptureRejectedError(diagnoseBotWall(RIDGE_CLOUDFLARE));
    assert.equal(error.code, CAPTURE_REJECTED_CODE);
    assert.match(error.message, /ANTI_BOT_CHALLENGE/);
    assert.doesNotMatch(error.message, /<html/i);
  });
});

describe("captureFailure: classifyNavFailure", () => {
  it("classifies session-death / crash / transient network as retryable", () => {
    for (const msg of [
      "Target page, context or browser has been closed",
      "Target closed",
      "browser has been closed",
      "page has crashed",
      "net::ERR_CONNECTION_RESET at https://example.com",
      "net::ERR_TIMED_OUT",
      "Timeout 45000ms exceeded",
      "Navigation timeout of 30000 ms exceeded",
    ]) {
      assert.equal(classifyNavFailure(new Error(msg)), "retryable", msg);
      assert.equal(isRetryableNavFailure(new Error(msg)), true, msg);
    }
  });

  it("classifies wall fingerprints as wall (not retryable — a fresh context can't help)", () => {
    const e = new Error("navigation failed: just a moment... checking your browser");
    assert.equal(classifyNavFailure(e), "wall");
    assert.equal(isRetryableNavFailure(e), false);
  });

  it("classifies hard failures as terminal (not retryable)", () => {
    for (const msg of [
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_CERT_AUTHORITY_INVALID",
      "net::ERR_CONNECTION_REFUSED",
      "something totally unexpected",
    ]) {
      assert.equal(classifyNavFailure(new Error(msg)), "terminal", msg);
      assert.equal(isRetryableNavFailure(new Error(msg)), false, msg);
    }
  });

  it("wall wins over a transient signature (a wall served over a reset is still a wall)", () => {
    const e = new Error("net::ERR_CONNECTION_RESET — access denied");
    assert.equal(classifyNavFailure(e), "wall");
  });

  it("accepts a bare string or non-Error value", () => {
    assert.equal(classifyNavFailure("Target closed"), "retryable");
    assert.equal(classifyNavFailure(undefined), "terminal");
  });
});
