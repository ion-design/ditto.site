import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { MotionCapture } from "../capture/motion.js";
import type { AssetGraph } from "../infer/assets.js";

/**
 * Stage 5 motion controller — Lottie subset. lottie-web renders a JSON document into an
 * SVG/canvas subtree at runtime; it is third-party JS, so neither the declarative CSS path
 * nor `DittoMotion` reproduce it. This emits one fixed `'use client'` component,
 * `DittoLottie`, that re-mounts a lottie-web instance on the cid'd container using the
 * captured source — the materialized local `.json` (preferred) or, when the animation was
 * only ever in memory, the inline `animationData` embedded in the spec.
 *
 * Mirrors the DittoMotion contract: it DOES start on mount (the clone replays motion), and
 * it honors the validator's measurement hook — when `window.__dittoMotionStopped` is set it
 * mounts a single static frame so gates that grade the settled base still see a stable
 * picture. The container is cleared before mount so the captured placeholder frame and the
 * live animation never stack (the duplicate-render failure mode of naive mirror shims).
 */

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

export type RTLottie = {
  cid: string;
  renderer: "svg" | "canvas";
  loop: boolean;
  autoplay: boolean;
  path: string | null; // public-relative URL of the materialized .json (preferred)
  animationData: unknown | null; // inline JSON, only when no fetchable URL existed
  width: number;
  height: number;
};

export type LottieSpec = { items: RTLottie[] };

/**
 * Resolve captured lottie specs (keyed by data-cid-cap, with a source URL or inline-data
 * key) to runtime specs keyed by cid, with the URL rewritten to its materialized local
 * path. Specs whose node didn't survive pruning, or whose JSON neither downloaded nor has
 * inline data, are dropped — only reproducible animations are emitted.
 */
export function buildLottieSpec(
  ir: IR,
  motion: MotionCapture | undefined,
  assetGraph: AssetGraph,
  include?: (cid: string) => boolean,
): LottieSpec {
  const lotties = motion?.lotties ?? [];
  if (!lotties.length) return { items: [] };
  const map = capToCid(ir);
  const inline = motion?.lottieInline ?? {};
  const ok = (cid: string | undefined): cid is string => !!cid && (!include || include(cid));
  const items: RTLottie[] = [];

  for (const s of lotties) {
    const cid = map.get(s.cap);
    if (!ok(cid)) continue;

    let path: string | null = null;
    if (s.src) {
      const entry = assetGraph.byUrl.get(s.src);
      if (entry && entry.classification === "downloaded" && entry.localPath) path = entry.localPath;
    }
    let animationData: unknown | null = null;
    if (!path && s.inlineKey && Object.prototype.hasOwnProperty.call(inline, s.inlineKey)) {
      animationData = inline[s.inlineKey] ?? null;
    }
    if (!path && animationData == null) continue; // nothing reproducible

    items.push({
      cid,
      renderer: s.renderer === "canvas" ? "canvas" : "svg",
      loop: s.loop,
      autoplay: s.autoplay,
      path,
      animationData,
      width: s.width,
      height: s.height,
    });
  }
  // deterministic order
  items.sort((a, b) => a.cid.localeCompare(b.cid));
  return { items };
}

export function lottieHasContent(spec: LottieSpec): boolean {
  return spec.items.length > 0;
}

export function dittoLottieImportPath(depth: number): string {
  return (depth === 0 ? "./" : "../".repeat(depth)) + "ditto/DittoLottie";
}

export function lottieWireJsx(spec: LottieSpec, indent: number): string {
  if (!lottieHasContent(spec)) return "";
  const pad = "  ".repeat(indent);
  return `${pad}<DittoLottie spec={${JSON.stringify(spec)}} />`;
}

export const DITTO_LOTTIE_TSX = `"use client";
import { useEffect } from "react";

type RTLottie = {
  cid: string;
  renderer: "svg" | "canvas";
  loop: boolean;
  autoplay: boolean;
  path: string | null;
  animationData: unknown | null;
  width: number;
  height: number;
};
export type LottieSpec = { items: RTLottie[] };

const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');

export default function DittoLottie({ spec }: { spec: LottieSpec }) {
  useEffect(() => {
    const stopped = (window as any).__dittoMotionStopped === true;
    const anims: Array<{ destroy: () => void; goToAndStop: (value: number, isFrame?: boolean) => void; addEventListener: (name: string, cb: () => void) => void }> = [];
    let cancelled = false;
    void (async () => {
      const lottie = (await import("lottie-web")).default;
      if (cancelled) return;
      for (const it of spec.items) {
        const el = byCid(it.cid);
        if (!el) continue;
        try {
          // Mount the live animation into an OVERLAY child, keeping the captured placeholder
          // frame in the DOM until lottie signals a successful load — a failed load (bad JSON,
          // network) then leaves the placeholder intact instead of erasing the container to blank.
          const mount = document.createElement("div");
          mount.style.position = "absolute";
          mount.style.inset = "0";
          mount.style.opacity = "0";
          const cs = getComputedStyle(el);
          if (cs.position === "static") el.style.position = "relative";
          el.appendChild(mount);
          const anim = lottie.loadAnimation({
            container: mount,
            renderer: it.renderer === "canvas" ? "canvas" : "svg",
            loop: it.loop,
            autoplay: it.autoplay && !stopped,
            ...(it.path ? { path: it.path } : { animationData: it.animationData as object }),
            rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
          });
          // Swap only once the animation is genuinely ready: reveal the live render and remove
          // every original child (the placeholder) so the two never stack. Before discarding the
          // placeholder, forward its data-cid onto the runtime-rendered svg/canvas so the media
          // node stays addressable by cid after the swap (it would otherwise mount without one).
          const reveal = () => {
            mount.style.opacity = "1";
            // The captured placeholder is an svg/canvas (or wraps one) carrying its own data-cid.
            let placeholderCid: string | null = null;
            for (const child of Array.from(el.childNodes)) {
              if (child === mount || placeholderCid !== null || !(child instanceof Element)) continue;
              const media = child.matches("svg, canvas") ? child : child.querySelector("svg, canvas");
              placeholderCid = (media ?? child).getAttribute("data-cid");
            }
            for (const child of Array.from(el.childNodes)) if (child !== mount) el.removeChild(child);
            if (placeholderCid) {
              const rendered = mount.querySelector("svg, canvas");
              if (rendered) rendered.setAttribute("data-cid", placeholderCid);
            }
            mount.style.position = "";
            mount.style.inset = "";
          };
          // DOMLoaded fires only after the JSON parsed and the first frame rendered — the
          // right moment to reveal the live render and drop the placeholder. data_failed
          // (bad JSON / fetch error) tears the empty mount back out, leaving the placeholder.
          anim.addEventListener("DOMLoaded", reveal);
          anim.addEventListener("data_failed", () => { try { el.removeChild(mount); } catch {} });
          if (stopped) { try { anim.goToAndStop(0, true); } catch {} }
          anims.push(anim);
        } catch {
          /* a single bad animation must not break the page */
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; for (const a of anims) { try { a.destroy(); } catch {} } };
  }, [spec]);
  return null;
}
`;
