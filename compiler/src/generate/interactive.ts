import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { InteractionCapture, CapStyle, RelBox } from "../capture/interactions.js";

/**
 * Stage 4 (M2) — recognized interactive patterns (tabs / accordion) are reproduced
 * by a single fixed `'use client'` controller, `DittoWire`, parameterized by captured
 * per-state styles. The page renders the captured subtree statically (so the base
 * DOM/style/perceptual gates are unaffected); DittoWire renders `null` and, after
 * hydration, finds the trigger/panel elements by `data-cid` and toggles the captured
 * inline styles on interaction. Its initial application reproduces the captured base
 * state exactly, so it never perturbs the default render — only adds behavior.
 */

type RTTab = { trigger: string; panel: string; triggerOn: CapStyle; triggerOff: CapStyle; panelShown: CapStyle; panelHidden: CapStyle; descendants?: Record<string, CapStyle> };
type RTAcc = { trigger: string; region: string; expanded: boolean; triggerOn: CapStyle; triggerOff: CapStyle; regionShown: CapStyle; regionHidden: CapStyle };
type RTDisc = { trigger: string; panel: string; isDialog: boolean; hoverOpen: boolean; backdropClose: boolean; closes: string[]; triggerOn: CapStyle; triggerOff: CapStyle; panelShown: CapStyle; panelHidden: CapStyle; shownBox: RelBox | null; descendants?: Record<string, CapStyle> };
export type RuntimeSpec =
  | { kind: "tabs"; active: number; tabs: RTTab[] }
  | { kind: "accordion"; items: RTAcc[] }
  | { kind: "carousel"; track: string; next: string | null; prev: string | null; bullets: string[]; base: number; transforms: string[]; bulletOn: CapStyle; bulletOff: CapStyle }
  | { kind: "disclosure"; items: RTDisc[] };
export type AccordionRuntimeSpec = Extract<RuntimeSpec, { kind: "accordion" }>;

export const INTERACTION_REJECTION_VERSION = 2;

export type InteractionRejectedArtifact = {
  version: number;
  rejected: string[];
};

export function interactionRejectedArtifact(rejected: string[]): InteractionRejectedArtifact {
  return { version: INTERACTION_REJECTION_VERSION, rejected };
}

export function interactionRejectedSet(raw: unknown): Set<string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const artifact = raw as Partial<InteractionRejectedArtifact>;
  if (artifact.version !== INTERACTION_REJECTION_VERSION || !Array.isArray(artifact.rejected)) return undefined;
  return new Set(artifact.rejected.filter((x): x is string => typeof x === "string" && x.length > 0));
}

/** Map every IR node's capture-id → its cid. */
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

/**
 * Build the cid-keyed runtime specs for the patterns whose nodes all survived into
 * this IR (and pass the optional include filter, for multi-route body scoping). A
 * pattern missing any of its trigger/panel cids is dropped (falls back to static).
 */
/** Stable identity for a runtime spec (its primary trigger/track cid). The gate marks
 *  patterns that don't reproduce by this key; generation then skips them (left static).
 *  Both sides operate on the same cid-specs, so the keys line up. */
export function specKey(s: RuntimeSpec): string {
  if (s.kind === "tabs") return "t:" + s.tabs[0]?.trigger;
  if (s.kind === "accordion") return "a:" + s.items[0]?.trigger;
  if (s.kind === "carousel") return "c:" + s.track;
  return "d:" + s.items[0]?.trigger;
}

