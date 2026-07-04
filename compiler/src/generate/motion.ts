import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { MotionCapture, WaapiAnim, RotatorSpec, RevealSpec, MarqueeSpec } from "../capture/motion.js";

/**
 * Stage 5 motion controller. CSS @keyframes motion is reproduced declaratively in
 * ditto.css (the animation plays on load with no JS). The two families that the
 * stylesheet can't express are reproduced by one fixed `'use client'` component,
 * `DittoMotion`, parameterized by captured specs:
 *   - **WAAPI** — re-issues `element.animate(keyframes, timing)` on the cid'd node.
 *   - **rotating text** — cycles the captured text values on an interval.
 *
 * Unlike DittoWire (which applies nothing on mount to keep the base frame untouched),
 * DittoMotion DOES start motion on mount — the clone is meant to REPLAY motion on load.
 * The validator measures the settled base by cancelling Web Animations and calling
 * `window.__dittoMotionStop()` (which DittoMotion installs) to restore rotator text, so
 * gates 0–6 still grade the static frame. The motion gate drives it un-frozen to verify.
 */

export type RTWaapi = { cid: string; keyframes: Array<Record<string, string | number>>; duration: number; delay: number; easing: string; iterations: number; direction: string; fill: string };
export type RTRotator = { cid: string; texts: string[]; intervalMs: number };
export type RTReveal = { cid: string; opacity: string; transform: string; transition: string };
export type RTMarquee = { cid: string; pxPerSec: number; periodPx: number };
export type MotionSpec = { waapi: RTWaapi[]; rotators: RTRotator[]; reveals: RTReveal[]; marquees: RTMarquee[] };

/** Map every IR node's capture-id → cid (the rendered identity). */
function capToCid(ir: IR): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) m.set(cap, n.id);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return m;
}

/** Resolve cap-keyed motion specs to cids that survived into this IR (optionally
 *  scoped by an include filter, for multi-route body/chrome splitting). Specs whose
 *  element was pruned are dropped (left static). */
export function buildMotionSpec(ir: IR, motion: MotionCapture | undefined, include?: (cid: string) => boolean): MotionSpec {
  if (!motion) return { waapi: [], rotators: [], reveals: [], marquees: [] };
  const map = capToCid(ir);
  const ok = (cid: string | undefined): cid is string => !!cid && (!include || include(cid));
  const waapi: RTWaapi[] = [];
  for (const w of motion.waapi as WaapiAnim[]) {
    const cid = map.get(w.cap);
    if (!ok(cid)) continue;
    waapi.push({ cid, keyframes: w.keyframes, duration: w.duration, delay: w.delay, easing: w.easing, iterations: w.iterations, direction: w.direction, fill: w.fill });
  }
  const rotators: RTRotator[] = [];
  for (const r of motion.rotators as RotatorSpec[]) {
    const cid = map.get(r.cap);
    if (!ok(cid)) continue;
    rotators.push({ cid, texts: r.texts, intervalMs: r.intervalMs });
  }
  const reveals: RTReveal[] = [];
  for (const rv of (motion.reveals ?? []) as RevealSpec[]) {
    const cid = map.get(rv.cap);
    if (!ok(cid)) continue;
    reveals.push({ cid, opacity: rv.opacity, transform: rv.transform, transition: rv.transition });
  }
  const marquees: RTMarquee[] = [];
  for (const m of (motion.marquees ?? []) as MarqueeSpec[]) {
    const cid = map.get(m.cap);
    if (!ok(cid)) continue;
    marquees.push({ cid, pxPerSec: m.pxPerSec, periodPx: m.periodPx });
  }
  return { waapi, rotators, reveals, marquees };
}

export function motionHasContent(spec: MotionSpec): boolean {
  return spec.waapi.length > 0 || spec.rotators.length > 0 || spec.reveals.length > 0 || spec.marquees.length > 0;
}

/** Relative import path from a route page at the given app-segment depth to the shared
 *  DittoMotion (single page / entry route: depth 0 → "./ditto/DittoMotion"). */
export function dittoMotionImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/DittoMotion";
}

/** JSX for the motion controller, rendered at the end of a page fragment. "" when empty. */
export function motionWireJsx(spec: MotionSpec, indent: number): string {
  if (!motionHasContent(spec)) return "";
  const pad = "  ".repeat(indent);
  return `${pad}<DittoMotion spec={${JSON.stringify(spec)}} />`;
}

