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
      // Candidates: tagged, already translated (paused tickers keep their offset), with
      // duplicated content (≥2 children) inside an overflow-clip viewport — the marquee shape.
      const cand: Element[] = [];
      for (const el of Array.from(document.querySelectorAll("[data-cid-cap]"))) {
        if (Math.abs(txOf(el)) <= 0.5) continue;
        if (el.children.length < 2) continue;
        if (!inClip(el)) continue;
        cand.push(el);
        if (cand.length >= 16) break;
      }
      const out: Array<{ cap: string; axis: "x"; pxPerSec: number; periodPx: number }> = [];
      const seen = new Set<string>();
      for (const el of cand) {
        const cap = el.getAttribute("data-cid-cap"); if (!cap || seen.has(cap)) continue;
        try { el.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
        await sleep(450); // wake the off-screen-paused ticker + let the scroll settle
        const xs: number[] = [];
        for (let i = 0; i < 6; i++) { xs.push(txOf(el)); await sleep(120); }
        const dxs: number[] = []; for (let i = 1; i < xs.length; i++) dxs.push(xs[i]! - xs[i - 1]!);
        if (dxs.length < 3) continue;
        // velocity = median per-120ms delta (median ignores the single wrap-reset outlier).
        const med = [...dxs].sort((a, b) => a - b)[Math.floor(dxs.length / 2)]!;
        const pxPerSec = Math.round((med / 120) * 1000);
        if (Math.abs(pxPerSec) < 4) continue; // not actually moving (e.g. a frozen scroll-scrub offset)
        // direction must be consistent in all but (at most) the one wrap step.
        if (dxs.filter((d) => Math.sign(d) === Math.sign(med)).length < dxs.length - 1) continue;
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
            // only track small text-bearing elements (a rotating word/phrase, not a big block)
            if (elem.querySelector("[data-cid-cap]")) continue; // has element children → not a leaf word
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