export function buildRuntimeSpecs(ir: IR, interaction: InteractionCapture | undefined, include?: (cid: string) => boolean, rejected?: Set<string>): RuntimeSpec[] {
  if (!interaction?.patterns?.length) return [];
  const map = capToCid(ir);
  const ok = (cid: string | undefined): cid is string => !!cid && (!include || include(cid));
  // Remap a panel's open-state descendant overrides from capture-ids to surviving cids.
  // Descendants that didn't survive into this IR are simply dropped (best-effort reveal).
  const mapDesc = (d?: Record<string, CapStyle>): Record<string, CapStyle> | undefined => {
    if (!d) return undefined;
    const out: Record<string, CapStyle> = {};
    for (const cap of Object.keys(d)) { const cid = map.get(cap); if (ok(cid)) out[cid] = d[cap]!; }
    return Object.keys(out).length ? out : undefined;
  };
  const specs: RuntimeSpec[] = [];
  for (const p of interaction.patterns) {
    if (p.kind === "tabs") {
      const tabs: RTTab[] = [];
      let bad = false;
      for (const t of p.tabs) {
        const tr = map.get(t.triggerCap), pa = map.get(t.panelCap);
        if (!ok(tr) || !ok(pa)) { bad = true; break; }
        tabs.push({ trigger: tr, panel: pa, triggerOn: t.triggerOn, triggerOff: t.triggerOff, panelShown: t.panelShown, panelHidden: t.panelHidden, descendants: mapDesc(t.descendants) });
      }
      if (!bad && tabs.length >= 2) specs.push({ kind: "tabs", active: Math.min(p.activeIndex, tabs.length - 1), tabs });
    } else if (p.kind === "accordion") {
      const items: RTAcc[] = [];
      for (const it of p.items) {
        const tr = map.get(it.triggerCap), rg = map.get(it.regionCap);
        if (!ok(tr) || !ok(rg)) continue;
        items.push({ trigger: tr, region: rg, expanded: it.expandedAtBase, triggerOn: it.triggerOn, triggerOff: it.triggerOff, regionShown: it.regionShown, regionHidden: it.regionHidden });
      }
      if (items.length) specs.push({ kind: "accordion", items });
    } else if (p.kind === "carousel") {
      const track = map.get(p.trackCap);
      if (!ok(track)) continue;
      const next = p.nextCap ? map.get(p.nextCap) ?? null : null;
      const prev = p.prevCap ? map.get(p.prevCap) ?? null : null;
      // Pagination bullets are only usable if ALL survived (index-aligned with the
      // transforms); otherwise fall back to prev/next navigation.
      const mapped = p.bulletCaps.map((c) => map.get(c));
      const bullets = mapped.every((b) => ok(b)) ? (mapped as string[]) : [];
      if (!next && bullets.length < 2) continue;
      if (p.transforms.length < 2) continue;
      specs.push({ kind: "carousel", track, next, prev, bullets, base: p.baseIndex, transforms: p.transforms, bulletOn: p.bulletOn, bulletOff: p.bulletOff });
    } else if (p.kind === "disclosure") {
      const items: RTDisc[] = [];
      for (const it of p.items) {
        const trigger = map.get(it.triggerCap), panel = map.get(it.panelCap);
        if (!ok(trigger) || !ok(panel)) continue;
        const closes = it.closeCaps.map((c) => map.get(c)).filter((c): c is string => ok(c));
        items.push({ trigger, panel, isDialog: it.isDialog, hoverOpen: it.hoverOpen, backdropClose: it.backdropClose, closes, triggerOn: it.triggerOn, triggerOff: it.triggerOff, panelShown: it.panelShown, panelHidden: it.panelHidden, shownBox: it.shownBox, descendants: mapDesc(it.descendants) });
      }
      if (items.length) specs.push({ kind: "disclosure", items });
    }
  }
  // Drop patterns the interaction gate proved don't reproduce in the clone (they're
  // left static rather than shipped broken).
  return rejected && rejected.size ? specs.filter((s) => !rejected.has(specKey(s))) : specs;
}

/** Relative import path from a route page at the given app-segment depth to the
 *  shared DittoWire (single page / entry route: depth 0 → "./ditto/DittoWire"). */
export function dittoWireImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/DittoWire";
}

/** JSX for the pattern controllers, rendered at the end of a page fragment. Returns
 *  "" when there are no recognized patterns (no import/scaffold needed). */
export function wiresJsx(specs: RuntimeSpec[], indent: number): string {
  if (!specs.length) return "";
  const pad = "  ".repeat(indent);
  return specs.map((s) => `${pad}<DittoWire spec={${JSON.stringify(s)}} />`).join("\n");
}

export function accordionImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/Accordion";
}

export function accordionJsx(specs: AccordionRuntimeSpec[], indent: number): string {
  if (!specs.length) return "";
  const pad = "  ".repeat(indent);
  return `${pad}<Accordion specs={${JSON.stringify(specs)}} />`;
}

