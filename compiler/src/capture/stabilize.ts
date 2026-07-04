import type { Page } from "playwright";

/**
 * Pre-snapshot stabilization (Stage 2). Two dynamic behaviors otherwise make the
 * per-viewport snapshots disagree with each other and with what a settled visitor sees:
 *
 *   - **Lazy-loader placeholders** (WP Rocket / lazysizes): the real URL lives in a data
 *     attribute while `src` holds a 0-size placeholder; `autoScroll` outruns their
 *     IntersectionObserver, so snapshots record collapsed sections — and the interaction
 *     pass can trigger the swap midway, leaving viewports INCONSISTENT (cropin's "Global
 *     presence" map: 0×0 at 375/768/1280, 898px at 1920). Promoting the data attrs to
 *     real ones ONCE, before any snapshot, makes every viewport measure the stable
 *     post-reveal size (validated against the live site).
 *   - **Autoplaying carousels** (Splide/Swiper-style transform tracks): each viewport
 *     snapshot freezes a DIFFERENT translateX offset which the generator bakes into
 *     per-band CSS (ooni's splide02: -375/0/-1280/-1920 across the four widths). Settling
 *     — autoplay paused, track at the home slide — before EVERY snapshot makes all
 *     viewports (including the post-interaction 1920 pass) see one canonical state.
 *
 * Scope guard for motion capture (motion.ts contract): carousel settling touches ONLY
 * elements matching the named-library selectors below, and pauses only the track's own
 * WAAPI/CSS animations. rAF-driven marquees (Framer Motion tickers) match none of these
 * selectors and keep running, so `detectMarquees` still observes their velocity; paused
 * WAAPI animations remain in `document.getAnimations()` with keyframes/timing intact.
 */

// ---- Lazy-media promotion (runs in the page) ----

/**
 * Promote lazy-loader data attributes to real ones and wait (bounded) for the newly-real
 * images to decode, so bboxes are measured loaded. Only values that look like URLs are
 * promoted (some themes stash JSON/flags in data-src-like attrs); an `src` already equal
 * to the target is left alone, so the pass is idempotent. Returns the number of elements
 * changed. Serialized into the page via page.evaluate — must stay self-contained.
 */
