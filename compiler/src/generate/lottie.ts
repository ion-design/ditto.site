import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { MotionCapture } from "../capture/motion.js";
import type { AssetGraph } from "../infer/assets.js";
import { ensureDir, writeJSONCompact, writeText } from "../util/fsx.js";
import { sha1_12 } from "../util/canonical.js";

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

function findNode(root: IRNode, id: string): IRNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    if (isTextChild(c)) continue;
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function firstSvgWithRaw(node: IRNode): IRNode | null {
  if (node.tag === "svg" && node.rawHTML) return node;
  for (const c of node.children) {
    if (isTextChild(c)) continue;
    const hit = firstSvgWithRaw(c);
    if (hit) return hit;
  }
  return null;
}

/** Write the captured lottie placeholder SVG to public/assets so gates see a stable
 *  frame via a lightweight `<img>` while DittoLottie replays the JSON at runtime. */
export function materializeLottieFrameSvgs(
  ir: IR,
  motion: MotionCapture | undefined,
  publicDir: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const map = capToCid(ir);
  for (const s of motion?.lotties ?? []) {
    const containerCid = map.get(s.cap);
    if (!containerCid) continue;
    const container = findNode(ir.root, containerCid);
    if (!container) continue;
    const svg = firstSvgWithRaw(container);
    if (!svg?.rawHTML) continue;
    const hash = sha1_12(svg.rawHTML);
    const rel = `/assets/cloned/lottie/frame-${hash}.svg`;
    const abs = join(publicDir, rel.slice(1));
    if (!existsSync(abs)) {
      ensureDir(join(publicDir, "assets", "cloned", "lottie"));
      writeText(abs, svg.rawHTML);
    }
    out.set(svg.id, rel);
  }
  return out;
}

export type RTLottie = {
  cid: string;
  renderer: "svg" | "canvas";
  loop: boolean;
  autoplay: boolean;
  path: string; // public-relative URL of the materialized .json
  width: number;
  height: number;
};

export type LottieSpec = { items: RTLottie[] };

/** Write inline lottie JSON (from capture) to public/assets/cloned/lottie/*.json so
 *  generation never embeds multi-MB animationData in page.tsx / RSC flight. Returns
 *  inlineKey → public path. Idempotent: same JSON → same hash filename. */
export function materializeInlineLottieJson(
  motion: MotionCapture | undefined,
  publicDir: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const inline = motion?.lottieInline ?? {};
  for (const s of motion?.lotties ?? []) {
    if (!s.inlineKey || !Object.prototype.hasOwnProperty.call(inline, s.inlineKey)) continue;
    const data = inline[s.inlineKey]!;
    const hash = sha1_12(JSON.stringify(data));
    const rel = `/assets/cloned/lottie/${hash}.json`;
    const abs = join(publicDir, rel.slice(1));
    if (!existsSync(abs)) {
      ensureDir(join(publicDir, "assets", "cloned", "lottie"));
      writeJSONCompact(abs, data);
    }
    out.set(s.inlineKey, rel);
  }
  return out;
}

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
  inlinePaths?: Map<string, string>,
): LottieSpec {
  const lotties = motion?.lotties ?? [];
  if (!lotties.length) return { items: [] };
  const map = capToCid(ir);
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
    if (!path && s.inlineKey && inlinePaths?.has(s.inlineKey)) path = inlinePaths.get(s.inlineKey)!;
    if (!path) continue; // nothing reproducible without a local .json path

    items.push({
      cid,
      renderer: s.renderer === "canvas" ? "canvas" : "svg",
      loop: s.loop,
      autoplay: s.autoplay,
      path,
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
  // Path-only wire — never embed animation JSON (keeps page.tsx + RSC flight small).
  return `${pad}<DittoLottie items={${JSON.stringify(spec.items)}} />`;
}

export const DITTO_LOTTIE_TSX = `"use client";
import { useEffect } from "react";

type RTLottie = {
  cid: string;
  renderer: "svg" | "canvas";
  loop: boolean;
  autoplay: boolean;
  path: string;
  width: number;
  height: number;
};

const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');

export default function DittoLottie({ items }: { items: RTLottie[] }) {
  useEffect(() => {
    const stopped = (window as any).__dittoMotionStopped === true;
    if (stopped) return; // gates grade the static img/svg frame baked into the SSR markup
    const anims: Array<{ destroy: () => void; goToAndStop: (value: number, isFrame?: boolean) => void }> = [];
    let cancelled = false;
    void (async () => {
      const lottie = (await import("lottie-web")).default;
      if (cancelled) return;
      for (const it of items) {
        const el = byCid(it.cid);
        if (!el || !it.path) continue;
        // clear the captured placeholder frame so it never stacks with the live render
        el.innerHTML = "";
        try {
          const anim = lottie.loadAnimation({
            container: el,
            renderer: it.renderer === "canvas" ? "canvas" : "svg",
            loop: it.loop,
            autoplay: it.autoplay,
            path: it.path,
            rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
          });
          anims.push(anim);
        } catch {
          /* a single bad animation must not break the page */
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; for (const a of anims) { try { a.destroy(); } catch {} } };
  }, [items]);
  return null;
}
`;