/** The fixed DittoMotion client component, written once per generated app. */
export const DITTO_MOTION_TSX = `"use client";
import { useEffect } from "react";

type RTWaapi = { cid: string; keyframes: Array<Record<string, string | number>>; duration: number; delay: number; easing: string; iterations: number; direction: string; fill: string };
type RTRotator = { cid: string; texts: string[]; intervalMs: number };
type RTReveal = { cid: string; opacity: string; transform: string; transition: string };
type RTMarquee = { cid: string; pxPerSec: number; periodPx: number };
export type MotionSpec = { waapi: RTWaapi[]; rotators: RTRotator[]; reveals: RTReveal[]; marquees: RTMarquee[] };

const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');

/** Replays captured motion the stylesheet can't express: WAAPI animations (re-issued via
 *  element.animate), rotating text (interval-cycled), and scroll-triggered reveals (start
 *  hidden, transition in when scrolled into view). Starts on mount. Installs
 *  window.__dittoMotionStop, and honors window.__dittoMotionStopped, so the validator can
 *  restore the fully-settled/revealed base for grading — gates 0–6 measure the static frame.
 *  The stopped FLAG (set by the validator even before this mounts) makes a late mount skip
 *  applying any motion, closing the hydration race that could otherwise leave content hidden. */
export default function DittoMotion({ spec }: { spec: MotionSpec }) {
  useEffect(() => {
    if ((window as any).__dittoMotionStopped) return; // measurement mode — apply nothing
    const intervals: ReturnType<typeof setInterval>[] = [];
    const rotators: Array<{ el: HTMLElement; original: string | null }> = [];
    const anims: Animation[] = [];
    const revealed: Array<() => void> = []; // per-reveal "show now" fns (also the cleanup)
    let io: IntersectionObserver | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    for (const w of spec.waapi) {
      const el = byCid(w.cid);
      if (!el) continue;
      try {
        anims.push(el.animate(w.keyframes, {
          duration: w.duration || 0, delay: w.delay || 0, easing: w.easing || "linear",
          iterations: w.iterations < 0 ? Infinity : (w.iterations || 1),
          direction: (w.direction as PlaybackDirection) || "normal", fill: (w.fill as FillMode) || "none",
        }));
      } catch { /* unsupported keyframe shape — leave static */ }
    }

    // Marquees: rAF-driven continuous tickers, reconstructed as an infinite linear translateX
    // loop over one duplicated copy (periodPx). Leftward (pxPerSec<0): 0 -> -period; rightward:
    // -period -> 0. Cancelled by stopAll so the graded frame shows the element's base transform.
    for (const m of spec.marquees) {
      const el = byCid(m.cid);
      if (!el || !m.periodPx || !m.pxPerSec) continue;
      const left = m.pxPerSec < 0;
      const a = "translateX(0px)", z = "translateX(-" + m.periodPx + "px)";
      const durationMs = Math.max(1000, Math.round((m.periodPx / Math.abs(m.pxPerSec)) * 1000));
      try {
        anims.push(el.animate([{ transform: left ? a : z }, { transform: left ? z : a }], {
          duration: durationMs, iterations: Infinity, easing: "linear",
        }));
      } catch { /* leave static */ }
    }

    for (const r of spec.rotators) {
      const el = byCid(r.cid);
      if (!el || r.texts.length < 2) continue;
      const original = el.textContent;
      const start = r.texts.findIndex((t) => t === (original || "").replace(/\\s+/g, " ").trim());
      let i = start < 0 ? 0 : start;
      rotators.push({ el, original });
      intervals.push(setInterval(() => { i = (i + 1) % r.texts.length; el.textContent = r.texts[i]!; }, Math.max(400, r.intervalMs)));
    }

    // Scroll reveals: hide each element (opacity/transform) with the captured transition,
    // then reveal (clear the inline overrides → transitions to the base CSS) when it scrolls
    // into view. A force-reveal timer guarantees nothing stays hidden if the observer misses.
    if (spec.reveals.length) {
      // Reveal to the full resting state. Setting 1/none (not clearing to base) is correct for
      // every reveal — the revealed state is always full + un-offset — and is REQUIRED for
      // scroll-scrub panels whose captured base CSS is a frozen mid-scrub value (opacity 0.63).
      const show = (el: HTMLElement) => { el.style.opacity = "1"; el.style.transform = "none"; };
      const byEl = new Map<Element, HTMLElement>();
      for (const rv of spec.reveals) {
        const el = byCid(rv.cid);
        if (!el) continue;
        el.style.transition = rv.transition;
        el.style.opacity = rv.opacity;
        if (rv.transform !== "none") el.style.transform = rv.transform;
        byEl.set(el, el);
        revealed.push(() => show(el));
      }
      io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { const el = byEl.get(e.target); if (el) { show(el); io!.unobserve(e.target); } }
      }, { rootMargin: "0px 0px -8% 0px" });
      for (const el of byEl.keys()) io.observe(el);
      forceTimer = setTimeout(() => { for (const f of revealed) f(); }, 4000);
    }

    const stopAll = () => {
      (window as any).__dittoMotionStopped = true;
      for (const id of intervals) clearInterval(id);
      for (const r of rotators) r.el.textContent = r.original;
      for (const a of anims) { try { a.cancel(); } catch { /* ignore */ } }
      if (io) io.disconnect();
      if (forceTimer) clearTimeout(forceTimer);
      for (const f of revealed) f(); // reveal everything → base CSS settled frame
    };
    // Measurement hook: restore the fully-settled/revealed base for grading.
    (window as any).__dittoMotionStop = stopAll;
    return () => {
      for (const id of intervals) clearInterval(id);
      if (io) io.disconnect();
      if (forceTimer) clearTimeout(forceTimer);
      try { delete (window as any).__dittoMotionStop; } catch { /* ignore */ }
    };
  }, [spec]);
  return null;
}
`;
