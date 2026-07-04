import type { Page } from "playwright";
import { captureLotties, type LottieSpec } from "./lottie.js";

/**
 * Stage 5 motion capture. Runs at the canonical viewport AFTER `tagElements` (so every
 * element carries a `data-cid-cap` the IR threads through to a cid). Two families that
 * the declarative CSS path (per-node `animation-name` + captured `@keyframes`, handled
 * entirely in the IR/generator) does NOT cover:
 *
 *   - **WAAPI** (`element.animate(...)`, e.g. Framer Motion): only ever visible via
 *     `document.getAnimations()`. Captured here as keyframes + timing so a fixed client
 *     controller can replay it. (Entrance WAAPI that already finished by capture time is
 *     not observable — persistent/looping WAAPI is; that's the deterministic subset.)
 *   - **Rotating text**: a JS interval swapping an element's text (shopify "category
 *     creator → global empire", notion "Ship → Create"). Observed with a MutationObserver
 *     over a short window; captured as the text cycle + cadence for a fixed controller.
 *
 * CSS @keyframes/transition motion is intentionally NOT re-captured here — it is fully
 * reconstructable from the static evidence already in the IR, which is the most
 * deterministic path.
 */

export type WaapiAnim = {
  cap: string; // data-cid-cap of the animated element (→ cid at generation)
  keyframes: Array<Record<string, string | number>>; // effect.getKeyframes()
  duration: number; // ms
  delay: number; // ms
  easing: string;
  iterations: number; // -1 encodes Infinity (JSON-safe)
  direction: string;
  fill: string;
};

export type RotatorSpec = {
  cap: string; // data-cid-cap of the element whose text cycles
  texts: string[]; // the observed cycle of trimmed text values (in order)
  intervalMs: number; // approximate cadence between swaps
};

export type RevealSpec = {
  cap: string; // data-cid-cap of a scroll-revealed element
  opacity: string; // its hidden (pre-reveal) opacity, e.g. "0"
  transform: string; // its hidden transform (slide/scale offset), or "none"
  transition: string; // the transition to animate the reveal with ("" for the visibility family)
  // visibility+entrance-class family (Elementor/WOW/AOS): hidden via `visibility:hidden`
  // pre-scroll, revealed by a class swap that applies a keyframe animation. The clone
  // re-hides with visibility (JS-applied, so non-JS/SSR still shows content) and replays
  // the named animation when scrolled into view.
  visibility?: "hidden";
  animationName?: string; // entrance @keyframes name in the revealed state (e.g. fadeInUp)
  animationDuration?: string; // e.g. "1.25s"
  animationDelay?: string; // e.g. "0s"
  animationTiming?: string; // e.g. "ease" / "cubic-bezier(...)"
};

export type MarqueeSpec = {
  cap: string; // data-cid-cap of the continuously-translating track
  axis: "x"; // horizontal marquee (the common case; vertical reserved)
  pxPerSec: number; // signed scroll velocity (negative = leftward)
  periodPx: number; // distance per seamless loop (one duplicated copy ≈ scrollWidth/2)
};

// ---- Pure marquee discriminators (extracted so the in-browser sampling logic is unit
// testable). These are duplicated verbatim inside `detectMarquees`' page.evaluate body —
// module-scope functions do NOT cross the serialization boundary — so any change here must
// be mirrored there (and vice versa). They are deterministic: no randomness, no clock reads.

/**
 * Median signed velocity (px/s) from a series of per-sample translateX deltas taken at a
 * fixed cadence. Median (not mean) ignores the single per-loop wrap-reset outlier, which
 * is a large jump opposite the travel direction when the track seamlessly restarts.
 */
export function medianVelocityPxPerSec(deltas: number[], sampleMs: number): number {
  if (!deltas.length || sampleMs <= 0) return 0;
  const med = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]!;
  return Math.round((med / sampleMs) * 1000);
}

