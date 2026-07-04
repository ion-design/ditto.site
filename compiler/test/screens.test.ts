import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBands } from "../src/generate/css.js";
import { bandScreens, prefixFor, tailwindGlobalsCss } from "../src/generate/tailwind.js";

/** Interval covered by a ditto.css band media query (integer px, inclusive). */
function bandInterval(media: string | null): [number, number] {
  if (!media) return [0, Infinity];
  const min = /min-width:\s*(\d+)px/.exec(media);
  const max = /max-width:\s*(\d+)px/.exec(media);
  return [min ? +min[1]! : 0, max ? +max[1]! : Infinity];
}

/** Integer interval covered by a Tailwind variant prefix under the given screens.
 *  v4 semantics for named AND arbitrary variants: `X:` = width >= X; `max-X:` = width < X. */
function prefixInterval(prefix: string, screens: Map<string, number>): [number, number] {
  let lo = 0, hi = Infinity;
  for (const m of prefix.matchAll(/(max-)?(?:(sm|md|lg|xl|2xl)|(?:min-)?\[(\d+)px\]):/g)) {
    const px = m[3] ? +m[3] : screens.get(m[2]!);
    assert.ok(px !== undefined, `screen defined for ${m[0]}`);
    if (m[1]) hi = Math.min(hi, px! - 1);
    else lo = Math.max(lo, px!);
  }
  return [lo, hi];
}

function assertAgreement(viewports: number[], canonical: number): void {
  const screens = new Map(bandScreens(viewports, canonical));
  for (const b of computeBands(viewports, canonical)) {
    if (!b.media) continue;
    assert.deepEqual(
      prefixInterval(prefixFor(b.media), screens),
      bandInterval(b.media),
      `band vp${b.vp} (${b.media}) matches its Tailwind prefix`,
    );
  }
}

describe("tailwind screens agree with computeBands boundaries", () => {
  it("standard 375/768/1280/1920 ladder: md/lg/2xl pinned to the band midpoint boundaries", () => {
    const screens = new Map(bandScreens([375, 768, 1280, 1920], 1280));
    // Midpoints 571/1024/1600 → bands ≤571, 572–1024, base, ≥1601.
    assert.deepEqual([...screens], [["md", 572], ["lg", 1025], ["2xl", 1601]]);
    // NOT Tailwind's stock 768/1024/1536 — stock 2xl (1536) would flip utility-classed
    // nodes to the 1920 layout in 1536–1600 while ditto.css still holds the 1280 layout.
    assert.notEqual(screens.get("2xl"), 1536);
    assertAgreement([375, 768, 1280, 1920], 1280);
  });

  it("odd viewport set: bands fall back to exact arbitrary prefixes (no named screens needed)", () => {
    assert.deepEqual(bandScreens([320, 900, 1440], 900), []);
    assertAgreement([320, 900, 1440], 900);
  });

  it("emits the derived screens into the generated @theme", () => {
    const css = tailwindGlobalsCss({
      reset: "", fontCss: "", tokensCss: "", htmlBg: "#fff", bodyFont: "sans-serif",
      clip: "", colorTokens: [], viewports: [375, 768, 1280, 1920], canonical: 1280,
    });
    assert.ok(css.includes("--breakpoint-md: 572px;"));
    assert.ok(css.includes("--breakpoint-lg: 1025px;"));
    assert.ok(css.includes("--breakpoint-2xl: 1601px;"));
  });
});