export async function promoteLazyMediaInPage(): Promise<number> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const urlish = (v: string | null | undefined): v is string => {
    if (!v) return false;
    const s = v.trim();
    if (!s || s.length > 4096 || /[<>"'\s]/.test(s)) return false;
    return /^(?:https?:)?\/\//i.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") ||
      /^data:image\//i.test(s) || /^[\w][^:]*\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(s);
  };
  const srcsetish = (v: string | null | undefined): v is string => {
    if (!v) return false;
    const first = v.split(",")[0]?.trim().split(/\s+/)[0];
    return urlish(first);
  };
  const setAttr = (el: Element, name: string, value: string): boolean => {
    if (el.getAttribute(name) === value) return false;
    el.setAttribute(name, value);
    return true;
  };
  const promotedImgs: HTMLImageElement[] = [];
  let count = 0;
  const SEL =
    "img[data-lazy-src],img[data-src],img[data-lazy-srcset],img[data-srcset],img[data-lazy-sizes],img[data-sizes]," +
    "source[data-lazy-srcset],source[data-srcset],iframe[data-lazy-src],iframe[data-src],[data-bg]";
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    let changed = false;
    const tag = el.tagName;
    if (tag === "IMG" || tag === "IFRAME") {
      const src = el.getAttribute("data-lazy-src") ?? el.getAttribute("data-src");
      if (urlish(src)) changed = setAttr(el, "src", src.trim()) || changed;
    }
    if (tag === "IMG" || tag === "SOURCE") {
      const srcset = el.getAttribute("data-lazy-srcset") ?? el.getAttribute("data-srcset");
      if (srcsetish(srcset)) changed = setAttr(el, "srcset", srcset.trim()) || changed;
      // lazysizes' `data-sizes="auto"` is a computed-at-swap flag, not a real sizes value.
      const sizes = (el.getAttribute("data-lazy-sizes") ?? el.getAttribute("data-sizes"))?.trim();
      if (sizes && sizes !== "auto") changed = setAttr(el, "sizes", sizes) || changed;
    }
    const bg = el.getAttribute("data-bg");
    if (bg) {
      // data-bg carries either a raw URL (lazysizes) or a full url(...) (WP Rocket).
      const inner = bg.trim().replace(/^url\(\s*(['"]?)(.*?)\1\s*\)$/i, "$2").trim();
      if (urlish(inner)) {
        const want = `url("${inner}")`;
        const st = (el as HTMLElement).style;
        if (st.backgroundImage !== want) { st.backgroundImage = want; changed = true; }
      }
    }
    if (changed) {
      count++;
      if (tag === "IMG") { el.setAttribute("loading", "eager"); promotedImgs.push(el as HTMLImageElement); }
    }
  }
  if (promotedImgs.length) {
    await Promise.race([
      Promise.all(promotedImgs.map((img) => (typeof img.decode === "function" ? img.decode() : Promise.resolve()).catch(() => { /* broken URL — bbox stays as-is */ }))),
      sleep(4000),
    ]);
  }
  return count;
}

/** Node-side wrapper: bounded + never fatal (a hung page just skips promotion). */
export async function promoteLazyMedia(page: Page): Promise<number> {
  try {
    return await Promise.race([
      page.evaluate(promoteLazyMediaInPage),
      new Promise<number>((res) => setTimeout(() => res(0), 8000)),
    ]);
  } catch {
    return 0;
  }
}

// ---- Scroll-reveal settling (runs in the page) ----

/** Fixed dwell per scroll step. Reveal libraries fire from IntersectionObserver callbacks
 *  or throttled scroll handlers (WOW ~100ms, AOS 99ms debounce); the plain autoScroll's
 *  60ms cadence outruns them, leaving reveal wrappers baked `visibility:hidden` in the
 *  snapshot. 400ms per step reliably clears every observed library. Deterministic constant. */
export const REVEAL_DWELL_MS = 400;
/** Bound the dwell walk for pathological/endless pages (~80 × 0.75 viewport ≈ 60 screens). */
export const REVEAL_MAX_STEPS = 80;
/** Bounded wait for FINITE entrance animations started by the walk to finish, so no
 *  viewport snapshot freezes a mid-fade frame (the ~5%-opacity ghost state). */
export const REVEAL_ANIMATION_WAIT_MS = 3000;

export type RevealSettleResult = { steps: number; animationsAwaited: number };

/**
 * Deterministic dwell-scroll so every one-shot scroll reveal (Elementor waypoints,
 * WOW/AOS class swaps, IntersectionObserver entrances) fires BEFORE any viewport
 * snapshot — the same class of one-shot load-state as lazy media, settled the same way
 * (once, before the viewport loop). Steps 0.75×viewport with a fixed dwell through the
 * full scrollHeight, waits for the entrance animations it started to complete (infinite
 * iterations excluded — they never finish by design), then restores scroll 0.
 * Serialized into the page via page.evaluate — must stay self-contained.
 */
export async function settleScrollRevealsInPage(cfg: { dwellMs: number; maxSteps: number; animWaitMs: number }): Promise<RevealSettleResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const step = Math.max(Math.round(window.innerHeight * 0.75), 200);
  const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
  let y = 0;
  let steps = 0;
  while (y < maxScroll() && steps < cfg.maxSteps) {
    y += step;
    window.scrollTo(0, y);
    await sleep(cfg.dwellMs);
    steps++;
  }
  let animationsAwaited = 0;
  try {
    const anims = (document.getAnimations?.() ?? []).filter((a) => {
      try {
        if (a.playState !== "running") return false;
        const t = (a.effect as KeyframeEffect | null)?.getTiming();
        return t != null && t.iterations !== Infinity;
      } catch { return false; }
    });
    animationsAwaited = anims.length;
    await Promise.race([
      Promise.allSettled(anims.map((a) => a.finished)),
      sleep(cfg.animWaitMs),
    ]);
  } catch { /* getAnimations unsupported — the fixed post-wait still applies */ }
  window.scrollTo(0, 0);
  await sleep(250); // fixed post-wait: let scroll-position-dependent styles re-settle at top
  return { steps, animationsAwaited };
}

/** Node-side wrapper: bounded + never fatal (a hung page just skips settling). */
export async function settleScrollReveals(page: Page): Promise<RevealSettleResult> {
  const empty: RevealSettleResult = { steps: 0, animationsAwaited: 0 };
  const cfg = { dwellMs: REVEAL_DWELL_MS, maxSteps: REVEAL_MAX_STEPS, animWaitMs: REVEAL_ANIMATION_WAIT_MS };
  const bound = cfg.maxSteps * cfg.dwellMs + cfg.animWaitMs + 8000;
  try {
    return await Promise.race([
      page.evaluate(settleScrollRevealsInPage, cfg),
      new Promise<RevealSettleResult>((res) => setTimeout(() => res(empty), bound)),
    ]);
  } catch {
    return empty;
  }
}

/**
 * Defensive follow-up to the dwell walk: elements STILL carrying a known pre-reveal
 * marker (far below fold past the step bound, or keyed to a non-scroll trigger) are
 * moved to the library's OWN revealed state — the classes the library would add/remove
 * — never raw style overrides, so the captured computed styles are the library's
 * genuine post-reveal values. Known-library allowlist only (same philosophy as the
 * carousel selectors below); elements hidden for real reasons are untouched.
 * Serialized into the page via page.evaluate — must stay self-contained.
 */
export function neutralizePreRevealInPage(): number {
  const stillHidden = (el: Element): boolean => {
    try {
      const cs = getComputedStyle(el);
      return cs.visibility === "hidden" || parseFloat(cs.opacity || "1") <= 0.05;
    } catch { return false; }
  };
  let n = 0;
  // Elementor waypoint reveals: `.elementor-invisible` is removed and `animated` + the
  // entrance-animation class (data-settings._animation / .animation) added on reveal.
  const elementorReveal = (el: Element): void => {
    let anim = "";
    try {
      const s = JSON.parse(el.getAttribute("data-settings") || "{}") as Record<string, unknown>;
      const v = s["_animation"] ?? s["animation"];
      if (typeof v === "string") anim = v.trim();
    } catch { /* malformed settings — reveal without the animation class */ }
    el.classList.remove("elementor-invisible");
    el.classList.add("animated");
    if (anim && anim !== "none") el.classList.add(anim);
  };
  for (const el of Array.from(document.querySelectorAll(".elementor-invisible"))) { elementorReveal(el); n++; }
  // Elementor variants where the invisible class was renamed but the entrance setting
  // remains: still-hidden elements whose data-settings configure an animation.
  for (const el of Array.from(document.querySelectorAll('[data-settings*="animation"]'))) {
    if (!stillHidden(el)) continue;
    elementorReveal(el);
    n++;
  }
  // WOW.js: init() sets inline visibility:hidden; reveal sets it visible + adds `animated`
  // (the keyframe class, e.g. fadeInUp, is already in the element's class list).
  for (const el of Array.from(document.querySelectorAll(".wow:not(.animated)")) as HTMLElement[]) {
    el.classList.add("animated");
    el.style.visibility = "visible";
    n++;
  }
  // AOS: [data-aos] elements are hidden by attribute selectors until `.aos-animate` lands.
  for (const el of Array.from(document.querySelectorAll("[data-aos]:not(.aos-animate)"))) {
    el.classList.add("aos-animate");
    n++;
  }
  return n;
}

/** Node-side wrapper: bounded + never fatal. */
export async function neutralizePreReveal(page: Page): Promise<number> {
  try {
    return await Promise.race([
      page.evaluate(neutralizePreRevealInPage),
      new Promise<number>((res) => setTimeout(() => res(0), 8000)),
    ]);
  } catch {
    return 0;
  }
}

/** Cancel scroll/view-timeline-driven CSS animations so the snapshot records the AT-REST
 *  (unscrolled) computed style rather than a frozen mid/end-timeline value.
 *
 *  A scroll-linked text-fill (e.g. `animation-timeline: view(); animation-fill-mode: both`)
 *  progresses with scroll position, not time. The dwell-scroll pass runs the page to the
 *  bottom, and `fill-mode: both` HOLDS the animation's end keyframe even after we restore
 *  scroll to 0 — because the element's view-timeline range has already been exited. The DOM
 *  walk then reads the FROZEN end value (e.g. `background-position: 100%`, fully filled),
 *  baking the end state into the clone when the live at-rest state is the start (0%).
 *
 *  Fix: before the snapshot, cancel every running CSS animation whose timeline is NOT the
 *  default (document) timeline — i.e. a ScrollTimeline / ViewTimeline, or (fallback) an
 *  animation whose resolved effect duration is not finite. Canceling drops the animation's
 *  fill so getComputedStyle reports the underlying (unanimated) property values.
 *
 *  Scoped to scroll/view timelines only: time-based entrance animations (reveals) use the
 *  default document timeline with a finite duration and are left untouched. */
export function neutralizeScrollTimelineAnimationsInPage(): number {
  let n = 0;
  try {
    const docTimeline = (document as unknown as { timeline?: unknown }).timeline;
    const anims = (document as unknown as { getAnimations?: () => Animation[] }).getAnimations?.() ?? [];
    for (const a of anims) {
      try {
        const tl = a.timeline as unknown;
        // Default (document) timeline → time-based; leave it. Anything else (scroll/view
        // timeline) or a null timeline with a non-finite effect duration → scroll-linked.
        const isDefaultTimeline = tl === docTimeline;
        const ctorName: string = (tl ? (tl as { constructor?: { name?: string } }).constructor?.name : "") || "";
        const isScrollLinked =
          !isDefaultTimeline && /Scroll|View/.test(ctorName);
        // Fallback: resolved effect duration is not a finite number (scroll-timeline
        // animations report `auto`/non-finite computed duration, e.g. `animation-duration:auto`).
        let nonFiniteDuration = false;
        try {
          const timing = (a.effect as unknown as { getComputedTiming?: () => { duration?: number | string } })?.getComputedTiming?.();
          const dur = timing?.duration;
          nonFiniteDuration = typeof dur === "number" ? !isFinite(dur) : dur === "auto";
        } catch { /* ignore */ }
        if (isScrollLinked || (!isDefaultTimeline && nonFiniteDuration)) {
          a.cancel();
          n++;
        }
      } catch { /* per-animation errors are non-fatal */ }
    }
  } catch { /* getAnimations unsupported — no-op */ }
  return n;
}

/** Node-side wrapper: bounded + never fatal. */
export async function neutralizeScrollTimelineAnimations(page: Page): Promise<number> {
  try {
    return await Promise.race([
      page.evaluate(neutralizeScrollTimelineAnimationsInPage),
      new Promise<number>((res) => setTimeout(() => res(0), 5000)),
    ]);
  } catch {
    return 0;
  }
}

// ---- Carousel settling (runs in the page) ----

export type CarouselSettleResult = { roots: number; normalized: number; neutralizedAnims: number };

/**
 * Deterministically settle recognizable library carousels: engage the library's own
 * pause path, neutralize any animation driving the track, and navigate to the REAL first
 * slide (home). Navigation preference:
 *   1. the exposed Swiper instance (`el.swiper`) — stop autoplay + slideTo(Loop)(0, 0);
 *   2. the first pagination bullet (libraries resolve loop-mode clones themselves);
 *   3. prev-arrow clicks back from the marked active slide's real index;
 *   4. inline `translateX(0)` — only for a non-loop track with no controls (loop mode
 *      prepends clones, so 0 is not home there; such a track is left paused as-is).
 * Autoplay pause is best-effort-deterministic: Swiper via its instance; Splide/Slick/Glide
 * pause on pointer-enter by default, so a synthetic mouseenter/mouseover latches them
 * (nothing dispatches the matching mouseleave). Ends with a bounded wait for every track
 * transform to stop changing so the caller snapshots a settled frame.
 */
export async function settleCarouselsInPage(): Promise<CarouselSettleResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ROOT_SEL = ".splide, .swiper, .swiper-container, .slick-slider, .glide";
  const TRACK_SEL = ".splide__list, .swiper-wrapper, .slick-track, .glide__slides";
  const BULLET_SEL = ".splide__pagination__bullet, .swiper-pagination-bullet, .slick-dots button, .glide__bullet";
  const PREV_SEL = ".splide__arrow--prev, .swiper-button-prev, .slick-prev, [data-glide-dir='<']";
  const ACTIVE_SEL = ".is-active, .swiper-slide-active, .slick-current, .glide__slide--active";
  const CLONE_SEL = ".splide__slide--clone, .swiper-slide-duplicate, .slick-cloned, .glide__slide--clone";
  const txOf = (el: Element): number => {
    try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch { return 0; }
  };

  const roots = Array.from(document.querySelectorAll(ROOT_SEL));
  const tracks: Element[] = [];
  let normalized = 0;
  let neutralizedAnims = 0;
  for (const root of roots) {
    const track = Array.from(root.querySelectorAll(TRACK_SEL)).find((t) => t.closest(ROOT_SEL) === root);
    if (!track) continue;
    tracks.push(track);
    // pause-on-hover latch (Splide/Slick default-on; Glide's hoverpause): synthetic
    // pointer-enter with no matching leave keeps autoplay paused for the snapshot.
    for (const t of [root, track.parentElement, track]) {
      if (!t) continue;
      try {
        t.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        t.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      } catch { /* ignore */ }
    }
    // Neutralize the track's OWN animations only (scoped so motion.ts's marquee/rotator
    // capture is untouched). CSS transitions/animations are CANCELED, not paused: pausing
    // a CSSTransition disassociates it from style and it then HOLDS its frozen mid-flight
    // transform, overriding the home navigation below (the declarative path reconstructs
    // CSS motion from the IR, so canceling loses nothing). Pure WAAPI is PAUSED so it
    // stays in getAnimations() with keyframes/timing intact for motion.ts to record.
    try {
      for (const a of (track as HTMLElement).getAnimations?.() ?? []) {
        try {
          const ctor = a.constructor.name;
          if (ctor === "CSSTransition" || ctor === "CSSAnimation") a.cancel(); else a.pause();
          neutralizedAnims++;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    let home = false;
    // 1) Swiper exposes its instance on the container.
    const sw = (root as { swiper?: { autoplay?: { stop?: () => void }; slideTo?: (i: number, ms?: number) => void; slideToLoop?: (i: number, ms?: number) => void } }).swiper;
    if (sw) {
      try { sw.autoplay?.stop?.(); } catch { /* ignore */ }
      try {
        if (sw.slideToLoop) { sw.slideToLoop(0, 0); home = true; }
        else if (sw.slideTo) { sw.slideTo(0, 0); home = true; }
      } catch { /* ignore */ }
    }
    // 2) First pagination bullet (clicked even if hidden at this width — a destroyed
    //    breakpoint variant just ignores the click).
    if (!home) {
      const bullet = Array.from(root.querySelectorAll(BULLET_SEL)).find((b) => b.closest(ROOT_SEL) === root) as HTMLElement | undefined;
      if (bullet) { try { bullet.click(); home = true; } catch { /* ignore */ } }
    }
    // 3) Step back from the marked active slide's real index with the prev arrow.
    if (!home) {
      const prev = Array.from(root.querySelectorAll(PREV_SEL)).find((b) => b.closest(ROOT_SEL) === root) as HTMLElement | undefined;
      const active = Array.from(track.children).find((s) => s.matches(ACTIVE_SEL));
      if (prev && active) {
        const real = Array.from(track.children).filter((s) => !s.matches(CLONE_SEL));
        const idx = real.indexOf(active);
        if (idx >= 0) {
          for (let k = 0; k < Math.min(idx, 30); k++) { try { prev.click(); } catch { break; } await sleep(90); }
          home = true;
        }
      }
    }
    // 4) No controls: pin translateX(0) — home for a non-loop track. Loop mode prepends
    //    clones (0 shows a clone), so a control-less loop track is left paused as-is.
    if (!home) {
      const isLoop = /--loop\b/.test(root.className) || track.querySelector(CLONE_SEL) != null;
      if (!isLoop && Math.abs(txOf(track)) > 0.5) {
        (track as HTMLElement).style.transform = "translateX(0px)";
        home = true;
      }
    }
    if (home) normalized++;
  }

  // Bounded wait for the navigation transitions to land (and confirm nothing is still
  // auto-advancing): every track transform stable for 3 consecutive samples.
  if (tracks.length) {
    let prevSig = tracks.map((t) => Math.round(txOf(t))).join(",");
    let stable = 0;
    for (let i = 0; i < 14 && stable < 3; i++) {
      await sleep(140);
      const sig = tracks.map((t) => Math.round(txOf(t))).join(",");
      if (sig === prevSig) stable++; else { stable = 0; prevSig = sig; }
    }
  }
  return { roots: tracks.length, normalized, neutralizedAnims };
}

/** Node-side wrapper: bounded + never fatal. */
export async function settleCarousels(page: Page): Promise<CarouselSettleResult> {
  const empty: CarouselSettleResult = { roots: 0, normalized: 0, neutralizedAnims: 0 };
  try {
    return await Promise.race([
      page.evaluate(settleCarouselsInPage),
      new Promise<CarouselSettleResult>((res) => setTimeout(() => res(empty), 10_000)),
    ]);
  } catch {
    return empty;
  }
}

// ---- Force-reveal for element screenshots (runs in the page) ----

/**
 * A visibility:hidden video (entrance animation not yet fired) passes the size gate but
 * `locator.screenshot` auto-waits for visibility and times out. Force the element and any
 * hidden ancestor visible for the shot, recording each prior inline value so
 * `restoreRevealForShot` puts everything back exactly. Returns how many were forced.
 */
export function forceRevealForShot(sel: string): number {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return 0;
  let n = 0;
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (getComputedStyle(cur).visibility !== "hidden") continue;
    const prev = cur.style.getPropertyValue("visibility");
    const prio = cur.style.getPropertyPriority("visibility");
    cur.setAttribute("data-clone-vis-restore", `${prio}|${prev}`);
    cur.style.setProperty("visibility", "visible", "important");
    n++;
  }
  return n;
}

/** Undo forceRevealForShot exactly (inline value + priority, or absence). */
export function restoreRevealForShot(): void {
  for (const el of Array.from(document.querySelectorAll("[data-clone-vis-restore]")) as HTMLElement[]) {
    const raw = el.getAttribute("data-clone-vis-restore") ?? "|";
    el.removeAttribute("data-clone-vis-restore");
    const i = raw.indexOf("|");
    const prio = raw.slice(0, i);
    const prev = raw.slice(i + 1);
    if (prev) el.style.setProperty("visibility", prev, prio);
    else el.style.removeProperty("visibility");
  }
}