/**
 * Discriminator 2 — sustained-constant-velocity test. A real marquee holds a steady
 * velocity across time; a scroll-settle lerp (still easing toward its scroll-target after
 * `scrollIntoView`) decays, so its velocity in a later observation window is a small
 * fraction of the earlier one. Two windows of per-sample deltas separated by ≥1.5s; pass
 * only if the later window's speed is BOTH non-trivial AND close to the earlier window's
 * (within a relative tolerance) — i.e. it did not decay and did not reverse.
 *
 * @param window1Deltas per-sample translateX deltas from the first observation window
 * @param window2Deltas per-sample translateX deltas from the second (later) window
 * @param sampleMs cadence between samples within a window
 * @param minPxPerSec minimum sustained |velocity| to be considered moving at all
 * @param relTol fractional tolerance: |v2| must be ≥ (1-relTol)·|v1| and same sign
 */
export function classifyVelocitySamples(
  window1Deltas: number[],
  window2Deltas: number[],
  sampleMs: number,
  minPxPerSec = 4,
  relTol = 0.5,
): { isMarquee: boolean; pxPerSec: number; v1: number; v2: number } {
  const v1 = medianVelocityPxPerSec(window1Deltas, sampleMs);
  const v2 = medianVelocityPxPerSec(window2Deltas, sampleMs);
  // The reported velocity is the first window's (measured closest to a clean, post-settle
  // marquee; also what the old code reported), kept for output determinism vs. the old path.
  const pxPerSec = v1;
  if (Math.abs(v1) < minPxPerSec || Math.abs(v2) < minPxPerSec) return { isMarquee: false, pxPerSec, v1, v2 };
  if (Math.sign(v1) !== Math.sign(v2)) return { isMarquee: false, pxPerSec, v1, v2 }; // reversed → not a steady ticker
  // v2 must NOT have decayed relative to v1 (a lerp settling toward target loses speed).
  const sustained = Math.abs(v2) >= Math.abs(v1) * (1 - relTol);
  return { isMarquee: sustained, pxPerSec, v1, v2 };
}

/**
 * Discriminator 4 — genuine duplicated content. A marquee duplicates its content ≥2×
 * (that is how a seamless loop works); "≥2 children" alone is far too weak (any flex row
 * of distinct logos passes). Require actual repetition: ≥2 CONSECUTIVE children whose
 * shape repeats — equal outerHTML hash (exact duplicate) or, as a looser structural
 * fallback, an equal consecutive width sequence (some marquees clone then tweak attributes
 * so hashes differ but the geometry repeats).
 *
 * @param hashes per-child outerHTML hash (cheap 32-bit), index-aligned with `widths`
 * @param widths per-child rounded offsetWidth
 */
export function hasRepeatedChildren(hashes: number[], widths: number[]): boolean {
  const n = Math.min(hashes.length, widths.length);
  if (n < 2) return false;
  // (a) two consecutive children with an identical hash — a literal cloned copy.
  for (let i = 1; i < n; i++) if (hashes[i] === hashes[i - 1] && hashes[i] !== 0) return true;
  // (b) structural fallback: the first half's width sequence repeats in the second half
  // (content duplicated as a block, e.g. [A B C A B C]). Require an even count and a real
  // width so a row of zero-width nodes can't spuriously "repeat".
  if (n >= 4 && n % 2 === 0) {
    const half = n / 2;
    let repeats = true;
    for (let i = 0; i < half; i++) { if (widths[i] === 0 || widths[i] !== widths[i + half]) { repeats = false; break; } }
    if (repeats) return true;
  }
  return false;
}

export type MotionCapture = {
  waapi: WaapiAnim[];
  rotators: RotatorSpec[];
  reveals: RevealSpec[]; // scroll-triggered entrance reveals (start hidden, reveal on view)
  marquees: MarqueeSpec[]; // rAF-driven continuous tickers (Framer Motion etc.) — not in getAnimations()
  lotties: LottieSpec[]; // lottie-web JSON animations (third-party JS the CSS/WAAPI paths can't reproduce)
  lottieInline: Record<string, unknown>; // animationData only available in-memory, keyed by LottieSpec.inlineKey
  cssAnimated: number; // elements with a computed animation-name (informational)
};

