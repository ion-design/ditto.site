import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssetFailure, ASSET_RETRY_DELAY_MS } from "../src/capture/capture.js";

describe("asset download retry decision", () => {
  it("retries visual/font assets on network error (no response)", () => {
    for (const type of ["image", "svg", "video", "font"]) {
      assert.equal(isRetryableAssetFailure(type, null), true, `${type} + network error retries`);
    }
  });

  it("retries visual/font assets on transient server states (5xx, 429)", () => {
    assert.equal(isRetryableAssetFailure("image", 500), true);
    assert.equal(isRetryableAssetFailure("image", 503), true);
    assert.equal(isRetryableAssetFailure("video", 502), true);
    assert.equal(isRetryableAssetFailure("font", 429), true);
  });

  it("does NOT retry authoritative 4xx failures (404/403/410)", () => {
    assert.equal(isRetryableAssetFailure("image", 404), false);
    assert.equal(isRetryableAssetFailure("image", 403), false);
    assert.equal(isRetryableAssetFailure("video", 410), false);
    assert.equal(isRetryableAssetFailure("font", 401), false);
  });

  it("does NOT retry non-visual asset types at all", () => {
    assert.equal(isRetryableAssetFailure("css", null), false);
    assert.equal(isRetryableAssetFailure("manifest", 500), false);
    assert.equal(isRetryableAssetFailure("lottie", 503), false);
    assert.equal(isRetryableAssetFailure("other", null), false);
  });

  it("uses a fixed, bounded retry delay (deterministic — no jitter)", () => {
    assert.equal(typeof ASSET_RETRY_DELAY_MS, "number");
    assert.ok(ASSET_RETRY_DELAY_MS > 0 && ASSET_RETRY_DELAY_MS <= 2000);
  });
});