export const ACCORDION_TSX = `"use client";
import { useEffect } from "react";

type CapStyle = Record<string, string>;
type RTAcc = { trigger: string; region: string; expanded: boolean; triggerOn: CapStyle; triggerOff: CapStyle; regionShown: CapStyle; regionHidden: CapStyle };
export type AccordionSpec = { kind: "accordion"; items: RTAcc[] };

const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');
function applyStyle(el: HTMLElement | null, s: CapStyle) {
  if (!el) return;
  for (const k in s) el.style.setProperty(kebab(k), s[k]);
}

/** Wires captured accordion rows with small explicit state.
 *  Hydration initializes the captured base state, then clicks toggle only the target row. */
export default function Accordion({ specs }: { specs: AccordionSpec[] }) {
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    for (const spec of specs) {
      const state = spec.items.map((it) => it.expanded);
      const renderItem = (i: number) => {
        const it = spec.items[i];
        if (!it) return;
        const on = state[i];
        const trig = byCid(it.trigger), region = byCid(it.region);
        applyStyle(trig, on ? it.triggerOn : it.triggerOff);
        trig?.setAttribute("aria-expanded", on ? "true" : "false");
        applyStyle(region, on ? it.regionShown : it.regionHidden);
        if (region) {
          if (on) region.removeAttribute("hidden");
          else region.setAttribute("hidden", "");
        }
      };
      spec.items.forEach((it, i) => {
        const trig = byCid(it.trigger);
        if (!trig) return;
        trig.addEventListener("click", (e) => {
          e.preventDefault();
          state[i] = !state[i];
          renderItem(i);
        }, { signal });
        renderItem(i);
      });
    }
    return () => ac.abort();
  }, [specs]);
  return null;
}
`;