/**
 * Stage 5 (scroll reveals) — pre-scroll probe. Scroll-triggered reveals start hidden and
 * animate in when scrolled into view; by the time the settled snapshot is taken (after
 * the reveal-settling pass has walked the page) they are already revealed, so their
 * hidden state must be sampled BEFORE the first scroll. Records, on `window.__cloneReveal`,
 * two candidate families over tagged elements — the set `captureMotion` later confirms
 * (kept only if the element ends up visible):
 *   - **transition** — opacity≈0 with a real opacity/transform transition (the reveal
 *     animates via the transition already on the element);
 *   - **visibility** — `visibility:hidden` with a real box (Elementor `.elementor-invisible`,
 *     WOW/AOS wrappers), revealed by a class swap that APPLIES a keyframe animation. The
 *     entrance animation only exists post-swap, so `captureMotion` reads it at confirm
 *     time from the revealed computed style. Only the OUTERMOST hidden element is recorded
 *     (visibility inherits — descendants are covered by the wrapper's reveal).
 * Idempotent; call once at the canonical width, after settle, before the first scroll.
 */
export async function probeReveals(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const out: Record<string, { opacity: string; transform: string; transition: string; family?: "visibility" }> = {};
      for (const el of Array.from(document.querySelectorAll("[data-cid-cap]"))) {
        const cap = el.getAttribute("data-cid-cap"); if (!cap) continue;
        let cs: CSSStyleDeclaration; try { cs = getComputedStyle(el); } catch { continue; }
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue; // must occupy real space (not a 0-box hidden node)
        if (cs.visibility === "hidden") {
          // visibility family: record only the reveal ROOT (parent not also hidden).
          const p = (el as HTMLElement).parentElement;
          let parentHidden = false;
          try { parentHidden = !!p && getComputedStyle(p).visibility === "hidden"; } catch { /* ignore */ }
          if (parentHidden) continue;
          out[cap] = { opacity: cs.opacity || "1", transform: "none", transition: "", family: "visibility" };
          continue;
        }
        const op = parseFloat(cs.opacity || "1");
        if (op > 0.05) continue; // only currently-hidden elements are reveal candidates
        // must have a transition on opacity/transform/all (so the reveal animates, not snaps)
        const tp = (cs.transitionProperty || "").toLowerCase();
        const td = cs.transitionDuration || "0s";
        const animates = /opacity|transform|all/.test(tp) && !/^0s(,\s*0s)*$/.test(td);
        if (!animates) continue;
        out[cap] = {
          opacity: cs.opacity || "0",
          transform: cs.transform && cs.transform !== "none" ? cs.transform : "none",
          transition: cs.transition && cs.transition !== "all 0s ease 0s" ? cs.transition : `opacity ${td}, transform ${td}`,
        };
      }
      (window as unknown as { __cloneReveal?: unknown }).__cloneReveal = out;
    });
  } catch { /* ignore */ }
}

/**
 * Stage 5 (marquees) — rAF-driven continuous tickers. Framer Motion (and similar)
 * drive infinite horizontal scrollers by mutating an element's `transform` every frame
 * via requestAnimationFrame, so they are invisible to `getAnimations()` (the WAAPI path)
 * and have no CSS `@keyframes` (the declarative path). They are also paused while
 * off-screen, so the velocity is only observable after scrolling the track into view.
 * Detect a track by a translateX that changes steadily in one direction once visible,
 * and record its signed velocity + seamless-loop period (one duplicated copy ≈ half the
 * scroll width) so the clone can replay the loop. Read-only beyond scrolling (restores
 * scroll to top); does not touch the captured snapshot/IR.
 *
 * Discriminators (ALL must pass — a candidate is only classified as a marquee if every one
 * holds), added to defeat scroll-LINKED easing false positives (a static logo row on a
 * scroll-eased page is still lerping toward its scroll-target right after `scrollIntoView`,
 * which reads as a constant velocity over a single short window):
 *   1. Content overflow — scrollWidth > 1.35·clientWidth (a marquee has content to scroll;
 *      a static row that fits its box, scrollWidth ≈ clientWidth, cannot be a marquee).
 *   2. Sustained constant velocity — two observation windows separated by ≥1.5s; a settle
 *      lerp decays (v2 ≪ v1), a real marquee holds v2 ≈ v1 (see classifyVelocitySamples).
 *   3. Scroll independence (jiggle) — nudge scroll by ±50px and re-sample; if the velocity
 *      responds to the nudge the motion is scroll-linked, not a self-driven ticker.
 *   4. Genuine duplication — ≥2 consecutive children repeat (equal outerHTML hash or an
 *      equal consecutive width sequence), the shape real marquees use for a seamless loop.
 *
 * Added latency is bounded: the expensive per-candidate windows/jiggle run ONLY for the
 * few candidates that already pass the cheap synchronous gates (overflow + translated +
 * clip + duplication), and the candidate list is capped at 8. Per surviving candidate the
 * async cost is ≈ 300ms settle + 2×~600ms windows + ~1.4s inter-window gap + 2×~250ms
 * jiggle ≈ 3.4s; with the cap the whole pass is bounded regardless of page size.
 */
