import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CAPTURED_ASSET_BYTES,
  MAX_CAPTURED_IMAGE_BYTES,
  MAX_CAPTURED_VISUAL_BYTES,
  MAX_CAPTURED_VIDEO_BYTES,
  capturedAssetByteLimit,
  fitsCapturedVisualBudget,
  shouldCollectAssetBody,
} from "../src/capture/capture.js";

describe("captured asset body limits", () => {
  it("bounds video bodies more tightly than other assets", () => {
    assert.equal(capturedAssetByteLimit("video"), MAX_CAPTURED_VIDEO_BYTES);
    assert.equal(capturedAssetByteLimit("image"), MAX_CAPTURED_IMAGE_BYTES);
    assert.equal(capturedAssetByteLimit("font"), MAX_CAPTURED_ASSET_BYTES);
    assert.ok(MAX_CAPTURED_VIDEO_BYTES < MAX_CAPTURED_ASSET_BYTES);
  });

  it("skips oversized and unbounded video responses", () => {
    assert.equal(shouldCollectAssetBody("video", null), false);
    assert.equal(shouldCollectAssetBody("video", MAX_CAPTURED_VIDEO_BYTES), true);
    assert.equal(shouldCollectAssetBody("video", MAX_CAPTURED_VIDEO_BYTES + 1), false);
  });

  it("allows unknown-size non-video responses but rejects known oversized ones", () => {
    assert.equal(shouldCollectAssetBody("image", null), true);
    assert.equal(shouldCollectAssetBody("image", MAX_CAPTURED_IMAGE_BYTES), true);
    assert.equal(shouldCollectAssetBody("image", MAX_CAPTURED_IMAGE_BYTES + 1), false);
  });

  it("caps aggregate visual bytes without starving CSS or fonts", () => {
    assert.equal(fitsCapturedVisualBudget("image", 1, MAX_CAPTURED_VISUAL_BYTES), false);
    assert.equal(fitsCapturedVisualBudget("video", 1, MAX_CAPTURED_VISUAL_BYTES - 1), true);
    assert.equal(fitsCapturedVisualBudget("font", MAX_CAPTURED_ASSET_BYTES, MAX_CAPTURED_VISUAL_BYTES), true);
  });
});
