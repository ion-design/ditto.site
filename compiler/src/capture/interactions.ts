import type { Page } from "playwright";

/**
 * Interaction capture driver (Stage 4). Runs AFTER the settled base snapshot, only
 * when interactions are enabled (opt-in), at the canonical viewport. It drives
 * recognized affordances and records the resulting state deltas, keyed by a
 * capture-id (`data-cid-cap`, a pre-order document index stamped on every element)
 * that the IR carries through (whitelisted) so generation can map delta → cid.
 *
 * Milestone 1 (this cut): pure-CSS hover/focus — hover/focus each candidate and
 * diff its computed style vs. its resting state. Later milestones add discrete
 * patterns (tabs/accordion/carousel/dropdown/modal) to the same artifact.
 */

// Properties a :hover / :focus rule realistically changes (a curated subset).
const PSEUDO_PROPS = [
  "color", "backgroundColor", "backgroundImage", "backgroundPosition",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "boxShadow", "opacity", "transform", "filter",
  "textDecorationLine", "textDecorationColor",
  "outlineColor", "outlineWidth", "outlineStyle", "letterSpacing",
] as const;

export type StyleDelta = Record<string, string>;

/** Changed-properties delta: every key in `b` whose value differs from `a`. Pure (unit-tested). */
export function diffStyle(a: StyleDelta, b: StyleDelta): StyleDelta {
  const d: StyleDelta = {};
  for (const k of Object.keys(b)) if (a[k] !== b[k]) d[k] = b[k]!;
  return d;
}

// Properties that distinguish a panel's shown/hidden state and a trigger's
// active/inactive state. Captured per discrete state so the generated controller
// can toggle between them faithfully (M2: tabs + accordion).
const STATE_PROPS = [
  "display", "visibility", "opacity", "position", "height", "maxHeight", "minHeight", "overflow",
  "top", "right", "bottom", "left", "width", "zIndex",
  "paddingTop", "paddingBottom", "marginTop", "marginBottom",
  "color", "backgroundColor", "backgroundImage",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "boxShadow", "transform", "fontWeight", "textDecorationLine",
] as const;

// Visibility-relevant props captured for a panel's DESCENDANTS, to reproduce content
// whose visibility is independently gated by a JS-toggled class (e.g. an Elementor
// `e-active` on inner elements) whose CSS rule the clone doesn't carry. Only descendants
// whose open value differs from closed are kept. We deliberately EXCLUDE height/minHeight:
// a display:none subtree's getComputedStyle reports height "auto", but once shown it
// reports the used pixel height, so a height delta is mostly layout-reflow noise (not a
// real gate) and pinning it inline could clip revealed content.
const DESC_PROPS = ["display", "visibility", "opacity", "maxHeight", "overflow", "transform"] as const;

export type CapStyle = Record<string, string>;

// A recognized, captured interactive pattern. capIds (`data-cid-cap`) are mapped to
// the IR's cids at generation time; per-state styles drive a fixed client controller.
export type TabsSpec = {
  kind: "tabs";
  rootCap: string;
  activeIndex: number;
  tabs: Array<{
    triggerCap: string; panelCap: string;
    triggerOn: CapStyle; triggerOff: CapStyle;
    panelShown: CapStyle; panelHidden: CapStyle;
    descendants?: Record<string, CapStyle>; // cap → open-state overrides for gated content
  }>;
};
export type AccordionSpec = {
  kind: "accordion";
  rootCap: string;
  items: Array<{
    triggerCap: string; regionCap: string; expandedAtBase: boolean;
    triggerOn: CapStyle; triggerOff: CapStyle;
    regionShown: CapStyle; regionHidden: CapStyle;
  }>;
};
export type CarouselSpec = {
  kind: "carousel";
  rootCap: string;
  trackCap: string;          // element that carries the translate transform
  nextCap: string | null;
  prevCap: string | null;
  bulletCaps: string[];      // pagination controls, index-aligned (may be empty)
  baseIndex: number;
  transforms: string[];      // per-index computed track transform (matrix form)
  bulletOn: CapStyle;        // active pagination-bullet style
  bulletOff: CapStyle;       // inactive pagination-bullet style
};
// M4 (dropdown / mega-menu) + M5 (modal/dialog): a trigger reveals a hidden overlay
// panel (display flip), like an accordion but the panel is an overlay. Menus may also
// open on hover; dialogs add explicit close controls + a backdrop.
export type RelBox = { dx: number; dy: number; w: number; h: number }; // panel box relative to its trigger (scroll/offsetParent-independent)
export type DisclosureSpec = {
  kind: "disclosure";
  rootCap: string;
  items: Array<{
    triggerCap: string; panelCap: string;
    isDialog: boolean; hoverOpen: boolean; backdropClose: boolean;
    closeCaps: string[];
    triggerOn: CapStyle; triggerOff: CapStyle;
    panelShown: CapStyle; panelHidden: CapStyle;
    shownBox: RelBox | null; // panel geometry when open (for the position gate)
    descendants?: Record<string, CapStyle>; // cap → open-state overrides for gated content
  }>;
};
export type PatternSpec = TabsSpec | AccordionSpec | CarouselSpec | DisclosureSpec;

export type InteractionCapture = {
  hover: Record<string, StyleDelta>; // capId → changed props on :hover (self)
  focus: Record<string, StyleDelta>; // capId → changed props on :focus
  // capId → { descendantCapId → revealed-on-hover delta }. A hover that reveals a hidden
  // child overlay/CTA (framer's "Read story" card hover) — the hovered element's OWN style
  // is unchanged, so the reveal is only visible as a descendant delta.
  hoverDesc?: Record<string, Record<string, StyleDelta>>;
  candidates: number; // how many affordances were driven
  patterns: PatternSpec[]; // M2+: recognized tabs/accordion (capId-keyed)
  menus?: MenuCapture[]; // M4b: mount-on-open dropdowns/mega-menus (panel not in base DOM)
};

/** A mount-on-open menu (Radix-style portal): the panel is added to <body> on open and
 *  removed on close, so it is NOT in the base capture and the IR-based disclosure path
 *  (which needs a present panel) can't see it. We capture the panel's OPEN state as a
 *  self-contained, inline-styled HTML fragment; the clone reproduces it CLIENT-SIDE
 *  (rendered null on mount, injected under the trigger on interaction), so the static
 *  base that gates 0–6 grade is structurally untouched. `assetUrls` are the panel's image
 *  refs for the asset pipeline; the fragment keeps original href/src for generation to
 *  rewrite (local asset or app-relative link — never a remote ref). */
export type MenuCapture = {
  triggerCap: string;
  hoverOpen: boolean;
  gap: number; // px gap captured between the trigger's bottom and the panel's top
  align: "left" | "right"; // panel left-aligned or right-aligned to the trigger
  html: string;
  assetUrls: string[];
};

/** Stamp every element with a stable pre-order capture-id (document order). Idempotent. */
export async function tagElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const els = document.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) els[i]!.setAttribute("data-cid-cap", String(i));
  });
}

// Curated inline-style props for a self-contained captured menu panel (enough to render
// a dropdown/mega-menu faithfully without the page's stylesheets).
const MENU_PROPS = [
  "display", "position", "boxSizing", "width", "height", "minWidth", "maxWidth", "minHeight",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
  "backgroundColor", "color", "boxShadow", "opacity",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "textAlign", "textTransform", "textDecorationLine", "whiteSpace",
  "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "listStyleType", "verticalAlign", "objectFit", "cursor", "overflow",
];

/** Capture mount-on-open menus (Radix-style portals): the panel is added to the DOM on
 *  open, so the IR (built from the closed base) never sees it. We open each candidate
 *  trigger, serialize the resulting panel as a self-contained inline-styled fragment, then
 *  close it — leaving the page in its captured base state. Conservative: bounded count,
 *  every action try/guarded, and the clone gate-prunes any menu that doesn't reproduce. */
