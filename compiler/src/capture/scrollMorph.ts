import type { Page } from "playwright";
import type { CapStyle } from "./interactions.js";

/**
 * Scroll-morph capture (M6): a fixed/sticky header that restyles once the page scrolls past
 * some point (shrinks, gains a solid background, swaps its logo/link colors for contrast) has
 * no CSS pseudo-class to hook — unlike :hover/:focus, it can only be observed by actually
 * scrolling the live page and diffing computed style before/after. Two states are captured
 * (rest at scroll 0, scrolled at a deep probe depth) for the candidate root and its descendants;
 * if nothing differs, the candidate is dropped (the common case — most fixed headers don't
 * morph). When something DOES differ, a binary search over scroll depth finds the actual pixel
 * threshold the source page uses, so the clone's runtime toggle fires at the same point rather
 * than either "on any scroll" or "only past our arbitrary probe depth".
 */

export type ScrollSpec = {
  kind: "scroll";
  rootCap: string;
  thresholdPx: number;
  restStyle: CapStyle;
  scrolledStyle: CapStyle;
  descendants?: Record<string, { rest: CapStyle; scrolled: CapStyle }>;
};

// Curated: properties a "sticky header goes solid on scroll" pattern realistically changes on
// the root (background/shadow/border, plus a height or padding shrink) and on descendants (the
// logo/link color swap that follows from losing the hero photo behind it).
const ROOT_PROPS = [
  "backgroundColor", "backgroundImage", "boxShadow", "backdropFilter",
  "borderBottomColor", "borderBottomWidth", "borderBottomStyle",
  "height", "paddingTop", "paddingBottom",
] as const;
const DESC_PROPS = ["color", "backgroundColor", "opacity", "fill"] as const;

function pick(o: CapStyle, keys: string[]): CapStyle {
  const out: CapStyle = {};
  for (const k of keys) out[k] = o[k]!;
  return out;
}

function diffKeys(a: CapStyle, b: CapStyle): string[] {
  return Object.keys(b).filter((k) => a[k] !== b[k]);
}

async function readProps(page: Page, cap: string, props: readonly string[]): Promise<CapStyle | null> {
  return page.evaluate(({ cap, props }) => {
    const el = document.querySelector(`[data-cid-cap="${cap}"]`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const o: Record<string, string> = {};
    for (const p of props) { const v = (cs as unknown as Record<string, string>)[p]; if (v != null) o[p] = v; }
    return o;
  }, { cap, props: props as unknown as string[] });
}

/** Candidates: fixed/sticky elements pinned flush against the top of the viewport (a header),
 *  wide enough to plausibly be a page-level bar rather than a small floating widget. */
async function findCandidates(page: Page): Promise<Array<{ cap: string; descCaps: string[] }>> {
  return page.evaluate(() => {
    const out: Array<{ cap: string; descCaps: string[] }> = [];
    for (const el of Array.from(document.querySelectorAll("[data-cid-cap]"))) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.top > 4 || r.width < window.innerWidth * 0.5 || r.height <= 0) continue;
      const cap = el.getAttribute("data-cid-cap");
      if (!cap) continue;
      const descCaps = Array.from(el.querySelectorAll("[data-cid-cap]")).slice(0, 40)
        .map((d) => d.getAttribute("data-cid-cap"))
        .filter((d): d is string => !!d);
      out.push({ cap, descCaps });
    }
    return out;
  });
}

export async function captureScrollMorph(page: Page, log: (e: Record<string, unknown>) => void): Promise<ScrollSpec[]> {
  const candidates = await findCandidates(page);
  if (!candidates.length) return [];

  const maxScroll = await page.evaluate(() => Math.max(document.documentElement.scrollHeight - window.innerHeight, 0));
  const probeDepth = Math.min(1200, Math.round(maxScroll * 0.6));
  if (probeDepth < 40) return []; // page barely scrolls — nothing meaningful to probe

  const specs: ScrollSpec[] = [];
  for (const { cap, descCaps } of candidates) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const restRoot = await readProps(page, cap, ROOT_PROPS);
    if (!restRoot) continue;
    const restDesc: Record<string, CapStyle> = {};
    for (const d of descCaps) { const s = await readProps(page, d, DESC_PROPS); if (s) restDesc[d] = s; }

    await page.evaluate((y) => window.scrollTo(0, y), probeDepth);
    await page.waitForTimeout(600); // let a scroll-triggered CSS transition (commonly ~300ms) finish before reading
    const scrolledRoot = await readProps(page, cap, ROOT_PROPS);
    if (!scrolledRoot) continue;
    const scrolledDesc: Record<string, CapStyle> = {};
    for (const d of descCaps) { const s = await readProps(page, d, DESC_PROPS); if (s) scrolledDesc[d] = s; }

    const rootKeys = diffKeys(restRoot, scrolledRoot);
    const descDeltas: Record<string, { rest: CapStyle; scrolled: CapStyle }> = {};
    for (const d of descCaps) {
      const a = restDesc[d], b = scrolledDesc[d];
      if (!a || !b) continue;
      const keys = diffKeys(a, b);
      if (keys.length) descDeltas[d] = { rest: pick(a, keys), scrolled: pick(b, keys) };
    }
    if (!rootKeys.length && !Object.keys(descDeltas).length) continue; // this candidate doesn't morph

    // Binary-search the real threshold (assumes monotonic: scrolling further never reverts the
    // morph). Judged against whichever signal exists — prefer the root's own changed properties,
    // falling back to the first descendant delta when the root itself is visually static (only
    // its children re-color).
    const firstDescCap = Object.keys(descDeltas)[0];
    const isScrolledAt = async (y: number): Promise<boolean> => {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(600); // same settle budget as the reference reads, for a valid exact-match comparison
      if (rootKeys.length) {
        const r = await readProps(page, cap, ROOT_PROPS);
        if (!r) return false;
        return rootKeys.some((k) => r[k] === scrolledRoot[k] && r[k] !== restRoot[k]);
      }
      if (!firstDescCap) return false;
      const dr = await readProps(page, firstDescCap, DESC_PROPS);
      if (!dr) return false;
      const target = descDeltas[firstDescCap]!;
      return Object.keys(target.scrolled).some((k) => dr[k] === target.scrolled[k] && dr[k] !== target.rest[k]);
    };
    let lo = 0, hi = probeDepth;
    for (let i = 0; i < 8 && hi - lo > 2; i++) {
      const mid = Math.round((lo + hi) / 2);
      if (await isScrolledAt(mid)) hi = mid; else lo = mid;
    }

    specs.push({
      kind: "scroll",
      rootCap: cap,
      thresholdPx: hi,
      restStyle: pick(restRoot, rootKeys),
      scrolledStyle: pick(scrolledRoot, rootKeys),
      descendants: Object.keys(descDeltas).length ? descDeltas : undefined,
    });
    log({ event: "scroll_morph_captured", cap, thresholdPx: hi, rootProps: rootKeys.length, descendants: Object.keys(descDeltas).length });
  }
  await page.evaluate(() => window.scrollTo(0, 0)); // restore scroll=0 — later capture stages expect it
  return specs;
}
