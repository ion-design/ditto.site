/** Deterministic capture-environment shim (Stage 0, runs before ANY page script).
 *
 *  Two entropy sources make a page render differently on each load — Math.random
 *  (shuffled carousels, random ids, A/B jitter) and the wall clock ("posted N
 *  minutes ago", schedule/countdown logic). Seeding the first and pinning the
 *  second makes a capture reproducible: the same site captured under the same
 *  {seed, epoch} paints the same DOM.
 *
 *  CAUTIONS (all honored below):
 *   - performance.now() is left REAL. Motion capture (marquee/rotator sampling in
 *     capture/motion.ts) measures real velocities and observation windows off it;
 *     pinning it would corrupt those measurements. Only the Date wall clock moves.
 *   - The Date epoch is a PARAMETER, recorded in capture metadata — a recapture
 *     uses a fresh-but-recorded value. Generation determinism only requires a
 *     frozen capture to produce byte-stable output, which is unaffected by which
 *     epoch was chosen (the epoch is frozen into the capture, not re-derived).
 *   - The clock still ADVANCES from the pinned epoch (via the real-clock delta),
 *     so elapsed-time logic (setTimeout-driven reveals, animation timing that
 *     reads Date, lazy-load debounces) behaves — only the absolute origin is
 *     pinned, not the passage of time.
 *   - Date is patched consistently across constructor / Date.now() / getTime() /
 *     valueOf() / Symbol.toPrimitive by shifting the underlying instant for BOTH
 *     the no-arg constructor and Date.now(); every instance method then reads the
 *     shifted instant through the native prototype, so cookie-banner / schedule
 *     gates that call getTime()/valueOf() see the same pinned clock as now().
 */

/** Default fixed epoch: 2026-01-01T00:00:00.000Z. Callers should pass an explicit,
 *  recorded epoch (see captureEpochMs); this is only the fallback. */
export const DEFAULT_CAPTURE_EPOCH_MS = 1767225600000;

/** Default PRNG seed (mulberry32 initial state). A non-zero constant so the first
 *  draw is well-mixed; recorded alongside the epoch for reproducibility. */
export const DEFAULT_PRNG_SEED = 0x9e3779b9;

/** Resolve the epoch a capture run should pin to. Env override lets a recapture
 *  reuse a recorded value; otherwise a fresh timestamp is taken at run start and
 *  recorded in metadata. Determinism of GENERATION does not depend on this value —
 *  only on the capture being frozen once chosen. */
export function captureEpochMs(override?: number | string): number {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  if (typeof override === "string" && override.trim()) {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return parsed;
    const asDate = Date.parse(override);
    if (Number.isFinite(asDate)) return asDate;
  }
  return DEFAULT_CAPTURE_EPOCH_MS;
}

/**
 * Build the init-script SOURCE STRING injected via page.addInitScript before any
 * page script runs. Returned as a raw string (not a function) so tsx/esbuild never
 * transforms it — the browser receives exactly these bytes.
 *
 * Interpolation is numeric-only (Number.isFinite-guarded), so no string escaping /
 * injection surface exists.
 */
export function buildDeterministicEnvShim(opts?: { seed?: number; epochMs?: number }): string {
  const seed = Number.isFinite(opts?.seed) ? Math.trunc(opts!.seed!) : DEFAULT_PRNG_SEED;
  const epoch = Number.isFinite(opts?.epochMs) ? Math.trunc(opts!.epochMs!) : DEFAULT_CAPTURE_EPOCH_MS;
  // NOTE: `delta` is computed once at shim-eval time (the earliest possible moment,
  // before page scripts) so the pinned origin is stable; the real clock then adds
  // elapsed time on top, keeping relative time truthful.
  return `(() => {
  "use strict";
  // ---- Seeded PRNG (mulberry32): deterministic, well-distributed, cheap ----
  let __s = ${seed} | 0;
  const __rand = function random() {
    __s = (__s + 0x6d2b79f5) | 0;
    let t = Math.imul(__s ^ (__s >>> 15), 1 | __s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { Object.defineProperty(Math, "random", { value: __rand, writable: true, configurable: true }); }
  catch (e) { try { Math.random = __rand; } catch (e2) {} }

  // ---- Pinned-but-advancing wall clock. performance.now() stays REAL. ----
  const RealDate = Date;
  const realNow = () => RealDate.now();
  // Shift so the FIRST observed instant is the pinned epoch; real elapsed time is
  // then added on top (delta is negative if the machine clock is ahead of epoch).
  const delta = ${epoch} - realNow();
  const shiftedNow = () => realNow() + delta;
  function DittoDate(...args) {
    // \`new Date()\` with no args => pinned clock; every other form is delegated to
    // the native constructor unchanged (parsing a string, y/m/d, a millis value).
    const inst = args.length === 0 ? new RealDate(shiftedNow()) : new RealDate(...args);
    // Re-tag the prototype so instanceof + inherited getTime/valueOf/toISOString work.
    Object.setPrototypeOf(inst, DittoDate.prototype);
    return inst;
  }
  // Inherit the full native Date prototype (getTime, valueOf, getFullYear,
  // toISOString, Symbol.toPrimitive, ...) so every read is consistent with now().
  DittoDate.prototype = Object.create(RealDate.prototype);
  DittoDate.prototype.constructor = DittoDate;
  DittoDate.now = shiftedNow;
  DittoDate.parse = RealDate.parse;
  DittoDate.UTC = RealDate.UTC;
  try { Object.defineProperty(globalThis, "Date", { value: DittoDate, writable: true, configurable: true }); }
  catch (e) { try { globalThis.Date = DittoDate; } catch (e2) {} }
})();`;
}