async function captureMenus(page: Page, log: (e: Record<string, unknown>) => void): Promise<MenuCapture[]> {
  let triggers: Array<{ cap: string; controls: string | null; method: "click" | "hover" }> = [];
  try {
    triggers = await page.evaluate(() => {
      const out: Array<{ cap: string; controls: string | null; method: "click" | "hover" }> = [];
      const seen = new Set<string>();
      const okBox = (el: Element): boolean => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return !(r.width < 1 || r.height < 1 || r.bottom < 0);
      };
      const isSkipTrigger = (el: Element): boolean => {
        const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
        return /\bskip\s+(?:to\s+)?(?:content|main|navigation)\b/.test(label);
      };
      // ARIA click triggers — mount-on-open only (controlled panel NOT already in the DOM;
      // a present panel is handled by the IR-based disclosure path).
      for (const el of Array.from(document.querySelectorAll('[aria-haspopup], [aria-expanded][aria-controls]'))) {
        const cap = el.getAttribute("data-cid-cap"); if (!cap || seen.has(cap) || !okBox(el) || isSkipTrigger(el)) continue;
        const controls = el.getAttribute("aria-controls");
        if (controls && document.getElementById(controls)) continue;
        seen.add(cap); out.push({ cap, controls, method: "click" });
      }
      // Non-ARIA hover triggers — a short-label item in the top nav row. Framer's mega-menu
      // trigger is a plain <div> with no ARIA and cursor:default; it is only findable by
      // behavior (hover it and see if a panel appears), so collect the nav labels to probe.
      for (const root of Array.from(document.querySelectorAll('nav, header, [role="navigation"]'))) {
        for (const el of Array.from(root.querySelectorAll('a, button, [role="button"], li, div, span'))) {
          const cap = el.getAttribute("data-cid-cap"); if (!cap || seen.has(cap) || !okBox(el)) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.top > 160) continue; // top nav row only
          const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length < 2 || txt.length > 24) continue; // a nav label, not a container/blob
          if (isSkipTrigger(el)) continue;
          if (el.querySelector('a, button, [role="button"]')) continue; // the label itself, not a wrapper of other interactives
          seen.add(cap); out.push({ cap, controls: null, method: "hover" });
        }
      }
      return out.slice(0, 16);
    });
  } catch { return []; }

  const menus: MenuCapture[] = [];
  const seenPanels = new Set<string>(); // dedupe: nested nav triggers all open the same panel
  for (const t of triggers) {
    try {
      const before = await page.evaluate(() => ({
        bodyKids: document.body.children.length,
        // cap-ids of large, content-bearing, visible boxes — so an in-place panel that becomes
        // visible/populated on open can be distinguished from what was already on screen.
        visible: Array.from(document.querySelectorAll("[data-cid-cap]")).filter((el) => {
          const cs = getComputedStyle(el); const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 180 && r.height > 50 && cs.opacity !== "0" && cs.visibility !== "hidden" && cs.display !== "none" && el.querySelectorAll("a, p, li").length >= 2;
        }).map((el) => el.getAttribute("data-cid-cap")),
      }));
      if (t.method === "click") await page.evaluate((c) => (document.querySelector(`[data-cid-cap="${c}"]`) as HTMLElement | null)?.click(), t.cap);
      else await page.hover(`[data-cid-cap="${t.cap}"]`, { timeout: 800, force: true }).catch(() => {});
      await page.waitForTimeout(280);
      const res = await page.evaluate(({ cap, controls, before, props }) => {
        const trig = document.querySelector(`[data-cid-cap="${cap}"]`) as HTMLElement | null;
        if (!trig) return null;
        const tr = trig.getBoundingClientRect();
        // Resolve the panel: by aria-controls, else a newly-appeared role=menu/dialog/listbox
        // overlay, else a new top-level body child, else an in-place box that became visible.
        let panel: HTMLElement | null = controls ? document.getElementById(controls) : null;
        if (!panel) {
          const roled = Array.from(document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]')) as HTMLElement[];
          panel = roled.find((p) => { const r = p.getBoundingClientRect(); return r.width > 40 && r.height > 20; }) || null;
        }
        if (!panel && document.body.children.length > before.bodyKids) {
          const fresh = Array.from(document.body.children).slice(before.bodyKids) as HTMLElement[];
          panel = fresh.find((p) => { const r = p.getBoundingClientRect(); return r.width > 40 && r.height > 20; }) || null;
        }
        if (!panel) {
          // In-place mega-menu: a large content box that became visible BELOW the trigger and
          // was not visible before (framer's empty container, populated on hover).
          const beforeSet = new Set(before.visible);
          let cands = (Array.from(document.querySelectorAll("[data-cid-cap]")) as HTMLElement[]).filter((el) => {
            const c2 = el.getAttribute("data-cid-cap"); if (!c2 || beforeSet.has(c2)) return false;
            const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
            return r.width > 180 && r.height > 50 && cs.opacity !== "0" && cs.visibility !== "hidden" && cs.display !== "none"
              && el.querySelectorAll("a, p").length >= 2 && r.top >= tr.top - 8 && r.top < tr.bottom + 480 && r.left < tr.left + 700;
          });
          cands = cands.filter((el) => !cands.some((o) => o !== el && o.contains(el))); // outermost newly-visible box
          panel = cands.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; })[0] || null;
        }
        if (!panel) return null;
        const pr = panel.getBoundingClientRect();
        if (pr.width < 1 || pr.height < 1) return null;
        const assetUrls: string[] = [];
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        const VOID = new Set(["img", "br", "hr", "input", "wbr"]);
        const serialize = (el: Element, isRoot: boolean): string => {
          const tag = el.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript" || tag === "link") return "";
          if (tag === "svg") return el.outerHTML; // keep inline SVG verbatim (self-contained)
          const cs = getComputedStyle(el);
          if (!isRoot && (cs.display === "none" || cs.visibility === "hidden")) return "";
          // the panel root is repositioned by the controller, so neutralize its own offset
          let style = props.map((p) => `${kebab(p)}:${(cs as unknown as Record<string, string>)[p] ?? ""}`).join(";");
          if (isRoot) style = "position:absolute;margin:0;" + style.replace(/(^|;)position:[^;]*/g, "").replace(/(^|;)margin[^:]*:[^;]*/g, "");
          let attrs = ` style="${esc(style)}"`;
          const href = el.getAttribute("href"); if (tag === "a" && href) attrs += ` href="${esc(href)}"`;
          const al = el.getAttribute("aria-label"); if (al) attrs += ` aria-label="${esc(al)}"`;
          if (tag === "img") { const src = (el as HTMLImageElement).src; if (src) { assetUrls.push(src); attrs += ` src="${esc(src)}" alt="${esc(el.getAttribute("alt") || "")}"`; } }
          if (VOID.has(tag)) return `<${tag}${attrs}>`;
          let inner = "";
          for (const n of Array.from(el.childNodes)) {
            if (n.nodeType === 3) inner += esc(n.textContent || "");
            else if (n.nodeType === 1) inner += serialize(n as Element, false);
          }
          return `<${tag}${attrs}>${inner}</${tag}>`;
        };
        const html = serialize(panel, true);
        const align: "left" | "right" = Math.abs(pr.right - tr.right) < Math.abs(pr.left - tr.left) ? "right" : "left";
        return { html, assetUrls, gap: Math.max(0, Math.round(pr.top - tr.bottom)), align };
      }, { cap: t.cap, controls: t.controls, before, props: MENU_PROPS });
      // restore the base (closed) state: click again + Escape for click menus; move the
      // pointer away for hover menus (so the in-place panel re-hides).
      if (t.method === "click") {
        await page.evaluate((c) => (document.querySelector(`[data-cid-cap="${c}"]`) as HTMLElement | null)?.click(), t.cap);
        await page.keyboard.press("Escape").catch(() => {});
      } else {
        await page.mouse.move(1, 1).catch(() => {});
      }
      await page.waitForTimeout(120);
      if (res && res.html && res.html.length > 30) {
        // Nested nav triggers (the item div, its link, its label span) all open the SAME
        // panel — keep only the first (outermost, lowest cap) per unique panel.
        const sig = res.html.length + "|" + res.html.slice(0, 120);
        if (!seenPanels.has(sig)) {
          seenPanels.add(sig);
          menus.push({ triggerCap: t.cap, hoverOpen: t.method === "hover", gap: res.gap, align: res.align, html: res.html, assetUrls: res.assetUrls.slice(0, 60) });
        }
      }
    } catch { /* not openable / serialization failed — skip (stays static) */ }
  }
  if (menus.length) log({ event: "menus_captured", count: menus.length });
  return menus;
}

