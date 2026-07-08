import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCloneJobRetry } from "../src/retryPolicy.js";

describe("worker retry policy", () => {
  it("does not retry deterministic DOM-walk capture timeouts", () => {
    assert.deepEqual(classifyCloneJobRetry(new Error("collectPage timeout vp1280")), {
      retry: false,
      reason: "dom_walk_timeout",
    });
  });

  it("does not retry bot/auth wall aborts", () => {
    assert.deepEqual(classifyCloneJobRetry("auth/bot wall detected at https://example.com: capture aborted early"), {
      retry: false,
      reason: "bot_wall",
    });
  });

  it("continues retrying unrelated transient worker failures", () => {
    assert.deepEqual(classifyCloneJobRetry(new Error("S3 upload failed: ECONNRESET")), { retry: true });
  });
});

