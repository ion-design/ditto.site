import type { Page } from "playwright";
import type { StyleDelta } from "./interactions.js";

/**
 * Stage 4 — JS-driven hover capture. The pseudo-state driver (CSS.forcePseudoState)
 * exercises only CSS `:hover` RULES; a hover implemented in script — Webflow IX2
 * tweening an inline `transform` on mouseover, Framer Motion's `whileHover` issuing a
 * WAAPI animation on pointerenter — never fires under a forced pseudo-class, so those
 * states were silently lost (a play button that pops on the source page is inert in
 * the clone). Additionally the animated TARGET is often not the trigger and not even
 * inside its subtree (remento's laptop play circle is a SIBLING of the hover trigger),
 * so a trigger-scoped computed-style diff cannot see it either.
 *
 * This pass dispatches real pointer/mouse enter events on each candidate and observes
 * the page GLOBALLY: a MutationObserver over style/class attributes finds script-mutated
 * elements anywhere in the document, and a `document.getAnimations()` diff finds WAAPI
 * animations started by the hover. Captured values are DEFINITIONS, never mid-animation
 * frames: computed styles are polled until they stop changing (a tween's endpoint), and
 * WAAPI timing/keyframes are read from the animation's effect. Targets that never settle
 * (looping animations) are dropped. Everything is keyed by `data-cid-cap` for the
 * generator; replay is a fixed client controller (DittoHover) that applies the captured
 * end states on pointerenter/leave and touches NOTHING on mount, so the base render is
 * unperturbed.
 */

export type HoverJsTarget = {
  cap: string;          // data-cid-cap of the animated element (may be outside the trigger's subtree)
  on: StyleDelta;       // settled hover-state values (changed props only)
  off: StyleDelta;      // settled resting values for the same props
  durationMs: number | null; // from a WAAPI animation's timing definition (rounded), else null
  easing: string | null;     // from the same timing definition, else null
};

export type HoverJsTrigger = {
  triggerCap: string;   // data-cid-cap of the element whose hover starts the change
  targets: HoverJsTarget[];
};

/** Props a scripted hover realistically animates. Small on purpose: geometry props
 *  (width/margins) are layout-coupled and a scripted hover that changes them is rare
 *  enough that reproducing it risks more than it recovers. */
const HOVER_JS_PROPS = ["transform", "opacity", "backgroundColor", "color", "boxShadow", "filter", "visibility"] as const;