export async function captureInteractions(page: Page, opts?: { maxCandidates?: number; log?: (e: Record<string, unknown>) => void }): Promise<InteractionCapture> {
  const log = opts?.log ?? (() => {});
  // Probe every visible affordance, not just the first few hundred by document order: rich pages
  // can keep footer/lower-section hovers well past a low cap, silently losing hover states.
  // The per-element diff self-limits (a no-op records nothing), so the only cost is the
  // once-per-site offline capture time; 1200 covers realistic pages with headroom.
  const cap = opts?.maxCandidates ?? 1200;

  // Candidate affordances: native interactives + ARIA buttons + anything the page
  // styles as clickable (cursor:pointer). Deterministic order (by capture-id).
  const candidates: string[] = await page.evaluate((maxN: number) => {
    const visibleCap = (el: Element): string | null => {
      const id = el.getAttribute("data-cid-cap");
      if (!id) return null;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom < 0) return null;
      return id;
    };
    const set = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll("a, button, [role='button'], input, select, textarea, summary, label, [tabindex]"))) set.add(el);
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (set.size > 4000) break;
      try { if (getComputedStyle(el).cursor === "pointer") set.add(el); } catch { /* ignore */ }
    }
    const out: Array<{ id: number; cap: string }> = [];
    for (const el of set) { const c = visibleCap(el); if (c != null) out.push({ id: parseInt(c, 10), cap: c }); }
    out.sort((a, b) => a.id - b.id);
    const main = out.slice(0, maxN).map((o) => o.cap);
    // Card representatives: the first couple of CARDS in each marquee/carousel row. A card
    // is a child of a row with ≥3 sized children that sits inside an overflow-clip ancestor
    // (the marquee/ticker viewport — note the clip is on the VIEWPORT, while the ≥3-sibling
    // row that holds the cards is a level or two deeper). These cards are DEEP (beyond maxN
    // by document order) yet are exactly where a per-card hover effect lives, so probe a
    // bounded sample. The hover diff self-limits to real deltas, so a no-op records nothing.
    const isClip = (el: Element): boolean => { try { const ox = getComputedStyle(el).overflowX; return ox === "hidden" || ox === "clip"; } catch { return false; } };
    const insideClip = (el: Element): boolean => { let p: Element | null = el, depth = 0; while (p && depth < 8) { if (isClip(p)) return true; p = p.parentElement; depth++; } return false; };
    const seen = new Set(main);
    const reps: string[] = [];
    for (const row of Array.from(document.querySelectorAll("*"))) {
      if (reps.length >= 120) break;
      const kids = Array.from(row.children).filter((k) => { const r = k.getBoundingClientRect(); return r.width > 40 && r.height > 40; });
      if (kids.length < 3) continue;
      if (!insideClip(row)) continue; // marquee/carousel context only
      for (const k of kids.slice(0, 2)) { const c = visibleCap(k); if (c != null && !seen.has(c)) { seen.add(c); reps.push(c); } }
    }
    return [...main, ...reps];
  }, cap);

  const read = (capId: string): Promise<StyleDelta | null> =>
    page.evaluate(({ capId, props }) => {
      const el = document.querySelector(`[data-cid-cap="${capId}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o: Record<string, string> = {};
      for (const p of props) { const v = (cs as unknown as Record<string, string>)[p]; if (v != null) o[p] = v; }
      return o;
    }, { capId, props: PSEUDO_PROPS as unknown as string[] });

  const diff = diffStyle;

  // Pseudo-state driver via CDP `CSS.forcePseudoState`. Pointer-based hovering (page.hover)
  // moves the REAL cursor to the element's box centre, so the browser applies `:hover` to
  // whatever sits under that point — on a page with a transparent full-viewport overlay (a
  // fixed page-wrapper / scroll layer, common on modern builder stacks) the point lands on the
  // overlay and the target never enters `:hover`, silently capturing ZERO authored hover states
  // even though page.hover throws nothing. Forcing the pseudo-class on the node itself is
  // geometry-independent (occlusion-immune), applies pure-CSS `:hover` rules directly, and — for
  // `.card:hover .overlay` — also styles descendants of the forced node, so reveals still show.
  // Resolves each cap → CDP nodeId; a live map is rebuilt per element (cheap) so it survives
  // any DOM churn. Falls back to no forcing if a CDP session can't be opened (then hover/focus
  // capture is simply empty rather than wrong).
  const client = await page.context().newCDPSession(page).catch(() => null);
  if (client) {
    try { await client.send("DOM.enable"); await client.send("CSS.enable"); await client.send("DOM.getDocument", {}); }
    catch { /* CDP unavailable — force() below no-ops */ }
  }
  const nodeIdFor = async (capId: string): Promise<number | null> => {
    if (!client) return null;
    let objectId: string | undefined;
    try {
      const ev = await client.send("Runtime.evaluate", { expression: `document.querySelector('[data-cid-cap="${capId}"]')` }) as { result?: { objectId?: string } };
      objectId = ev.result?.objectId; if (!objectId) return null;
      const r = await client.send("DOM.requestNode", { objectId }) as { nodeId?: number };
      return r.nodeId ?? null;
    } catch { return null; }
    finally { if (objectId) await client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  };
  // Force (or clear, with []) a pseudo-class on a node. Deterministic and reversible.
  const force = async (nodeId: number | null, classes: string[]): Promise<boolean> => {
    if (!client || nodeId == null) return false;
    try { await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: classes }); return true; }
    catch { return false; }
  };
  const settlePseudo = () => page.waitForTimeout(180); // let a `:hover`/`:focus` transition land

  // Reveal-relevant props for descendants that appear on hover (overlay glow + CTA). Only
  // clean show/hide props — NOT transform/filter, whose mid-animation values bake a janky
  // partial state (a half-scaled overlay) when the reveal hasn't fully settled.
  const DESC_REVEAL_PROPS = ["opacity", "visibility", "display", "backgroundImage", "backgroundColor"];
  // Descendants that are CURRENTLY hidden (so a hover-reveal is detectable): opacity≤0.1 /
  // display:none / visibility:hidden, with a real box (or display:none). Keyed by cap.
  const readHiddenDesc = (capId: string): Promise<Record<string, StyleDelta>> =>
    page.evaluate(({ capId, props }) => {
      const el = document.querySelector(`[data-cid-cap="${capId}"]`);
      if (!el) return {};
      const out: Record<string, Record<string, string>> = {};
      let n = 0;
      for (const d of Array.from(el.querySelectorAll("[data-cid-cap]"))) {
        if (n >= 80) break;
        const cs = getComputedStyle(d);
        const hidden = parseFloat(cs.opacity || "1") <= 0.1 || cs.display === "none" || cs.visibility === "hidden";
        if (!hidden) continue;
        const r = (d as HTMLElement).getBoundingClientRect();
        if (cs.display !== "none" && (r.width < 8 || r.height < 8)) continue; // ignore 0-box hidden
        const dcap = d.getAttribute("data-cid-cap"); if (!dcap) continue;
        const o: Record<string, string> = {};
        for (const p of props) o[p] = (cs as unknown as Record<string, string>)[p] ?? "";
        out[dcap] = o; n++;
      }
      return out;
    }, { capId, props: DESC_REVEAL_PROPS });
  const readDescProps = (caps: string[]): Promise<Record<string, StyleDelta>> =>
    page.evaluate(({ caps, props }) => {
      const out: Record<string, Record<string, string>> = {};
      for (const dcap of caps) {
        const d = document.querySelector(`[data-cid-cap="${dcap}"]`); if (!d) continue;
        const cs = getComputedStyle(d);
        const o: Record<string, string> = {};
        for (const p of props) o[p] = (cs as unknown as Record<string, string>)[p] ?? "";
        out[dcap] = o;
      }
      return out;
    }, { caps, props: DESC_REVEAL_PROPS });

  const hover: Record<string, StyleDelta> = {};
  const focus: Record<string, StyleDelta> = {};
  const hoverDesc: Record<string, Record<string, StyleDelta>> = {};

  for (const capId of candidates) {
    const base = await read(capId);
    if (!base) continue;
    const nodeId = await nodeIdFor(capId);
    const hiddenBase = await readHiddenDesc(capId); // hidden descendants → hover-reveal candidates
    const hiddenCaps = Object.keys(hiddenBase);
    // :hover — force the pseudo-class on the node (geometry-independent; see `force` above),
    // then settle before reading: an authored `:hover`/JS transition animates from the resting
    // frame, so an immediate read catches the pre-transition value and sees no delta. Wait for it.
    if (await force(nodeId, ["hover"])) {
      await settlePseudo();
      const h = await read(capId);
      if (h) { const d = diff(base, h); if (Object.keys(d).length) hover[capId] = d; }
      // Descendant reveals (while still hovered): a hidden child shown on hover — the card's
      // OWN style is unchanged, so this is the only signal (a "Read story" overlay). Forcing
      // `:hover` on the card also matches `.card:hover .overlay` rules on its descendants.
      if (hiddenCaps.length) {
        await page.waitForTimeout(380); // let the reveal transition fully finish before reading
        const after = await readDescProps(hiddenCaps);
        const revealed: Record<string, StyleDelta> = {};
        for (const dcap of hiddenCaps) {
          const a = hiddenBase[dcap]!, b = after[dcap]; if (!b) continue;
          // Only a CLEAN, complete reveal: the overlay reached (near-)full opacity, or a
          // display:none child became shown. A partial opacity is a mid-animation frame — skip
          // it (leave static) rather than bake a half-faded overlay.
          const cleanReveal = parseFloat(b.opacity || "1") > 0.85 || (a.display === "none" && b.display !== "none");
          if (!cleanReveal) continue;
          const d = diff(a, b);
          if (Object.keys(d).length) revealed[dcap] = d;
        }
        if (Object.keys(revealed).length) hoverDesc[capId] = revealed;
      }
      await force(nodeId, []); // clear :hover before probing :focus
    }
    // :focus — force the pseudo-class the same way (also occlusion-independent).
    if (await force(nodeId, ["focus"])) {
      await settlePseudo();
      const f = await read(capId);
      if (f) { const d = diff(base, f); if (Object.keys(d).length) focus[capId] = d; }
      await force(nodeId, []); // restore the resting state
    }
  }
  await client?.detach().catch(() => {});

  log({ event: "interactions_hover_focus", candidates: candidates.length, hover: Object.keys(hover).length, focus: Object.keys(focus).length, hoverDesc: Object.keys(hoverDesc).length });

  // M2: recognize + drive discrete patterns (tabs / accordion).
  const patterns = await drivePatterns(page, log);
  const menus = await captureMenus(page, log);

  return { hover, focus, hoverDesc: Object.keys(hoverDesc).length ? hoverDesc : undefined, candidates: candidates.length, patterns, menus: menus.length ? menus : undefined };
}

// ---- M2: tabs + accordion ----

type TabsStruct = { rootCap: string; activeIndex: number; tabs: Array<{ triggerCap: string; panelCap: string }> };
type AccStruct = { rootCap: string; items: Array<{ triggerCap: string; regionCap: string; expandedAtBase: boolean }> };
type CarStruct = { rootCap: string; trackCap: string; nextCap: string | null; prevCap: string | null; bulletCaps: string[]; slideCount: number };
type DisclStruct = { rootCap: string; items: Array<{ triggerCap: string; controlCap: string; isDialog: boolean; closeCaps: string[] }> };

/** Recognize tab groups (role=tablist) and aria accordions (aria-expanded +
 *  aria-controls) from the live DOM. Returns capId-keyed structures only; styles
 *  are captured by driving below. Conservative: needs aria-controls to resolve a
 *  panel/region, ≥2 tabs for a tab group; menu/dialog triggers are excluded (M4/M5). */
async function recognizePatterns(page: Page): Promise<{ tabs: TabsStruct[]; accordions: AccStruct[]; carousels: CarStruct[]; disclosures: DisclStruct[] }> {
  return page.evaluate(() => {
    const capOf = (el: Element | null): string | null => el?.getAttribute("data-cid-cap") ?? null;
    const visible = (el: Element | null): boolean => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return (el as HTMLElement).offsetParent !== null || cs.position === "fixed";
    };
    const tabs: TabsStruct[] = [];
    for (const list of Array.from(document.querySelectorAll('[role="tablist"]'))) {
      const tabEls = Array.from(list.querySelectorAll('[role="tab"]')).filter((t) => !list.querySelector('[role="tablist"]') || t.closest('[role="tablist"]') === list);
      if (tabEls.length < 2) continue;
      const items: Array<{ triggerCap: string; panelCap: string }> = [];
      let activeIndex = 0;
      tabEls.forEach((tab, i) => {
        const controls = tab.getAttribute("aria-controls");
        const panel = controls ? document.getElementById(controls) : null;
        if (tab.getAttribute("aria-selected") === "true") activeIndex = i;
        const tc = capOf(tab), pc = capOf(panel);
        if (tc && pc) items.push({ triggerCap: tc, panelCap: pc });
      });
      const root = (list.parentElement ?? list) as Element;
      const rc = capOf(root);
      if (items.length >= 2 && rc) tabs.push({ rootCap: rc, activeIndex: Math.min(activeIndex, items.length - 1), tabs: items });
    }
    const accordions: AccStruct[] = [];
    const accItems: Array<{ triggerCap: string; regionCap: string; expandedAtBase: boolean }> = [];
    for (const btn of Array.from(document.querySelectorAll("[aria-expanded]"))) {
      if (btn.getAttribute("role") === "tab") continue; // tab handled above
      if (btn.getAttribute("aria-haspopup")) continue;  // dropdown/menu = M4
      if (btn.closest('[role="dialog"],[role="menu"]')) continue;
      const controls = btn.getAttribute("aria-controls");
      const region = controls ? document.getElementById(controls) : null;
      const tc = capOf(btn), rc = capOf(region);
      if (!tc || !rc || !visible(btn)) continue;
      accItems.push({ triggerCap: tc, regionCap: rc, expandedAtBase: btn.getAttribute("aria-expanded") === "true" });
    }
    if (accItems.length) accordions.push({ rootCap: accItems[0]!.triggerCap, items: accItems.slice(0, 40) });

    // Non-ARIA "collapsed-region" accordions (e.g. an FAQ of plain divs + a React onClick): a
    // clickable row (cursor:pointer) whose subtree holds a region collapsed by height/max-height:0
    // + overflow:hidden yet carrying real hidden content (scrollHeight > clientHeight). React
    // delegates its click to the root, so there's no per-element listener to find — these are
    // discoverable only structurally. The driver clicks each row and keeps it ONLY if the region
    // actually expands, so non-accordion collapses (spacers, lazy sections) are dropped.
    const claimed = new Set<string>(accItems.flatMap((i) => [i.triggerCap, i.regionCap]));
    const collapsedItems: Array<{ triggerCap: string; regionCap: string; expandedAtBase: boolean }> = [];
    for (const region of Array.from(document.querySelectorAll("div, section, ul, dl, p"))) {
      const el = region as HTMLElement;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "hidden" && cs.overflowY !== "clip") continue;
      const collapsed = el.clientHeight <= 1 || parseFloat(cs.maxHeight) === 0;
      if (!collapsed || el.scrollHeight <= 8) continue;            // must hide real content
      if (!(region.textContent || "").trim()) continue;
      let trig: Element | null = region.parentElement;             // nearest clickable ancestor = the row
      for (let hops = 0; trig && hops < 4 && getComputedStyle(trig).cursor !== "pointer"; hops++) trig = trig.parentElement;
      if (!trig || getComputedStyle(trig).cursor !== "pointer" || !visible(trig)) continue;
      const tc = capOf(trig), rc = capOf(region);
      if (!tc || !rc || claimed.has(tc) || claimed.has(rc)) continue;
      claimed.add(tc); claimed.add(rc);
      collapsedItems.push({ triggerCap: tc, regionCap: rc, expandedAtBase: false });
      if (collapsedItems.length >= 40) break;
    }
    if (collapsedItems.length) accordions.push({ rootCap: collapsedItems[0]!.triggerCap, items: collapsedItems });

    // Carousels: Swiper / Slick / ARIA-carousel and class-based variants. Slide-driven
    // — collect slide elements and group by their parent (the track / transform
    // carrier); the root is the nearest carousel-ish ancestor. More robust than a
    // fixed root selector (catches class-named carousels with aria slides). Needs ≥2
    // slides and a navigation control (next/prev or ≥2 index-aligned bullets).
    const carousels: CarStruct[] = [];
    const slideEls = Array.from(document.querySelectorAll('.swiper-slide, .slick-slide, [aria-roledescription="slide"]'));
    const byTrack = new Map<Element, Element[]>();
    for (const s of slideEls) {
      const p = s.parentElement;
      if (!p) continue;
      const arr = byTrack.get(p) ?? [];
      arr.push(s); byTrack.set(p, arr);
    }
    const ROOT_SEL = '.swiper, .slick-slider, [aria-roledescription="carousel"], [class*="carousel" i], [class*="slider" i]';
    for (const [track, slides] of byTrack) {
      if (slides.length < 2 || !visible(track)) continue;
      // Root = nearest carousel-ish ANCESTOR of the track (not the track itself — a
      // BEM track like `.category-carousel__track` matches [class*=carousel], and the
      // prev/next controls are siblings of the track, outside it).
      let anc: Element | null = track.parentElement;
      while (anc && !anc.matches(ROOT_SEL)) anc = anc.parentElement;
      const root = (anc ?? track.parentElement ?? track) as Element;
      const q1 = (sels: string): Element | null => { for (const s of sels.split(",")) { try { const e = root.querySelector(s.trim()); if (e && root.contains(e)) return e; } catch { /* bad sel */ } } return null; };
      const nextEl = q1('.swiper-button-next, .slick-next, [aria-label*="next" i]');
      const prevEl = q1('.swiper-button-prev, .slick-prev, [aria-label*="prev" i]');
      let bullets = Array.from(root.querySelectorAll('.swiper-pagination-bullet, .slick-dots button, .slick-dots li')).filter((b) => visible(b));
      if (bullets.length !== slides.length) bullets = []; // only index-aligned pagination
      const tc = capOf(track), rc = capOf(root);
      if (!tc || !rc) continue;
      if (!nextEl && bullets.length < 2) continue;
      carousels.push({
        rootCap: rc, trackCap: tc,
        nextCap: capOf(nextEl), prevCap: capOf(prevEl),
        bulletCaps: bullets.map((b) => capOf(b)).filter((x): x is string => !!x),
        slideCount: slides.length,
      });
    }

    // Disclosures (dropdown / mega-menu / modal): a trigger with aria-haspopup +
    // aria-controls pointing at a panel. The driver resolves which element actually
    // toggles (the target or an overlay ancestor) and how it opens (click/hover).
    const dItems: DisclStruct["items"] = [];
    for (const trig of Array.from(document.querySelectorAll("[aria-haspopup]"))) {
      if (!visible(trig)) continue;
      const controls = trig.getAttribute("aria-controls");
      const target = controls ? document.getElementById(controls) : null;
      if (!target) continue;
      const tc = capOf(trig), pc = capOf(target);
      if (!tc || !pc) continue;
      const hp = (trig.getAttribute("aria-haspopup") || "").toLowerCase();
      const isDialog = hp === "dialog" || target.getAttribute("role") === "dialog" ||
        target.getAttribute("aria-modal") === "true" || !!target.closest('[role="dialog"],[aria-modal="true"]');
      const scope = (isDialog ? (target.closest('[class*="backdrop" i],[class*="overlay" i],[class*="modal" i]') ?? target.parentElement ?? target) : target) as Element;
      const closeCaps: string[] = [];
      for (const c of Array.from(scope.querySelectorAll('[aria-label*="close" i], [class*="close" i]'))) {
        const cc = capOf(c); if (cc && cc !== tc && !closeCaps.includes(cc)) closeCaps.push(cc);
      }
      dItems.push({ triggerCap: tc, controlCap: pc, isDialog, closeCaps: closeCaps.slice(0, 4) });
    }
    const disclosures: DisclStruct[] = dItems.length ? [{ rootCap: dItems[0]!.triggerCap, items: dItems.slice(0, 16) }] : [];

    return { tabs: tabs.slice(0, 12), accordions, carousels: carousels.slice(0, 6), disclosures };
  });
}

async function drivePatterns(page: Page, log: (e: Record<string, unknown>) => void): Promise<PatternSpec[]> {
  let struct: { tabs: TabsStruct[]; accordions: AccStruct[]; carousels: CarStruct[]; disclosures: DisclStruct[] };
  try { struct = await recognizePatterns(page); }
  catch { struct = { tabs: [], accordions: [], carousels: [], disclosures: [] }; }
  // (no early return — even a page with zero ARIA patterns may have non-ARIA
  // disclosures found by drive-and-diff below.)

  const readState = (capId: string): Promise<CapStyle | null> =>
    page.evaluate(({ capId, props }) => {
      const el = document.querySelector(`[data-cid-cap="${capId}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o: Record<string, string> = {};
      for (const p of props) { const v = (cs as unknown as Record<string, string>)[p]; if (v != null) o[p] = v; }
      return o;
    }, { capId, props: STATE_PROPS as unknown as string[] });
  const clickCap = (capId: string): Promise<void> =>
    page.evaluate((c) => { (document.querySelector(`[data-cid-cap="${c}"]`) as HTMLElement | null)?.click(); }, capId);
  const settle = () => page.waitForTimeout(180);
  // Visibility-relevant computed styles of a panel's capped descendants, in the
  // panel's CURRENT state. Diffing open vs closed yields the overrides needed to
  // reveal content whose visibility is independently gated (e.g. Elementor e-active).
  const descStyles = (panelCap: string): Promise<Record<string, CapStyle>> =>
    page.evaluate(({ p, props }) => {
      const panel = document.querySelector(`[data-cid-cap="${p}"]`);
      if (!panel) return {};
      const out: Record<string, Record<string, string>> = {};
      for (const el of Array.from(panel.querySelectorAll("[data-cid-cap]")).slice(0, 140)) {
        const cap = el.getAttribute("data-cid-cap"); if (!cap) continue;
        const cs = getComputedStyle(el);
        const o: Record<string, string> = {};
        for (const k of props) o[k] = (cs as unknown as Record<string, string>)[k] ?? "";
        out[cap] = o;
      }
      return out;
    }, { p: panelCap, props: DESC_PROPS as unknown as string[] });
  const descDiff = (open: Record<string, CapStyle>, closed: Record<string, CapStyle>): Record<string, CapStyle> => {
    const out: Record<string, CapStyle> = {};
    for (const cap of Object.keys(open)) {
      const o = open[cap]!, c = closed[cap]; if (!c) continue;
      const d: CapStyle = {};
      for (const k of Object.keys(o)) if (o[k] !== c[k]) d[k] = o[k]!;
      if (Object.keys(d).length) out[cap] = d;
    }
    return out;
  };
  // Will the clone's display-toggle reproduction actually reveal this panel's content?
  // DittoWire shows a panel by forcing its `display` (and nothing else). Simulate
  // exactly that — set the panel's inline display to its shown value — and check a
  // capped descendant (or own direct text) becomes visibly sized. If the content's
  // visibility is independently gated (e.g. Elementor toggles an `e-active` CLASS on
  // descendants, whose CSS rule the clone doesn't have), the simulation stays empty,
  // so we leave the pattern static instead of shipping a panel that opens blank.
  const displayReproducible = (capId: string, shownDisplay: string): Promise<boolean> =>
    page.evaluate(({ c, disp }) => {
      const el = document.querySelector(`[data-cid-cap="${c}"]`) as HTMLElement | null;
      if (!el) return false;
      const prev = el.style.display;
      el.style.setProperty("display", disp || "block", "important");
      let ok = false;
      for (const k of Array.from(el.querySelectorAll("[data-cid-cap]"))) {
        const kh = k as HTMLElement;
        if (kh.offsetWidth > 0 && kh.offsetHeight > 0) { ok = true; break; }
      }
      if (!ok) { let t = ""; for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.textContent || ""; ok = t.trim().length >= 2 && el.offsetHeight > 0; }
      if (prev) el.style.setProperty("display", prev); else el.style.removeProperty("display");
      return ok;
    }, { c: capId, disp: shownDisplay });
  // The panel's box relative to its trigger, measured while the panel is open — a
  // scroll- and offsetParent-independent fingerprint of where the panel lands, for
  // the position gate.
  const relBoxOf = (trigCap: string, panelCap: string): Promise<RelBox | null> =>
    page.evaluate(({ t, p }) => {
      const te = document.querySelector(`[data-cid-cap="${t}"]`) as HTMLElement | null;
      const pe = document.querySelector(`[data-cid-cap="${p}"]`) as HTMLElement | null;
      if (!te || !pe) return null;
      const tr = te.getBoundingClientRect(), pr = pe.getBoundingClientRect();
      if (pr.width < 1 || pr.height < 1) return null;
      return { dx: Math.round(pr.x - tr.x), dy: Math.round(pr.y - tr.y), w: Math.round(pr.width), h: Math.round(pr.height) };
    }, { t: trigCap, p: panelCap });

  // A pattern is only reproducible (and gate-verifiable) when its panels are shown/
  // hidden via `display` (covers the `[hidden]` attribute too). Height-animated or
  // unmount-on-close widgets (e.g. Radix) yield no reliable display flip — those are
  // skipped (the page stays faithful to its captured base state). M2 scope.
  const displayDiffers = (a: CapStyle | null | undefined, b: CapStyle | null | undefined): boolean =>
    !!a && !!b && (a.display ?? "") !== (b.display ?? "");
  const pxOf = (v: string | undefined): number => parseFloat(v ?? "") || 0;
  // max-height:0 collapses; max-height:none does NOT — and parseFloat("none")||0 would wrongly read
  // "none" as 0, marking an EXPANDED region collapsed. Match the literal zero only.
  const maxHeightZero = (s: CapStyle | null | undefined): boolean => /^0(px)?$/.test((s?.maxHeight ?? "").trim());
  const isCollapsed = (s: CapStyle | null | undefined): boolean =>
    !!s && (pxOf(s.height) <= 1 || maxHeightZero(s)) && /hidden|clip/.test(s.overflow ?? "");
  // A region that opened by HEIGHT rather than a display flip (FAQ h-0 → auto): collapsed when
  // closed, taller when shown. Lets the accordion driver accept height-collapse accordions.
  const heightToggled = (shown: CapStyle | null | undefined, hidden: CapStyle | null | undefined): boolean =>
    !!shown && !!hidden && isCollapsed(hidden) && !isCollapsed(shown) && pxOf(shown.height) > pxOf(hidden.height) + 2;

  const patterns: PatternSpec[] = [];

  // Tabs: click each tab, read every trigger/panel in that state.
  for (const t of struct.tabs) {
    const n = t.tabs.length;
    const triggerOn: (CapStyle | null)[] = Array(n).fill(null);
    const triggerOff: (CapStyle | null)[] = Array(n).fill(null);
    const panelShown: (CapStyle | null)[] = Array(n).fill(null);
    const panelHidden: (CapStyle | null)[] = Array(n).fill(null);
    // seed from base
    for (let j = 0; j < n; j++) {
      const tgs = await readState(t.tabs[j]!.triggerCap);
      const pns = await readState(t.tabs[j]!.panelCap);
      if (j === t.activeIndex) { triggerOn[j] = tgs; panelShown[j] = pns; }
      else { triggerOff[j] = tgs; panelHidden[j] = pns; }
    }
    for (let i = 0; i < n; i++) {
      try { await clickCap(t.tabs[i]!.triggerCap); await settle(); } catch { continue; }
      for (let j = 0; j < n; j++) {
        const tgs = await readState(t.tabs[j]!.triggerCap);
        const pns = await readState(t.tabs[j]!.panelCap);
        if (i === j) { if (tgs) triggerOn[j] = tgs; if (pns) panelShown[j] = pns; }
        else { if (tgs) triggerOff[j] = tgs; if (pns) panelHidden[j] = pns; }
      }
    }
    try { await clickCap(t.tabs[t.activeIndex]!.triggerCap); await settle(); } catch { /* ignore */ }
    const complete = t.tabs.every((_, j) => triggerOn[j] && triggerOff[j] && panelShown[j] && panelHidden[j]);
    const togglesByDisplay = t.tabs.every((_, j) => displayDiffers(panelShown[j], panelHidden[j]));
    // Every panel must actually reveal its content under a display-only toggle (what
    // DittoWire does). JS-gated content (e.g. Elementor's e-active class on inner
    // elements) stays blank, so we leave the whole group static rather than ship tabs
    // that switch to empty panels.
    let allReproducible = complete;
    for (let j = 0; allReproducible && j < n; j++) {
      if (!(await displayReproducible(t.tabs[j]!.panelCap, panelShown[j]?.display ?? "block"))) allReproducible = false;
    }
    if (complete && togglesByDisplay && allReproducible) {
      // Phase 2: capture each panel's open-state descendant overrides (open vs closed
      // diff). Empty for self-contained panels; non-empty where inner content is
      // independently gated (Elementor e-active) — applied by DittoWire so the gated
      // content actually appears. The gate still verifies; if it doesn't help, pruned.
      const descendants: (Record<string, CapStyle> | undefined)[] = Array(n).fill(undefined);
      for (let j = 0; j < n; j++) {
        try { await clickCap(t.tabs[j]!.triggerCap); await settle(); } catch { continue; }
        const open = await descStyles(t.tabs[j]!.panelCap);
        try { await clickCap(t.tabs[(j + 1) % n]!.triggerCap); await settle(); } catch { /* ignore */ }
        const closed = await descStyles(t.tabs[j]!.panelCap);
        const d = descDiff(open, closed);
        if (Object.keys(d).length) descendants[j] = d;
      }
      try { await clickCap(t.tabs[t.activeIndex]!.triggerCap); await settle(); } catch { /* ignore */ }
      patterns.push({
        kind: "tabs", rootCap: t.rootCap, activeIndex: t.activeIndex,
        tabs: t.tabs.map((tt, j) => ({ triggerCap: tt.triggerCap, panelCap: tt.panelCap, triggerOn: triggerOn[j]!, triggerOff: triggerOff[j]!, panelShown: panelShown[j]!, panelHidden: panelHidden[j]!, descendants: descendants[j] })),
      });
    }
  }

  // Accordion: toggle each item, read both states.
  for (const a of struct.accordions) {
    const items: AccordionSpec["items"] = [];
    for (const it of a.items) {
      const baseTrig = await readState(it.triggerCap);
      const baseReg = await readState(it.regionCap);
      if (!baseTrig || !baseReg) continue;
      try { await clickCap(it.triggerCap); await settle(); } catch { continue; }
      const togTrig = await readState(it.triggerCap);
      const togReg = await readState(it.regionCap);
      try { await clickCap(it.triggerCap); await settle(); } catch { /* ignore */ }
      if (!togTrig || !togReg) continue;
      const triggerOn = it.expandedAtBase ? baseTrig : togTrig;
      const triggerOff = it.expandedAtBase ? togTrig : baseTrig;
      const regionShown = it.expandedAtBase ? baseReg : togReg;
      const regionHidden = it.expandedAtBase ? togReg : baseReg;
      const showsByDisplay = displayDiffers(regionShown, regionHidden);
      const showsByHeight = heightToggled(regionShown, regionHidden);
      if (!showsByDisplay && !showsByHeight) continue; // didn't actually toggle — skip
      // A height-collapsed region reveals via height:auto/overflow:visible so the clone never clips a
      // reflowed answer (pinning the captured used-px could); the closed state keeps its h-0.
      const regionShownFinal: CapStyle = showsByHeight && !showsByDisplay
        ? { ...regionShown, height: "auto", overflow: "visible", maxHeight: "none" }
        : regionShown!;
      items.push({ triggerCap: it.triggerCap, regionCap: it.regionCap, expandedAtBase: it.expandedAtBase, triggerOn, triggerOff, regionShown: regionShownFinal, regionHidden });
    }
    if (items.length) patterns.push({ kind: "accordion", rootCap: a.rootCap, items });
  }

  // Carousel: capture the track's per-index transform by navigating (bullets give
  // direct index access; otherwise step with the next button). Only kept when the
  // transform actually changes across indices (a transform-track carousel — fade/
  // opacity carousels and autoplay-only widgets are out of M2/M3 scope).
  const txOf = (m: string | undefined): number => {
    if (!m || m === "none") return 0;
    const nums = m.match(/-?[\d.]+/g);
    if (!nums) return 0;
    if (m.startsWith("matrix3d")) return parseFloat(nums[12] ?? "0"); // m41
    return parseFloat(nums[4] ?? "0"); // matrix tx
  };
  const longTransition = () => page.waitForTimeout(450);
  // Read the track transform once it stops moving (carousels animate 300–600ms; a
  // mid-animation read yields garbage / false repeats). Bounded.
  const readSettledTransform = async (cap: string): Promise<string> => {
    let prev = (await readState(cap))?.transform ?? "none";
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(140);
      const cur = (await readState(cap))?.transform ?? "none";
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  };
  for (const car of struct.carousels) {
    const n = Math.min(car.slideCount, 24);
    await page.waitForTimeout(120);
    const baseTransform = await readSettledTransform(car.trackCap);
    const useBullets = car.bulletCaps.length === car.slideCount;
    let bulletOn: CapStyle = {}, bulletOff: CapStyle = {};
    const transforms: string[] = [];
    try {
      if (useBullets) {
        for (let k = 0; k < n; k++) {
          await clickCap(car.bulletCaps[k]!);
          transforms[k] = await readSettledTransform(car.trackCap);
          if (k === 1 || (n === 1 && k === 0)) {
            bulletOn = (await readState(car.bulletCaps[k]!)) ?? {};
            bulletOff = (await readState(car.bulletCaps[(k + 1) % n]!)) ?? {};
          }
        }
        await clickCap(car.bulletCaps[0]!); await longTransition(); // reset
      } else if (car.nextCap) {
        transforms.push(baseTransform);
        for (let k = 1; k < n; k++) {
          await clickCap(car.nextCap);
          const t = await readSettledTransform(car.trackCap);
          // Stop when the track revisits any captured position — it either stopped
          // advancing (end) or wrapped (loop). Keeps one clean period of distinct
          // nav positions (a looping logo/marquee carousel repeats these forever).
          if (transforms.some((p) => Math.abs(txOf(t) - txOf(p)) <= 2)) break;
          transforms.push(t);
        }
        if (car.prevCap) for (let k = 0; k < transforms.length - 1; k++) { await clickCap(car.prevCap); await longTransition(); } // reset
      }
    } catch { continue; }
    if (transforms.length < 2) continue;
    const changes = new Set(transforms.map((t) => Math.round(txOf(t)))).size > 1;
    if (!changes) continue; // not a transform-track carousel — leave static
    // Which captured index does the settled base match? (autoplay-tolerant)
    let baseIndex = 0, best = Infinity;
    for (let k = 0; k < transforms.length; k++) { const d = Math.abs(txOf(baseTransform) - txOf(transforms[k]!)); if (d < best) { best = d; baseIndex = k; } }
    patterns.push({
      kind: "carousel", rootCap: car.rootCap, trackCap: car.trackCap,
      nextCap: car.nextCap, prevCap: car.prevCap, bulletCaps: useBullets ? car.bulletCaps : [],
      baseIndex, transforms, bulletOn, bulletOff,
    });
  }

  // Disclosures: open the panel (click; if no display change, hover), find which
  // element actually toggled (the aria-controls target or an overlay ancestor),
  // capture shown/hidden + trigger styles, then close it.
  const closeAll = () => page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const chainDisplays = (controlCap: string): Promise<Array<{ cap: string; display: string }>> =>
    page.evaluate((cap) => {
      const out: Array<{ cap: string; display: string }> = [];
      let el: Element | null = document.querySelector(`[data-cid-cap="${cap}"]`);
      for (let i = 0; el && i < 5; i++) {
        const c = el.getAttribute("data-cid-cap");
        if (c) out.push({ cap: c, display: getComputedStyle(el).display });
        el = el.parentElement;
      }
      return out;
    }, controlCap);

  for (const d of struct.disclosures) {
    const items: DisclosureSpec["items"] = [];
    for (const it of d.items) {
      const before = await chainDisplays(it.controlCap);
      if (!before.length) continue;
      const baseTrig = await readState(it.triggerCap);
      // Try click, then hover, to open.
      let hoverOpen = false;
      let panelCap: string | null = null;
      const findFlip = async (): Promise<string | null> => {
        const after = await chainDisplays(it.controlCap);
        for (const b of before) {
          const a = after.find((x) => x.cap === b.cap);
          if (a && b.display === "none" && a.display !== "none") return b.cap;
        }
        return null;
      };
      try { await clickCap(it.triggerCap); await settle(); panelCap = await findFlip(); } catch { /* ignore */ }
      if (!panelCap) {
        try { await page.hover(`[data-cid-cap="${it.triggerCap}"]`, { timeout: 1000, force: true }); await settle(); panelCap = await findFlip(); if (panelCap) hoverOpen = true; } catch { /* ignore */ }
      }
      if (!panelCap) { await closeAll().catch(() => {}); continue; }
      const panelShown = await readState(panelCap);
      const shownBox = await relBoxOf(it.triggerCap, panelCap);
      const descOpen = await descStyles(panelCap);
      const trigOpen = await readState(it.triggerCap);
      // Close: dialog → its close control; else toggle trigger / Escape.
      if (it.isDialog && it.closeCaps.length) { try { await clickCap(it.closeCaps[0]!); await settle(); } catch { /* ignore */ } }
      else { try { await clickCap(it.triggerCap); await settle(); } catch { /* ignore */ } }
      await closeAll().catch(() => {});
      await page.mouse.move(1, 1).catch(() => {});
      await settle();
      const panelHidden = await readState(panelCap);
      const descendants = descDiff(descOpen, await descStyles(panelCap));
      const trigClosed = await readState(it.triggerCap);
      // panel now closed → simulate the clone's display-only reveal to confirm content
      // actually appears (rejects JS-gated/lazy panels that would open blank).
      const reproducible = await displayReproducible(panelCap, panelShown?.display ?? "block");
      if (!panelShown || !panelHidden || !reproducible || !displayDiffers(panelShown, panelHidden)) continue;
      // backdrop-close: the overlay panel is a fixed/large layer (click-outside closes).
      const backdropClose = it.isDialog && /fixed|absolute/.test(panelShown.position ?? "");
      items.push({
        triggerCap: it.triggerCap, panelCap, isDialog: it.isDialog, hoverOpen, backdropClose,
        closeCaps: it.closeCaps,
        triggerOn: trigOpen ?? baseTrig ?? {}, triggerOff: trigClosed ?? baseTrig ?? {},
        panelShown, panelHidden, shownBox,
        descendants: Object.keys(descendants).length ? descendants : undefined,
      });
    }
    if (items.length) patterns.push({ kind: "disclosure", rootCap: d.rootCap, items });
  }

  // Non-ARIA disclosures (drive-and-diff). Find elements with a real click handler
  // (via CDP) that aren't native/ARIA and aren't already part of a recognized pattern,
  // click each, and see if a hidden panel is revealed (display flip). This catches the
  // "dark matter" — JS-only modals/menus with no ARIA (e.g. casper's ugc-modal). Safe:
  // navigation is detected (URL change) and aborts discovery; only a clean, reversible
  // display flip is kept, so non-disclosure handlers (add-to-cart, analytics) are dropped.
  try {
    const nonAria = await discoverNonAriaDisclosures(page, usedCapSet(patterns), { readState, clickCap, settle, closeAll, displayDiffers, displayReproducible, relBoxOf, descStyles, descDiff, log });
    if (nonAria.length) patterns.push({ kind: "disclosure", rootCap: nonAria[0]!.triggerCap, items: nonAria });
  } catch (e) { log({ event: "interactions_nonaria_error", error: String(e).slice(0, 150) }); }

  patterns.sort((p, q) => parseInt(p.rootCap, 10) - parseInt(q.rootCap, 10));
  log({
    event: "interactions_patterns",
    tabs: patterns.filter((p) => p.kind === "tabs").length,
    accordions: patterns.filter((p) => p.kind === "accordion").length,
    carousels: patterns.filter((p) => p.kind === "carousel").length,
    disclosures: patterns.filter((p) => p.kind === "disclosure").length,
  });
  return patterns;
}

/** All trigger/panel/region/track/bullet caps already claimed by recognized patterns
 *  (so non-ARIA discovery doesn't re-drive an element a pattern already owns). */
function usedCapSet(patterns: PatternSpec[]): Set<string> {
  const s = new Set<string>();
  for (const p of patterns) {
    if (p.kind === "tabs") for (const t of p.tabs) { s.add(t.triggerCap); s.add(t.panelCap); }
    else if (p.kind === "accordion") for (const i of p.items) { s.add(i.triggerCap); s.add(i.regionCap); }
    else if (p.kind === "carousel") { s.add(p.rootCap); s.add(p.trackCap); if (p.nextCap) s.add(p.nextCap); if (p.prevCap) s.add(p.prevCap); for (const b of p.bulletCaps) s.add(b); }
    else for (const i of p.items) { s.add(i.triggerCap); s.add(i.panelCap); for (const c of i.closeCaps) s.add(c); }
  }
  return s;
}

type DriveHelpers = {
  readState: (cap: string) => Promise<CapStyle | null>;
  clickCap: (cap: string) => Promise<void>;
  settle: () => Promise<void>;
  closeAll: () => Promise<unknown>;
  displayDiffers: (a: CapStyle | null | undefined, b: CapStyle | null | undefined) => boolean;
  displayReproducible: (cap: string, shownDisplay: string) => Promise<boolean>;
  relBoxOf: (trigCap: string, panelCap: string) => Promise<RelBox | null>;
  descStyles: (panelCap: string) => Promise<Record<string, CapStyle>>;
  descDiff: (open: Record<string, CapStyle>, closed: Record<string, CapStyle>) => Record<string, CapStyle>;
  log: (e: Record<string, unknown>) => void;
};

/**
 * Drive-and-diff discovery of non-ARIA disclosures. CDP `getEventListeners` finds
 * elements with a real click/pointer handler that are neither native nor ARIA-tagged
 * and not already owned by a recognized pattern; each is clicked to see whether a
 * hidden panel is revealed (display flip). Feeds the existing disclosure pattern, so
 * preservation, generation, and the interaction gate all apply unchanged.
 */
async function discoverNonAriaDisclosures(page: Page, used: Set<string>, h: DriveHelpers): Promise<DisclosureSpec["items"]> {
  const client = await page.context().newCDPSession(page).catch(() => null);
  if (!client) return [];
  const pool: string[] = await page.evaluate((usedArr) => {
    const usedSet = new Set(usedArr);
    const NATIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL", "OPTION", "DETAILS"]);
    // A click handler doesn't always set cursor:pointer, so also admit elements whose
    // class hints at a control/trigger (the CDP listener check below is the real gate).
    const HINT = /\b(btn|button|toggle|menu|tab|accordion|card|slide|tile|thumb|trigger|open|expand|modal|dialog|dropdown|popover|drawer|overlay|nav-item)\b/i;
    const out: Array<{ id: number; cap: string }> = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const cap = el.getAttribute("data-cid-cap"); if (!cap || usedSet.has(cap)) continue;
      if (NATIVE.has(el.tagName)) continue;
      if (el.getAttribute("role") || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (cs.cursor !== "pointer" && !HINT.test(el.getAttribute("class") || "")) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0) continue;
      out.push({ id: parseInt(cap, 10), cap });
    }
    out.sort((a, b) => a.id - b.id);
    return out.slice(0, 300).map((o) => o.cap);
  }, [...used]);

  // Keep only candidates with a real click/pointer listener (CDP).
  const candidates: string[] = [];
  for (const cap of pool) {
    if (candidates.length >= 24) break;
    let oid: string | undefined;
    try {
      const ev = await client.send("Runtime.evaluate", { expression: `document.querySelector('[data-cid-cap="${cap}"]')` });
      oid = ev.result.objectId; if (!oid) continue;
      const res = await client.send("DOMDebugger.getEventListeners", { objectId: oid }) as { listeners?: Array<{ type: string }> };
      if ((res.listeners ?? []).some((l) => l.type === "click" || l.type === "mousedown" || l.type === "pointerdown")) candidates.push(cap);
    } catch { /* ignore */ }
    finally { if (oid) await client.send("Runtime.releaseObject", { objectId: oid }).catch(() => {}); }
  }

  const items: DisclosureSpec["items"] = [];
  const baseUrl = page.url();
  const deadline = Date.now() + 45000;
  const hiddenNow = (): Promise<string[]> => page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-cid-cap]"))
      .filter((el) => getComputedStyle(el).display === "none")
      .map((el) => el.getAttribute("data-cid-cap")!));

  for (const cap of candidates) {
    if (Date.now() > deadline || used.has(cap)) continue;
    try {
      const hiddenBefore = await hiddenNow();
      const trigBase = await h.readState(cap);
      await h.clickCap(cap); await h.settle();
      if (page.url() !== baseUrl) { await page.goBack().catch(() => {}); await h.settle(); break; } // navigated → stop discovery
      const revealed = await page.evaluate((before) => {
        const beforeSet = new Set(before);
        const vis = (el: Element) => { const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden") return false; const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands: Array<{ cap: string; area: number; fixed: boolean }> = [];
        for (const c of before) {
          const el = document.querySelector(`[data-cid-cap="${c}"]`); if (!el || !vis(el)) continue;
          const pcap = el.parentElement?.getAttribute("data-cid-cap");
          if (pcap && beforeSet.has(pcap)) continue; // ancestor also revealed → not the root
          const cs = getComputedStyle(el); const r = (el as HTMLElement).getBoundingClientRect();
          cands.push({ cap: c, area: r.width * r.height, fixed: cs.position === "fixed" || cs.position === "absolute" });
        }
        cands.sort((a, b) => b.area - a.area);
        return cands[0] ?? null;
      }, hiddenBefore);
      if (!revealed || revealed.area < 400) { await h.clickCap(cap).catch(() => {}); await h.closeAll().catch(() => {}); await h.settle(); continue; }
      const panelCap = revealed.cap;
      const panelShown = await h.readState(panelCap);
      const shownBox = await h.relBoxOf(cap, panelCap);
      const descOpen = await h.descStyles(panelCap);
      const trigOpen = await h.readState(cap);
      await h.clickCap(cap).catch(() => {}); await h.settle(); // toggle closed
      let panelHidden = await h.readState(panelCap);
      if (panelHidden && (panelHidden.display ?? "") !== "none") { await h.closeAll().catch(() => {}); await h.settle(); panelHidden = await h.readState(panelCap); }
      const descendants = h.descDiff(descOpen, await h.descStyles(panelCap));
      const trigClosed = await h.readState(cap);
      // panel now closed → simulate the clone's display-only reveal (rejects JS-gated/
      // lazy panels); and keep only a clean, reversible display flip (drops add-to-cart
      // / analytics / one-way handlers).
      const reproducible = await h.displayReproducible(panelCap, panelShown?.display ?? "block");
      if (!panelShown || !panelHidden || !reproducible || !h.displayDiffers(panelShown, panelHidden)) { await h.closeAll().catch(() => {}); continue; }
      const closeCaps: string[] = await page.evaluate((pc) => {
        const panel = document.querySelector(`[data-cid-cap="${pc}"]`); if (!panel) return [];
        const out: string[] = [];
        for (const c of Array.from(panel.querySelectorAll('[aria-label*="close" i],[class*="close" i]'))) { const cc = c.getAttribute("data-cid-cap"); if (cc) out.push(cc); }
        return out.slice(0, 4);
      }, panelCap);
      // A fixed full-layer overlay is a modal (open-only + backdrop/Escape close); an
      // absolutely-positioned panel is a dropdown (click toggles).
      const isModal = (panelShown.position ?? "") === "fixed";
      items.push({
        triggerCap: cap, panelCap, isDialog: isModal, hoverOpen: false, backdropClose: isModal,
        closeCaps, triggerOn: trigOpen ?? trigBase ?? {}, triggerOff: trigClosed ?? trigBase ?? {}, panelShown, panelHidden, shownBox,
        descendants: Object.keys(descendants).length ? descendants : undefined,
      });
      used.add(cap); used.add(panelCap);
    } catch { /* skip candidate */ }
  }
  h.log({ event: "interactions_nonaria", pool: pool.length, candidates: candidates.length, discovered: items.length });
  return items;
}