async function detectMarquees(page: Page): Promise<MarqueeSpec[]> {
  try {
    return await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const txOf = (el: Element): number => { try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch { return 0; } };
      const inClip = (el: Element): boolean => {
        let p = el.parentElement, depth = 0;
        while (p && depth < 6) { const ox = getComputedStyle(p).overflowX; if (ox === "hidden" || ox === "clip") return true; p = p.parentElement; depth++; }
        return false;
      };
      // cheap 32-bit string hash (djb2-ish) — deterministic, for the duplication test.
      const hashStr = (s: string): number => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };

      // ---- Pure discriminators (mirror of the exported module-scope functions; kept inline
      // because module scope does not cross the page.evaluate serialization boundary). ----
      const medianVelocityPxPerSec = (deltas: number[], sampleMs: number): number => {
        if (!deltas.length || sampleMs <= 0) return 0;
        const med = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]!;
        return Math.round((med / sampleMs) * 1000);
      };
      const classifyVelocitySamples = (w1: number[], w2: number[], sampleMs: number, minPxPerSec = 4, relTol = 0.5) => {
        const v1 = medianVelocityPxPerSec(w1, sampleMs);
        const v2 = medianVelocityPxPerSec(w2, sampleMs);
        const pxPerSec = v1;
        if (Math.abs(v1) < minPxPerSec || Math.abs(v2) < minPxPerSec) return { isMarquee: false, pxPerSec, v1, v2 };
        if (Math.sign(v1) !== Math.sign(v2)) return { isMarquee: false, pxPerSec, v1, v2 };
        const sustained = Math.abs(v2) >= Math.abs(v1) * (1 - relTol);
        return { isMarquee: sustained, pxPerSec, v1, v2 };
      };
      const hasRepeatedChildren = (hashes: number[], widths: number[]): boolean => {
        const n = Math.min(hashes.length, widths.length);
        if (n < 2) return false;
        for (let i = 1; i < n; i++) if (hashes[i] === hashes[i - 1] && hashes[i] !== 0) return true;
        if (n >= 4 && n % 2 === 0) {
          const half = n / 2;
          let repeats = true;
          for (let i = 0; i < half; i++) { if (widths[i] === 0 || widths[i] !== widths[i + half]) { repeats = false; break; } }
          if (repeats) return true;
        }
        return false;
      };
      // sample per-child outerHTML hash + width for the duplication test.
      const childSignature = (el: Element): { hashes: number[]; widths: number[] } => {
        const hashes: number[] = [], widths: number[] = [];
        const kids = Array.from(el.children).slice(0, 24) as HTMLElement[];
        for (const k of kids) { hashes.push(hashStr(k.outerHTML)); widths.push(Math.round(k.getBoundingClientRect().width)); }
        return { hashes, widths };
      };
      // one observation window: `count` deltas at `sampleMs` cadence.
      const sampleWindow = async (el: Element, count: number, sampleMs: number): Promise<number[]> => {
        const xs: number[] = [txOf(el)];
        for (let i = 0; i < count; i++) { await sleep(sampleMs); xs.push(txOf(el)); }
        const dxs: number[] = []; for (let i = 1; i < xs.length; i++) dxs.push(xs[i]! - xs[i - 1]!);
        return dxs;
      };

      const SAMPLE_MS = 120;
      const WINDOW_SAMPLES = 5;            // 5 deltas ≈ 600ms per window
      const INTER_WINDOW_MS = 1500;        // ≥1.5s between windows (discriminator 2)
      const JIGGLE_PX = 50;                // scroll nudge for the independence test (discriminator 3)

      // Candidates: tagged, already translated (paused tickers keep their offset), with
      // GENUINE duplicated content inside an overflow-clip viewport, AND real content
      // overflow (scrollWidth > 1.35·clientWidth) — the marquee shape. All cheap/synchronous
      // so the expensive async windows only run for the few survivors.
      const cand: Element[] = [];
      for (const el of Array.from(document.querySelectorAll("[data-cid-cap]"))) {
        if (Math.abs(txOf(el)) <= 0.5) continue;
        if (el.children.length < 2) continue;
        if (!inClip(el)) continue;
        // Discriminator 1: content overflow. scrollWidth must meaningfully exceed clientWidth;
        // a static row that fits (scrollWidth ≈ clientWidth) has nothing to scroll.
        if (el.scrollWidth <= el.clientWidth * 1.35) continue;
        // Discriminator 4: genuine repetition, not merely ≥2 distinct children.
        const sig = childSignature(el);
        if (!hasRepeatedChildren(sig.hashes, sig.widths)) continue;
        cand.push(el);
        if (cand.length >= 8) break;
      }
      const out: Array<{ cap: string; axis: "x"; pxPerSec: number; periodPx: number }> = [];
      const seen = new Set<string>();
      for (const el of cand) {
        const cap = el.getAttribute("data-cid-cap"); if (!cap || seen.has(cap)) continue;
        try { el.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
        await sleep(300); // wake the off-screen-paused ticker + let the scroll settle

        // Discriminator 2: two velocity windows ≥1.5s apart. A scroll-settle lerp decays;
        // a real marquee holds constant velocity.
        const w1 = await sampleWindow(el, WINDOW_SAMPLES, SAMPLE_MS);
        await sleep(INTER_WINDOW_MS);
        const w2 = await sampleWindow(el, WINDOW_SAMPLES, SAMPLE_MS);
        if (w1.length < 3 || w2.length < 3) continue;
        // direction must be consistent within window 1, but for (at most) the one wrap step.
        const med1 = [...w1].sort((a, b) => a - b)[Math.floor(w1.length / 2)]!;
        if (w1.filter((d) => Math.sign(d) === Math.sign(med1)).length < w1.length - 1) continue;
        const cls = classifyVelocitySamples(w1, w2, SAMPLE_MS);
        if (!cls.isMarquee) continue;
        const pxPerSec = cls.pxPerSec;

        // Discriminator 3: scroll independence (jiggle). Nudge the scroll ±50px and re-sample
        // velocity; a self-driven ticker is unaffected, a scroll-linked animation changes.
        const baseY = window.scrollY;
        const jiggle = async (dy: number): Promise<number> => {
          try { window.scrollTo(0, Math.max(0, baseY + dy)); } catch { /* ignore */ }
          await sleep(250); // let any scroll-linked easing react and settle at the new offset
          const dxs = await sampleWindow(el, WINDOW_SAMPLES, SAMPLE_MS);
          return medianVelocityPxPerSec(dxs, SAMPLE_MS);
        };
        const vDown = await jiggle(JIGGLE_PX);
        const vUp = await jiggle(-JIGGLE_PX);
        try { window.scrollTo(0, baseY); } catch { /* ignore */ }
        // Scroll-linked motion responds to the nudge (velocity reverses, dies, or spikes as
        // it re-lerps to the new target). A real marquee holds ~pxPerSec through both nudges.
        const stableUnderJiggle = (v: number): boolean =>
          Math.sign(v) === Math.sign(pxPerSec) && Math.abs(v) >= Math.abs(pxPerSec) * 0.5 && Math.abs(v) <= Math.abs(pxPerSec) * 2;
        if (!stableUnderJiggle(vDown) || !stableUnderJiggle(vUp)) continue;

        const periodPx = Math.round(el.scrollWidth / 2);
        if (periodPx < 40) continue;
        seen.add(cap);
        out.push({ cap, axis: "x", pxPerSec, periodPx });
      }
      try { window.scrollTo(0, 0); } catch { /* ignore */ }
      return out;
    });
  } catch { return []; }
}