export async function captureJsHovers(page: Page, opts?: { maxCandidates?: number; log?: (e: Record<string, unknown>) => void }): Promise<HoverJsTrigger[]> {
  const log = opts?.log ?? (() => {});
  const maxCandidates = opts?.maxCandidates ?? 300;
  try {
    const res = await page.evaluate(async ({ maxN, props }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const capOf = (el: Element | null): string | null => el?.getAttribute?.("data-cid-cap") ?? null;
      const readVals = (el: Element): Record<string, string> => {
        const cs = getComputedStyle(el);
        const o: Record<string, string> = {};
        for (const p of props) o[p] = (cs as unknown as Record<string, string>)[p] ?? "";
        return o;
      };
      const joined = (el: Element): string => Object.values(readVals(el)).join("|");

      // Candidate pool: elements a user can plausibly hover with intent — native
      // interactives, ARIA buttons, builder-tagged nodes (Webflow data-w-id), anything
      // styled clickable, and elements with an animating transform transition (a hover
      // -pop target advertises itself that way even without cursor:pointer).
      const animatesTransform = (cs: CSSStyleDeclaration): boolean => {
        const tp = (cs.transitionProperty || "").toLowerCase();
        if (!/transform|all/.test(tp)) return false;
        return (cs.transitionDuration || "").split(",").some((d) => parseFloat(d) > 0);
      };
      const pool: Element[] = [];
      for (const el of Array.from(document.querySelectorAll("[data-cid-cap]"))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 12 || r.height < 12 || r.bottom < 0) continue;
        const tag = el.tagName;
        const interactive = tag === "A" || tag === "BUTTON" || el.getAttribute("role") === "button"
          || el.hasAttribute("data-w-id") || cs.cursor === "pointer" || animatesTransform(cs);
        if (!interactive) continue;
        pool.push(el);
        if (pool.length >= maxN) break;
      }

      // Global style/class mutation watcher — catches script-driven hover targets
      // ANYWHERE in the document (the animated node is often outside the trigger).
      const mutated = new Set<string>();
      const obs = new MutationObserver((records) => {
        for (const rec of records) {
          const cap = capOf(rec.target as Element);
          if (cap) mutated.add(cap);
        }
      });
      obs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });

      // WAAPI baseline: animations already running before any synthetic hover.
      const baseAnims = new Set<Animation>((document as Document).getAnimations ? document.getAnimations() : []);

      // Ambient-churn baseline: elements that mutate on their OWN (autoplaying sliders,
      // marquees, rotating text, cursor followers) — observed over a quiet window with
      // no synthetic events. Their mutations are animation phase, never hover reactions;
      // attributing them to whatever candidate happened to be hovered is both wrong (a
      // spurious controller) and nondeterministic (it depends on where the slider was in
      // its cycle). The window spans a typical autoplay period so periodic churn lands.
      await sleep(4500);
      const ambient = new Set<string>(mutated);
      mutated.clear();

      const fireEnter = (el: Element): void => {
        el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
        el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      };
      const fireLeave = (el: Element): void => {
        el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
        el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
        el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      };
      // Poll the targets' computed values until two consecutive reads agree (a tween's
      // endpoint — a DEFINITION of the state, never a mid-animation frame). Returns null
      // when the values never settle (looping animation → not a two-state hover).
      const settled = async (els: Element[]): Promise<Record<string, string>[] | null> => {
        let prev = els.map(joined).join("§");
        for (let i = 0; i < 10; i++) {
          await sleep(140);
          const cur = els.map(joined).join("§");
          if (cur === prev) return els.map(readVals);
          prev = cur;
        }
        return null;
      };

      const out: Array<{ triggerCap: string; targets: Array<{ cap: string; on: Record<string, string>; off: Record<string, string>; durationMs: number | null; easing: string | null }>; el: Element }> = [];
      for (const el of pool) {
        const triggerCap = capOf(el);
        if (!triggerCap) continue;
        // Quiet barrier: wait for NON-ambient churn to stop, so a previous candidate's
        // trailing leave-tween can't be attributed to this one. Ambient churn never
        // stops and is excluded from attribution anyway, so it is ignored here.
        for (let q = 0; q < 8; q++) {
          const dirty = [...mutated].some((c) => !ambient.has(c));
          mutated.clear();
          if (!dirty) break;
          await sleep(150);
        }
        fireEnter(el);
        await sleep(140); // detection window: scripted hovers respond immediately
        const newAnims = ((document as Document).getAnimations ? document.getAnimations() : [])
          .filter((a) => !baseAnims.has(a) && a.constructor.name !== "CSSAnimation" && a.constructor.name !== "CSSTransition");
        const animByCap = new Map<string, Animation>();
        for (const a of newAnims) {
          const t = (a.effect as KeyframeEffect | null)?.target as Element | undefined;
          const c = t ? capOf(t) : null;
          if (c && !ambient.has(c) && !animByCap.has(c)) animByCap.set(c, a);
        }
        const targetCaps = [...new Set([...[...mutated].filter((c) => !ambient.has(c)), ...animByCap.keys()])]
          .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
          .slice(0, 8);
        if (!targetCaps.length) { fireLeave(el); continue; }
        const targetEls = targetCaps
          .map((c) => document.querySelector(`[data-cid-cap="${c}"]`))
          .filter((e): e is Element => !!e);
        if (!targetEls.length) { fireLeave(el); continue; }
        const onVals = await settled(targetEls);
        fireLeave(el);
        const offVals = await settled(targetEls);
        if (!onVals || !offVals) { mutated.clear(); continue; } // never settled → looping animation, drop
        // Repeatability check: a genuine hover reaction reproduces on a second enter; a
        // coincidental ambient mutation (a slider rotating mid-probe) does not. Kills
        // the last class of phase-dependent false positives.
        fireEnter(el);
        const onVals2 = await settled(targetEls);
        fireLeave(el);
        await settled(targetEls);
        mutated.clear();
        if (!onVals2) continue;
        const targets: Array<{ cap: string; on: Record<string, string>; off: Record<string, string>; durationMs: number | null; easing: string | null }> = [];
        for (let i = 0; i < targetEls.length; i++) {
          const cap = capOf(targetEls[i]!);
          if (!cap) continue;
          const on: Record<string, string> = {};
          const off: Record<string, string> = {};
          for (const p of props) {
            const a = onVals[i]![p] ?? "", b = offVals[i]![p] ?? "";
            if (a !== b && onVals2[i]![p] === a) { on[p] = a; off[p] = b; } // must reproduce on re-enter
          }
          // WAAPI fill:none — the effect snapped back after finishing, so computed on/off
          // agree. Recover the end state from the animation's LAST KEYFRAME (a definition).
          const anim = animByCap.get(cap);
          if (!Object.keys(on).length && anim) {
            try {
              const kfs = (anim.effect as KeyframeEffect).getKeyframes() as Array<Record<string, string | number>>;
              const last = kfs[kfs.length - 1];
              if (last) for (const p of props) {
                const v = last[p];
                if (v !== undefined && String(v) !== (offVals[i]![p] ?? "")) { on[p] = String(v); off[p] = offVals[i]![p] ?? ""; }
              }
            } catch { /* unreadable effect — leave empty */ }
          }
          if (!Object.keys(on).length) continue;
          let durationMs: number | null = null;
          let easing: string | null = null;
          if (anim) {
            try {
              const t = (anim.effect as KeyframeEffect).getTiming();
              if (typeof t.duration === "number" && isFinite(t.duration)) durationMs = Math.round(t.duration);
              if (t.easing) easing = String(t.easing);
            } catch { /* no timing — defaults apply at replay */ }
          }
          targets.push({ cap, on, off, durationMs, easing });
        }
        if (targets.length) out.push({ triggerCap, targets, el });
      }
      obs.disconnect();

      // Nested-wrapper dedupe: a bubbling mouseover means a child candidate re-triggers
      // its ancestor's handler, recording the identical change twice. Keep the OUTERMOST
      // trigger (its hover region covers the child's).
      const key = (t: (typeof out)[number]): string => JSON.stringify(t.targets);
      const deduped = out.filter((t) => !out.some((o) => o !== t && o.el !== t.el && o.el.contains(t.el) && key(o) === key(t)));
      return deduped
        .map(({ triggerCap, targets }) => ({ triggerCap, targets }))
        .sort((a, b) => parseInt(a.triggerCap, 10) - parseInt(b.triggerCap, 10));
    }, { maxN: maxCandidates, props: HOVER_JS_PROPS as unknown as string[] });
    if (res.length) log({ event: "interactions_hover_js", triggers: res.length, targets: res.reduce((n, t) => n + t.targets.length, 0) });
    return res;
  } catch (e) {
    log({ event: "interactions_hover_js_error", error: String(e).slice(0, 150) });
    return [];
  }
}
