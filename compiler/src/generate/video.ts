import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { InteractionCapture } from "../capture/interactions.js";

/**
 * Stage 4 — video-player controller. A recognized poster + play mockup is replayed by
 * one fixed `'use client'` component, `DittoVideo`: on click of the captured play
 * trigger it applies the captured overlay-hidden styles and starts the media INLINE,
 * inside the mockup frame — an embed iframe gets its captured player URL (the static
 * base ships the iframe src-less, so nothing third-party loads until the user clicks;
 * the click is the user gesture that permits autoplay), a local <video> is played
 * directly. Mirrors the DittoWire contract: renders null and applies NOTHING on mount,
 * so the base render (poster, play affordance) is untouched.
 */

export type RTVideoOverlay = { target: string; hide: Record<string, string> };
export type RTVideo = {
  trigger: string;
  overlays: RTVideoOverlay[];
  media: { target: string; kind: "iframe" | "video"; embedUrl: string | null };
};
export type VideoSpec = { items: RTVideo[] };

/** The captured player URL with autoplay requested — pure and unit-testable. */
export function withAutoplayParam(url: string): string {
  if (/[?&]autoplay=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "autoplay=1";
}

const capToCid = (ir: IR): Map<string, string> => {
  const m = new Map<string, string>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) m.set(cap, n.id);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return m;
};

/** Resolve cap-keyed video captures to cids that survived into this IR (optionally
 *  scoped by an include filter). A player whose trigger or media was pruned is dropped
 *  (stays a static poster); overlays keep only surviving cids. */
export function buildVideoSpec(ir: IR, interaction: InteractionCapture | undefined, include?: (cid: string) => boolean): VideoSpec {
  const videos = interaction?.videos ?? [];
  if (!videos.length) return { items: [] };
  const map = capToCid(ir);
  const ok = (cid: string | undefined): cid is string => !!cid && (!include || include(cid));
  const items: RTVideo[] = [];
  for (const v of videos) {
    const trigger = map.get(v.triggerCap);
    const media = map.get(v.media.cap);
    if (!ok(trigger) || !ok(media)) continue;
    const overlays: RTVideoOverlay[] = [];
    for (const o of v.overlays) {
      const cid = map.get(o.cap);
      if (!ok(cid)) continue;
      overlays.push({ target: cid, hide: o.hide });
    }
    if (!overlays.length) continue; // nothing to reveal — the static poster is already the whole story
    items.push({ trigger, overlays, media: { target: media, kind: v.media.kind, embedUrl: v.media.embedUrl } });
  }
  items.sort((a, b) => a.trigger.localeCompare(b.trigger));
  return { items };
}

export function videoHasContent(spec: VideoSpec): boolean {
  return spec.items.length > 0;
}

export function dittoVideoImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/DittoVideo";
}

export function videoWireJsx(spec: VideoSpec, indent: number): string {
  if (!videoHasContent(spec)) return "";
  const pad = "  ".repeat(indent);
  return `${pad}<DittoVideo spec={${JSON.stringify(spec)}} />`;
}

export const DITTO_VIDEO_TSX = `"use client";
import { useEffect } from "react";

type RTVideoOverlay = { target: string; hide: Record<string, string> };
type RTVideo = {
  trigger: string;
  overlays: RTVideoOverlay[];
  media: { target: string; kind: "iframe" | "video"; embedUrl: string | null };
};
export type VideoSpec = { items: RTVideo[] };

const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');
const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

const withAutoplay = (url: string): string =>
  /[?&]autoplay=/.test(url) ? url : url + (url.includes("?") ? "&" : "?") + "autoplay=1";

/** Plays a recognized poster+play video mockup INLINE on click: hides the captured
 *  overlay elements and starts the media inside the mockup frame. Applies NOTHING on
 *  mount — the static poster render is untouched until the user clicks. */
export default function DittoVideo({ spec }: { spec: VideoSpec }) {
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    for (const item of spec.items) {
      const trig = byCid(item.trigger);
      if (!trig) continue;
      const play = (e: Event) => {
        e.preventDefault();
        for (const o of item.overlays) {
          const el = byCid(o.target);
          if (!el) continue;
          for (const k in o.hide) el.style.setProperty(kebab(k), o.hide[k]);
        }
        const media = byCid(item.media.target);
        if (!media) return;
        if (item.media.kind === "iframe" && item.media.embedUrl) {
          media.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
          media.setAttribute("src", withAutoplay(item.media.embedUrl));
        } else if (item.media.kind === "video") {
          const v = media as HTMLVideoElement;
          v.controls = true;
          v.muted = false;
          void v.play().catch(() => { /* stays on poster frame with controls */ });
        }
      };
      trig.addEventListener("click", play, { signal });
    }
    return () => ac.abort();
  }, [spec]);
  return null;
}
`;
