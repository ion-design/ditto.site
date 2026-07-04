import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectVideoSourceIndex, type VideoSourceCandidate } from "../src/capture/capture.js";

// Predicate builders for the injected matchMedia / canPlayType.
const matchesAny = (matching: Set<string>) => (m: string) => matching.has(m);
const canPlayAll = () => true;
const canPlayNone = () => false;

describe("selectVideoSourceIndex (video <source> resource-selection)", () => {
  it("picks the first source whose media matches; missing media matches unconditionally", () => {
    // Aspect-gated hero: landscape sources first, portrait after, plain fall-through last.
    const sources: VideoSourceCandidate[] = [
      { media: "(min-aspect-ratio: 21/9)", type: "video/webm" },
      { media: "(min-aspect-ratio: 16/9)", type: "video/webm" },
      { media: "(max-aspect-ratio: 4/5)", type: "video/webm" },
      { media: null, type: "video/webm" }, // plain fall-through
    ];
    // Portrait viewport: only the max-aspect-ratio query matches → index 2.
    assert.equal(
      selectVideoSourceIndex(sources, matchesAny(new Set(["(max-aspect-ratio: 4/5)"])), canPlayAll),
      2,
    );
    // Landscape/wide viewport: the min-aspect 16/9 query matches → index 1.
    assert.equal(
      selectVideoSourceIndex(sources, matchesAny(new Set(["(min-aspect-ratio: 16/9)"])), canPlayAll),
      1,
    );
    // Nothing matches → falls through to the plain no-media source (index 3).
    assert.equal(selectVideoSourceIndex(sources, matchesAny(new Set()), canPlayAll), 3);
  });

  it("skips a source whose type the UA cannot play", () => {
    const sources: VideoSourceCandidate[] = [
      { media: null, type: "video/webm" }, // unplayable here
      { media: null, type: "video/mp4" },
    ];
    const canPlayMp4 = (t: string) => t === "video/mp4";
    assert.equal(selectVideoSourceIndex(sources, matchesAny(new Set()), canPlayMp4), 1);
  });

  it("treats a missing/empty type as never disqualifying", () => {
    const sources: VideoSourceCandidate[] = [
      { media: null, type: "" },
      { media: null },
    ];
    // canPlay is never consulted when type is absent, even if it would reject everything.
    assert.equal(selectVideoSourceIndex(sources, matchesAny(new Set()), canPlayNone), 0);
  });

  it("returns -1 when no source is eligible", () => {
    const sources: VideoSourceCandidate[] = [
      { media: "(max-aspect-ratio: 4/5)", type: "video/webm" },
    ];
    assert.equal(selectVideoSourceIndex(sources, matchesAny(new Set()), canPlayNone), -1);
    assert.equal(selectVideoSourceIndex([], matchesAny(new Set()), canPlayAll), -1);
  });

  it("is deterministic and first-match-wins in document order", () => {
    const sources: VideoSourceCandidate[] = [
      { media: "(min-width: 100px)", type: "video/mp4" },
      { media: "(min-width: 100px)", type: "video/mp4" }, // also eligible, but later
    ];
    assert.equal(selectVideoSourceIndex(sources, matchesAny(new Set(["(min-width: 100px)"])), canPlayAll), 0);
  });
});