/**
 * Stage 5 (scroll-scrub reveals) — scroll-LINKED entrance animations. Some sections
 * (framer's "Agents" sticky-pinned panels) drive opacity/transform as a continuous
 * function of scroll position rather than a one-way IntersectionObserver reveal, so they
 * start only PARTIALLY hidden (opacity ~0.2, a translate offset) and `probeReveals`
 * (which requires opacity ≤ 0.05 pre-scroll) never sees them — and the settled snapshot
 * catches them frozen MID-scrub (opacity 0.63), which the clone then bakes as a dimmed,
 * offset panel. Detect them by sampling each panel's opacity/transform across a full
 * scroll pass: a panel that is dimmed/slid at some scroll position but reaches full
 * opacity at another is a scroll reveal. Reconstruct as a normal reveal (hide at the
 * most-dimmed state, transition to full on view) — the deterministic, gate-reconciled
 * path (the validator force-reveals before grading, so gates measure the revealed frame).
 */
async function detectScrubReveals(page: Page): Promise<RevealSpec[]> {
  try {
    return await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const txOf = (cs: CSSStyleDeclaration): number => { try { return new DOMMatrixReadOnly(cs.transform).m41; } catch { return 0; } };
      // Panel-like candidates: tagged, sized, content-bearing, in normal flow.
      const cands: HTMLElement[] = [];
      for (const el of Array.from(document.querySelectorAll("[data-cid-cap]")) as HTMLElement[]) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) continue;
        const pos = getComputedStyle(el).position;
        if (pos === "fixed" || pos === "sticky") continue;
        if (!el.querySelector("img, p, h1, h2, h3, span")) continue; // has real content
        cands.push(el);
        if (cands.length >= 1200) break;
      }
      const samples = new Map<HTMLElement, Array<{ op: number; tx: number }>>();
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        window.scrollTo(0, Math.round((maxY * i) / steps));
        await sleep(120);
        for (const el of cands) {
          const cs = getComputedStyle(el);
          let a = samples.get(el); if (!a) { a = []; samples.set(el, a); }
          a.push({ op: parseFloat(cs.opacity || "1"), tx: txOf(cs) });
        }
      }
      window.scrollTo(0, 0);
      const found: Array<{ el: HTMLElement; cap: string; opacity: string; transform: string; transition: string }> = [];
      for (const [el, a] of samples) {
        const ops = a.map((s) => s.op), absTx = a.map((s) => Math.abs(s.tx));
        const maxOp = Math.max(...ops), minOp = Math.min(...ops);
        const maxTx = Math.max(...absTx), minTx = Math.min(...absTx);
        const opReveal = maxOp > 0.9 && minOp < 0.85;   // fades in across scroll
        const txReveal = maxOp > 0.9 && maxTx > 6 && minTx < 2; // slides in across scroll
        if (!opReveal && !txReveal) continue;
        // hidden = the most-dimmed sample (lowest opacity, tie-break largest offset).
        let hidden = a[0]!;
        for (const s of a) if (s.op < hidden.op - 0.001 || (Math.abs(s.op - hidden.op) <= 0.001 && Math.abs(s.tx) > Math.abs(hidden.tx))) hidden = s;
        const cap = el.getAttribute("data-cid-cap"); if (!cap) continue;
        found.push({
          el, cap,
          opacity: String(Math.max(0, Math.min(hidden.op, 0.5))),
          transform: Math.abs(hidden.tx) > 2 ? `translateX(${Math.round(hidden.tx)}px)` : "none",
          transition: "opacity 0.6s ease, transform 0.6s ease",
        });
      }
      // Keep only the OUTERMOST scrub per nesting (a panel and its scrubbed children both match).
      const outer = found.filter((f) => !found.some((o) => o !== f && o.el.contains(f.el)));
      return outer.slice(0, 40).map(({ cap, opacity, transform, transition }) => ({ cap, opacity, transform, transition }));
    });
  } catch { return []; }
}