/** The fixed DittoWire client component, written once per generated app. */
export const DITTO_WIRE_TSX = `"use client";
import { useEffect } from "react";

type CapStyle = Record<string, string>;
type RTTab = { trigger: string; panel: string; triggerOn: CapStyle; triggerOff: CapStyle; panelShown: CapStyle; panelHidden: CapStyle; descendants?: Record<string, CapStyle> };
type RTAcc = { trigger: string; region: string; expanded: boolean; triggerOn: CapStyle; triggerOff: CapStyle; regionShown: CapStyle; regionHidden: CapStyle };
type RTDisc = { trigger: string; panel: string; isDialog: boolean; hoverOpen: boolean; backdropClose: boolean; closes: string[]; triggerOn: CapStyle; triggerOff: CapStyle; panelShown: CapStyle; panelHidden: CapStyle; shownBox?: unknown; descendants?: Record<string, CapStyle> };
export type Spec =
  | { kind: "tabs"; active: number; tabs: RTTab[] }
  | { kind: "accordion"; items: RTAcc[] }
  | { kind: "carousel"; track: string; next: string | null; prev: string | null; bullets: string[]; base: number; transforms: string[]; bulletOn: CapStyle; bulletOff: CapStyle }
  | { kind: "disclosure"; items: RTDisc[] };

const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');
function applyStyle(el: HTMLElement | null, s: CapStyle) {
  if (!el) return;
  for (const k in s) el.style.setProperty(kebab(k), s[k]);
}
// Apply a panel's open-state descendant overrides (cid → style). Reveals content whose
// visibility is gated by a JS-toggled class the clone doesn't carry (e.g. Elementor
// e-active). Applied only when the panel is shown; the panel's own hide masks it.
function applyDesc(d?: Record<string, CapStyle>) {
  if (!d) return;
  for (const cid in d) applyStyle(byCid(cid), d[cid]);
}

/** Reproduces a captured interactive pattern by toggling captured inline styles on
 *  the existing DOM nodes (found by data-cid). Renders nothing, and applies NOTHING
 *  on mount: the server-rendered markup + per-node CSS already reproduce the captured
 *  base state exactly, so state styles are applied only on user interaction. */
export default function DittoWire({ spec }: { spec: Spec }) {
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    if (spec.kind === "tabs") {
      let active = spec.active;
      const render = () => spec.tabs.forEach((t, i) => {
        const on = i === active;
        const trig = byCid(t.trigger), panel = byCid(t.panel);
        applyStyle(trig, on ? t.triggerOn : t.triggerOff);
        trig?.setAttribute("aria-selected", on ? "true" : "false");
        if (trig) (trig as HTMLElement).tabIndex = on ? 0 : -1;
        applyStyle(panel, on ? t.panelShown : t.panelHidden);
        if (on) applyDesc(t.descendants);
        if (panel) { if (on) { panel.removeAttribute("hidden"); } else { panel.setAttribute("hidden", ""); } }
      });
      spec.tabs.forEach((t, i) => {
        const trig = byCid(t.trigger);
        if (!trig) return;
        trig.addEventListener("click", (e) => { e.preventDefault(); active = i; render(); }, { signal });
        trig.addEventListener("keydown", (e) => {
          const k = (e as KeyboardEvent).key;
          if (k === "ArrowRight" || k === "ArrowLeft") {
            e.preventDefault();
            active = (active + (k === "ArrowRight" ? 1 : spec.tabs.length - 1)) % spec.tabs.length;
            render();
            byCid(spec.tabs[active].trigger)?.focus();
          }
        }, { signal });
      });
      // No initial render() — the static base state is already correct.
    } else if (spec.kind === "accordion") {
      const state = spec.items.map((it) => it.expanded);
      const renderItem = (i: number) => {
        const it = spec.items[i], on = state[i];
        const trig = byCid(it.trigger), region = byCid(it.region);
        applyStyle(trig, on ? it.triggerOn : it.triggerOff);
        trig?.setAttribute("aria-expanded", on ? "true" : "false");
        applyStyle(region, on ? it.regionShown : it.regionHidden);
        if (region) { if (on) { region.removeAttribute("hidden"); } else { region.setAttribute("hidden", ""); } }
      };
      spec.items.forEach((it, i) => {
        const trig = byCid(it.trigger);
        if (trig) trig.addEventListener("click", (e) => { e.preventDefault(); state[i] = !state[i]; renderItem(i); }, { signal });
      });
      // No initial renderItem — the static base state is already correct.
    } else if (spec.kind === "carousel") {
      // Carousel: move the track's transform between captured per-index positions.
      const n = spec.transforms.length;
      let index = spec.base;
      const track = byCid(spec.track);
      const go = (k: number) => {
        index = Math.max(0, Math.min(n - 1, k));
        if (track) track.style.transform = spec.transforms[index];
        spec.bullets.forEach((b, bi) => applyStyle(byCid(b), bi === index ? spec.bulletOn : spec.bulletOff));
      };
      const nextEl = spec.next ? byCid(spec.next) : null;
      const prevEl = spec.prev ? byCid(spec.prev) : null;
      nextEl?.addEventListener("click", (e) => { e.preventDefault(); go(index + 1); }, { signal });
      prevEl?.addEventListener("click", (e) => { e.preventDefault(); go(index - 1); }, { signal });
      spec.bullets.forEach((b, bi) => byCid(b)?.addEventListener("click", (e) => { e.preventDefault(); go(bi); }, { signal }));
      // No initial go() — the static base state is already correct.
    } else {
      // Disclosure: dropdown / mega-menu / modal — a trigger reveals a hidden overlay.
      spec.items.forEach((it) => {
        const trig = byCid(it.trigger), panel = byCid(it.panel);
        if (!trig || !panel) return;
        let open = false;
        const set = (o: boolean) => {
          open = o;
          applyStyle(trig, o ? it.triggerOn : it.triggerOff);
          trig.setAttribute("aria-expanded", o ? "true" : "false");
          applyStyle(panel, o ? it.panelShown : it.panelHidden);
          if (o) applyDesc(it.descendants);
          if (o) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
        };
        trig.addEventListener("click", (e) => { e.preventDefault(); set(it.isDialog ? true : !open); }, { signal });
        if (it.hoverOpen) {
          const root = trig.parentElement ?? trig;
          root.addEventListener("mouseenter", () => set(true), { signal });
          root.addEventListener("mouseleave", () => set(false), { signal });
        }
        it.closes.forEach((c) => byCid(c)?.addEventListener("click", (e) => { e.preventDefault(); set(false); }, { signal }));
        if (it.backdropClose) panel.addEventListener("click", (e) => { if (e.target === panel) set(false); }, { signal });
        document.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape" && open) set(false); }, { signal });
      });
      // No initial set() — the static base state is already correct.
    }
    return () => ac.abort();
  }, [spec]);
  return null;
}
`;
