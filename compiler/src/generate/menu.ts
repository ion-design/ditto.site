import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { MenuCapture } from "../capture/interactions.js";

/**
 * M4b — mount-on-open menus (Radix-style portals). The panel is added to the DOM on open
 * and removed on close, so the IR never sees it and the IR-based disclosure path can't
 * reproduce it. Instead the panel is captured as a self-contained inline-styled fragment
 * and reproduced CLIENT-SIDE: `DropdownMenu` renders null on mount and only injects the panel
 * (under its trigger) on interaction — so the server-rendered base that gates 0–6 grade is
 * structurally untouched (same safety model as DittoWire). A menu that doesn't reproduce is
 * pruned by the interaction gate, so a broken menu is never shipped.
 */

const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export type RTMenu = { trigger: string; hoverOpen: boolean; gap: number; align: "left" | "right"; html: string };

function capToNode(ir: IR): Map<string, IRNode> {
  const m = new Map<string, IRNode>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) m.set(cap, n);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return m;
}

function textContent(n: IRNode, max = 120): string {
  let out = "";
  const walk = (node: IRNode): void => {
    if (out.length >= max) return;
    for (const c of node.children) {
      if (isTextChild(c)) out += " " + c.text;
      else walk(c);
      if (out.length >= max) return;
    }
  };
  walk(n);
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function isLikelySkipTrigger(n: IRNode, menu: MenuCapture): boolean {
  const label = `${textContent(n, 120)} ${n.attrs["aria-label"] ?? ""}`.toLowerCase();
  const href = (n.attrs.href ?? "").trim();
  if (/\bskip\s+(?:to\s+)?(?:content|main|navigation)\b/.test(label)) return true;
  return href.startsWith("#") && menu.gap > 360;
}

/** Rewrite the captured panel HTML so the clone stays self-contained: same-origin links
 *  become app-relative (via the page's linkRewrite), and every image src resolves to a
 *  local asset or a transparent placeholder — never a remote origin (rubric Gate 2). */
function rewriteHtml(html: string, assetMap: Map<string, string>, sourceUrl: string, linkRewrite?: (href: string) => string): string {
  const resolve = (u: string): string => { try { return new URL(u, sourceUrl).href; } catch { return u; } };
  let out = html.replace(/\bsrc="([^"]*)"/g, (_m, u: string) => {
    const local = assetMap.get(resolve(u));
    return `src="${local ?? TRANSPARENT_GIF}"`;
  });
  if (linkRewrite) out = out.replace(/\bhref="([^"]*)"/g, (_m, u: string) => `href="${linkRewrite(u).replace(/"/g, "&quot;")}"`);
  return out;
}

export function buildMenuSpecs(
  ir: IR,
  menus: MenuCapture[] | undefined,
  assetMap: Map<string, string>,
  sourceUrl: string,
  linkRewrite?: (href: string) => string,
  include?: (cid: string) => boolean,
): RTMenu[] {
  if (!menus || !menus.length) return [];
  const map = capToNode(ir);
  const out: RTMenu[] = [];
  for (const m of menus) {
    const trigger = map.get(m.triggerCap);
    if (!trigger) continue; // trigger pruned from the IR → drop
    if (isLikelySkipTrigger(trigger, m)) continue;
    if (include && !include(trigger.id)) continue;
    out.push({ trigger: trigger.id, hoverOpen: m.hoverOpen, gap: m.gap, align: m.align, html: rewriteHtml(m.html, assetMap, sourceUrl, linkRewrite) });
  }
  return out;
}

export function menusJsx(menus: RTMenu[], indent: number): string {
  if (!menus.length) return "";
  const pad = "  ".repeat(indent);
  return `${pad}<DropdownMenu menus={${JSON.stringify(menus)}} />`;
}

export function dropdownMenuImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/DropdownMenu";
}

/** The fixed DropdownMenu client component, written once per generated app. */
export const DROPDOWN_MENU_TSX = `"use client";
import { useEffect } from "react";

type RTMenu = { trigger: string; hoverOpen: boolean; gap: number; align: "left" | "right"; html: string };
const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');

/** Reproduces mount-on-open dropdown/nav menus: renders nothing and applies NOTHING on mount; only on
 *  user interaction does it inject the captured panel fragment under its trigger. The base
 *  render is therefore unchanged. */
export default function DropdownMenu({ menus }: { menus: RTMenu[] }) {
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    const openPanels: HTMLElement[] = [];
    for (const m of menus) {
      const trig = byCid(m.trigger);
      if (!trig) continue;
      let panel: HTMLElement | null = null;
      const place = () => {
        if (!panel) return;
        const r = trig.getBoundingClientRect();
        panel.style.position = "absolute";
        panel.style.top = (r.bottom + window.scrollY + m.gap) + "px";
        if (m.align === "right") { panel.style.left = ""; panel.style.right = (document.documentElement.clientWidth - (r.right + window.scrollX)) + "px"; }
        else { panel.style.right = ""; panel.style.left = (r.left + window.scrollX) + "px"; }
        panel.style.zIndex = "9999";
      };
      const open = () => {
        if (panel) return;
        const wrap = document.createElement("div");
        wrap.innerHTML = m.html;
        panel = wrap.firstElementChild as HTMLElement | null;
        if (!panel) return;
        document.body.appendChild(panel);
        openPanels.push(panel);
        place();
        trig.setAttribute("aria-expanded", "true");
      };
      const close = () => {
        if (panel) {
          const i = openPanels.indexOf(panel);
          if (i !== -1) openPanels.splice(i, 1);
          panel.remove();
          panel = null;
        }
        trig.setAttribute("aria-expanded", "false");
      };
      const toggle = () => (panel ? close() : open());
      if (m.hoverOpen) {
        const root = trig.parentElement ?? trig;
        root.addEventListener("mouseenter", open, { signal });
        root.addEventListener("mouseleave", close, { signal });
      } else {
        trig.addEventListener("click", (e) => { e.preventDefault(); toggle(); }, { signal });
      }
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }, { signal });
      document.addEventListener("click", (e) => {
        const t = e.target as Node;
        if (panel && !trig.contains(t) && !panel.contains(t)) close();
      }, { signal });
      window.addEventListener("resize", place, { signal });
      window.addEventListener("scroll", place, { passive: true, signal });
    }
    (window as any).__dittoMenuReady = true; // wiring done — lets the gate drive deterministically
    return () => {
      ac.abort();
      // Remove any still-open panels appended to document.body so unmount leaves no orphan nodes.
      for (const p of openPanels.splice(0)) p.remove();
    };
  }, [menus]);
  return null;
}
`;