export async function captureMotion(page: Page, opts?: { observeMs?: number; log?: (e: Record<string, unknown>) => void }): Promise<MotionCapture> {
  const log = opts?.log ?? (() => {});
  const observeMs = opts?.observeMs ?? 2600;
  try {
    const result = await Promise.race([
      page.evaluate(async (budget: number) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // ---- WAAPI: pure script-driven animations (exclude CSS animations/transitions,
        // which the declarative path reproduces). Capture persistent/looping ones — the
        // deterministic subset still alive at capture time. ----
        const waapi: Array<{
          cap: string; keyframes: Array<Record<string, string | number>>;
          duration: number; delay: number; easing: string; iterations: number; direction: string; fill: string;
        }> = [];
        try {
          const anims = (document as Document).getAnimations ? document.getAnimations() : [];
          const seen = new Set<string>();
          for (const a of anims) {
            const ctor = a.constructor.name;
            if (ctor === "CSSAnimation" || ctor === "CSSTransition") continue; // declarative path owns these
            const eff = a.effect as KeyframeEffect | null;
            const target = eff?.target as Element | undefined;
            const cap = target?.getAttribute?.("data-cid-cap");
            if (!cap || seen.has(cap)) continue;
            let kfs: Array<Record<string, string | number>> = [];
            try { kfs = (eff!.getKeyframes() as unknown as Array<Record<string, string | number>>); } catch { kfs = []; }
            if (!kfs.length) continue;
            const t = eff!.getTiming();
            const iters = t.iterations === Infinity ? -1 : (typeof t.iterations === "number" ? t.iterations : 1);
            seen.add(cap);
            waapi.push({
              cap,
              keyframes: kfs,
              duration: typeof t.duration === "number" ? t.duration : 0,
              delay: t.delay ?? 0,
              easing: String(t.easing ?? "linear"),
              iterations: iters,
              direction: String(t.direction ?? "normal"),
              fill: String(t.fill ?? "none"),
            });
          }
        } catch { /* ignore */ }

        // ---- Rotating text: watch for elements whose text content cycles. Record the
        // smallest text-bearing element that changes (so we cycle the word, not a whole
        // section), the ordered set of values it shows, and the cadence. ----
        const changes = new Map<string, { texts: string[]; times: number[] }>();
        const norm = (s: string) => s.replace(/\s+/g, " ").trim();
        const obs = new MutationObserver((records) => {
          for (const rec of records) {
            // climb to the nearest element with a data-cid-cap
            let el: Node | null = rec.target;
            while (el && !(el as Element).getAttribute?.("data-cid-cap")) el = el.parentNode;
            const cap = el && (el as Element).getAttribute?.("data-cid-cap");
            if (!cap) continue;
            const elem = el as Element;
            // only track small text-bearing elements (a rotating word/phrase, not a big block).
            // Reject ANY element child, capped or not: rows injected at runtime (after cid-cap
            // tagging, so uncapped) would otherwise defeat a capped-only check and let a
            // multi-element panel pass as a "leaf word".
            if (elem.firstElementChild) continue; // has element children → not a leaf word
            const txt = norm(elem.textContent || "");
            if (!txt || txt.length > 80) continue;
            const e = changes.get(cap) ?? { texts: [], times: [] };
            if (e.texts[e.texts.length - 1] !== txt) { e.texts.push(txt); e.times.push(performance.now()); }
            changes.set(cap, e);
          }
        });
        obs.observe(document.body, { subtree: true, childList: true, characterData: true });
        await sleep(budget);
        obs.disconnect();

        const rotators: Array<{ cap: string; texts: string[]; intervalMs: number }> = [];
        for (const [cap, e] of changes) {
          // a genuine rotator shows ≥2 distinct values
          const distinct = Array.from(new Set(e.texts));
          if (distinct.length < 2) continue;
          let interval = 0;
          if (e.times.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < e.times.length; i++) gaps.push(e.times[i]! - e.times[i - 1]!);
            gaps.sort((a, b) => a - b);
            interval = Math.round(gaps[Math.floor(gaps.length / 2)]!);
          }
          rotators.push({ cap, texts: distinct.slice(0, 12), intervalMs: interval || 2000 });
        }

        // ---- Scroll reveals: confirm the pre-scroll candidates (probeReveals) that are
        // NOW visible — those genuinely revealed on scroll (vs. elements that stayed hidden).
        const reveals: Array<{
          cap: string; opacity: string; transform: string; transition: string;
          visibility?: "hidden"; animationName?: string; animationDuration?: string; animationDelay?: string; animationTiming?: string;
        }> = [];
        try {
          const probed = (window as unknown as { __cloneReveal?: Record<string, { opacity: string; transform: string; transition: string; family?: "visibility" }> }).__cloneReveal || {};
          // First value of a comma-joined animation longhand; timing functions carry inner
          // commas (cubic-bezier/steps), so take the whole leading function when present.
          const first = (v: string): string => (/^\s*(cubic-bezier\([^)]*\)|steps\([^)]*\)|[^,]+)/.exec(v || "")?.[1] ?? "").trim();
          for (const cap of Object.keys(probed)) {
            const el = document.querySelector(`[data-cid-cap="${cap}"]`);
            if (!el) continue;
            const cs = getComputedStyle(el);
            const p = probed[cap]!;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            if (p.family === "visibility") {
              if (cs.visibility === "hidden") continue; // never revealed → genuinely hidden content
              // Revealed via class swap. The swap's entrance animation is now in the computed
              // style (libraries keep the animated class); record it for replay.
              const name = first(cs.animationName || "none");
              reveals.push({
                cap, opacity: p.opacity, transform: "none", transition: "",
                visibility: "hidden",
                ...(name && name !== "none" ? {
                  animationName: name,
                  animationDuration: first(cs.animationDuration) || "1s",
                  animationDelay: first(cs.animationDelay) || "0s",
                  animationTiming: first(cs.animationTimingFunction) || "ease",
                } : {}),
              });
              continue;
            }
            if (parseFloat(cs.opacity || "1") <= 0.05) continue; // still hidden → not a reveal, just hidden
            reveals.push({ cap, opacity: p.opacity, transform: p.transform, transition: p.transition });
          }
        } catch { /* ignore */ }

        let cssAnimated = 0;
        for (const el of Array.from(document.querySelectorAll("*"))) {
          try { const an = getComputedStyle(el).animationName; if (an && an !== "none") cssAnimated++; } catch { /* ignore */ }
        }

        return { waapi, rotators, reveals, cssAnimated };
      }, observeMs),
      new Promise<Omit<MotionCapture, "marquees" | "lotties" | "lottieInline">>((res) => setTimeout(() => res({ waapi: [], rotators: [], reveals: [], cssAnimated: 0 }), observeMs + 4000)),
    ]);
    // Scroll-scrub reveals: scroll-linked panels probeReveals can't see (they start only
    // partially hidden). Merge into reveals, preferring the probe-confirmed entry when a cap
    // appears in both.
    const scrubReveals = await detectScrubReveals(page);
    const reveals = [...result.reveals];
    const haveCap = new Set(reveals.map((r) => r.cap));
    for (const s of scrubReveals) if (!haveCap.has(s.cap)) { reveals.push(s); haveCap.add(s.cap); }
    // Marquees run as a separate pass (scrolls each track into view to wake the paused
    // rAF ticker; kept after the rotator MutationObserver window so it can't add false text rotators).
    const marquees = await detectMarquees(page);
    // Lottie: third-party JSON animations, captured separately (registry + static markup scan).
    const lottie = await captureLotties(page, { log });
    log({ event: "motion_captured", waapi: result.waapi.length, rotators: result.rotators.length, reveals: reveals.length, marquees: marquees.length, lotties: lottie.lotties.length, cssAnimated: result.cssAnimated });
    return { ...result, reveals, marquees, lotties: lottie.lotties, lottieInline: lottie.inline };
  } catch (e) {
    log({ event: "motion_error", error: String(e).slice(0, 200) });
    return { waapi: [], rotators: [], reveals: [], marquees: [], lotties: [], lottieInline: {}, cssAnimated: 0 };
  }
}
