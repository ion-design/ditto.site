import type { Page } from "playwright";

/**
 * Stage 5 motion capture — Lottie subset.
 *
 * lottie-web (a.k.a. bodymovin) renders vector animations from a JSON document into an
 * SVG/canvas/HTML subtree at runtime. It is third-party JavaScript, so the declarative CSS
 * path and the WAAPI/reveal/marquee probes in `motion.ts` never reproduce it — the cloned
 * page ships the empty container and the animation is simply gone. This probe records the
 * deterministic subset we CAN reproduce: the animation's source JSON (the actual
 * `animationData` document, or the URL it was fetched from) plus the playback config
 * (renderer, loop, autoplay), keyed to the container's `data-cid-cap` so generation can
 * re-mount a fixed lottie-web instance on the cloned node.
 *
 * Detection is layered, most-reliable first, deduped by `data-cid-cap`:
 *   1. lottie-web's own registry (`window.lottie.getRegisteredAnimations()` / `bodymovin`)
 *      — yields the live `AnimationItem`, which carries the parsed `animationData`, its
 *      source `path`, the renderer type, and loop/autoplay. The gold path: the JSON is
 *      already in memory, no second fetch required.
 *   2. Web components — `<lottie-player>` / `<dotlottie-player>` (the `src` attribute).
 *   3. Elementor Pro Lottie widgets — `[data-settings]` JSON → `lottie.source_json.url`.
 *   4. Generic markup — elements whose class matches /lottie/ carrying a data-* URL.
 *
 * Output is JSON-safe and threads through the IR exactly like the other motion specs. When
 * a source URL exists it is recorded for the asset stage to download + localize; when the
 * JSON is only available inline (data-driven init) the `animationData` is stashed directly
 * (size-capped) so the pipeline can write it out as a local `.json` asset.
 */

export type LottieRenderer = "svg" | "canvas" | "html";

export type LottieSpec = {
  cap: string; // data-cid-cap of the lottie container (→ cid at generation)
  via: "registry" | "player" | "elementor" | "attr"; // how it was detected (for diagnostics)
  src: string | null; // absolute URL of the source .json, when known (preferred → asset download)
  inlineKey: string | null; // key into the returned `inline` map when JSON is only in-memory
  renderer: LottieRenderer;
  loop: boolean;
  autoplay: boolean;
  // observed box, so generation can size the re-mounted player even before the JSON loads
  width: number;
  height: number;
};

export type LottieCapture = {
  lotties: LottieSpec[];
  // animationData documents only available in-memory (no fetchable URL), keyed by inlineKey.
  // The asset stage materializes these to local `.json` files; src-backed specs skip this.
  inline: Record<string, unknown>;
};

const EMPTY: LottieCapture = { lotties: [], inline: {} };

/**
 * Captures lottie-web animations on the current page. Run at the canonical viewport AFTER
 * `tagElements` (so containers carry `data-cid-cap`). lottie can initialize late (deferred
 * bundles, `arriving_to_viewport` triggers), so the probe polls briefly within `budgetMs`
 * for the registry to populate before falling back to static markup scans.
 */
export async function captureLotties(
  page: Page,
  opts?: { budgetMs?: number; maxInlineBytes?: number; log?: (e: Record<string, unknown>) => void },
): Promise<LottieCapture> {
  const log = opts?.log ?? (() => {});
  const budgetMs = opts?.budgetMs ?? 2600;
  const maxInlineBytes = opts?.maxInlineBytes ?? 3_000_000; // skip absurdly large inline blobs

  try {
    const result = await Promise.race([
      page.evaluate(
        async ({ budget, maxInline }: { budget: number; maxInline: number }) => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const out: Array<{
            cap: string;
            via: "registry" | "player" | "elementor" | "attr";
            src: string | null;
            inlineKey: string | null;
            renderer: "svg" | "canvas" | "html";
            loop: boolean;
            autoplay: boolean;
            width: number;
            height: number;
          }> = [];
          const inline: Record<string, unknown> = {};
          const seen = new Set<string>(); // dedup by cap
          let inlineN = 0;

          const abs = (u: string | null | undefined): string | null => {
            if (!u || typeof u !== "string") return null;
            try { return new URL(u, document.baseURI).href; } catch { return null; }
          };
          // climb to the nearest ancestor (or self) carrying a data-cid-cap
          const capOf = (node: Element | null): string | null => {
            let el: Element | null = node;
            while (el && !el.getAttribute?.("data-cid-cap")) el = el.parentElement;
            return el?.getAttribute?.("data-cid-cap") ?? null;
          };
          const boxOf = (el: Element | null): { width: number; height: number } => {
            try { const r = (el as HTMLElement)?.getBoundingClientRect?.(); return { width: Math.round(r?.width ?? 0), height: Math.round(r?.height ?? 0) }; } catch { return { width: 0, height: 0 }; }
          };
          const stashInline = (data: unknown): string | null => {
            try {
              const s = JSON.stringify(data);
              if (!s || s.length > maxInline) return null;
              const key = "lottie_inline_" + inlineN++;
              inline[key] = JSON.parse(s); // ensure JSON-safe, structured-clone friendly
              return key;
            } catch { return null; }
          };
          const push = (rec: {
            container: Element | null; via: "registry" | "player" | "elementor" | "attr";
            src: string | null; inlineKey: string | null;
            renderer: string | null | undefined; loop: unknown; autoplay: unknown;
          }) => {
            const cap = capOf(rec.container);
            if (!cap || seen.has(cap)) return;
            if (!rec.src && !rec.inlineKey) return; // nothing reproducible
            seen.add(cap);
            const r = (rec.renderer || "svg").toString().toLowerCase();
            const renderer: "svg" | "canvas" | "html" = r === "canvas" ? "canvas" : r === "html" ? "html" : "svg";
            const box = boxOf(rec.container);
            out.push({
              cap, via: rec.via, src: rec.src, inlineKey: rec.inlineKey, renderer,
              loop: rec.loop === undefined ? true : !!rec.loop,
              autoplay: rec.autoplay === undefined ? true : !!rec.autoplay,
              width: box.width, height: box.height,
            });
          };

          // ---- 1. lottie-web registry (poll for late init within the budget) ----
          const readRegistry = () => {
            const w = window as unknown as {
              lottie?: { getRegisteredAnimations?: () => unknown[] };
              bodymovin?: { getRegisteredAnimations?: () => unknown[] };
            };
            const lib = w.lottie || w.bodymovin;
            const anims = (lib?.getRegisteredAnimations?.() as Array<Record<string, unknown>>) || [];
            for (const a of anims) {
              const wrapper = (a.wrapper as Element) || ((a.renderer as { svgElement?: Element })?.svgElement) || null;
              const container = wrapper instanceof Element ? wrapper : null;
              if (!container) continue;
              if (seen.has(capOf(container) || "")) continue;
              // source: prefer a fetchable URL (path is the directory, fileName the file);
              // fall back to the in-memory animationData document.
              const path = (a.path as string) || "";
              const fileName = (a.fileName as string) || "";
              let src: string | null = null;
              if (path) src = abs(path.endsWith("/") || !fileName ? path + (fileName.endsWith(".json") ? fileName : "data.json") : path + (fileName ? (fileName.includes(".") ? fileName : fileName + ".json") : ""));
              let inlineKey: string | null = null;
              if (!src && a.animationData) inlineKey = stashInline(a.animationData);
              const rendererType = ((a.renderer as { rendererType?: string })?.rendererType)
                || (a.renderer && a.renderer.constructor && a.renderer.constructor.name === "CanvasRenderer" ? "canvas" : undefined);
              push({ container, via: "registry", src, inlineKey, renderer: rendererType, loop: a.loop, autoplay: a.autoplay });
            }
          };
          const deadline = Date.now() + budget;
          do {
            readRegistry();
            if (out.length) break; // got something from the registry; static scans below still run once
            await sleep(200);
          } while (Date.now() < deadline);

          // ---- 2. <lottie-player> / <dotlottie-player> web components ----
          document.querySelectorAll("lottie-player, dotlottie-player").forEach((el) => {
            const src = abs(el.getAttribute("src") || el.getAttribute("data-src"));
            let inlineKey: string | null = null;
            if (!src) {
              try {
                const data = (el as unknown as { getLottie?: () => { animationData?: unknown } }).getLottie?.()?.animationData;
                if (data) inlineKey = stashInline(data);
              } catch { /* ignore */ }
            }
            push({
              container: el, via: "player", src, inlineKey,
              renderer: el.getAttribute("renderer"),
              loop: el.hasAttribute("loop") || el.getAttribute("loop") === "true",
              autoplay: el.hasAttribute("autoplay") || el.getAttribute("autoplay") === "true",
            });
          });

          // ---- 3. Elementor Pro Lottie widgets ----
          document.querySelectorAll(".elementor-widget-lottie [data-settings], [data-widget_type^='lottie'] [data-settings], .e-lottie__animation").forEach((el) => {
            let settingsHost: Element | null = el;
            // settings live on the widget root; climb if we matched the inner animation node
            if (!settingsHost.getAttribute("data-settings")) settingsHost = el.closest("[data-settings]");
            let src: string | null = null;
            let renderer: string | null = null;
            let loop: unknown = true;
            let autoplay: unknown = true;
            try {
              const raw = settingsHost?.getAttribute("data-settings");
              if (raw) {
                const s = JSON.parse(raw) as Record<string, unknown>;
                const l = (s.lottie as Record<string, unknown>) || s;
                const sj = (l.source_json as Record<string, unknown>) || {};
                src = abs((sj.url as string) || (l.source_external_url as string) || (l.lottie_url as string));
                renderer = (l.renderer as string) || (s.renderer as string) || null;
                if ("loop" in l) loop = (l.loop as string) !== "no" && !!l.loop;
                if ("trigger" in l) autoplay = true; // static host: ignore arriving_to_viewport, autoplay
              }
            } catch { /* ignore */ }
            push({ container: el, via: "elementor", src, inlineKey: null, renderer, loop, autoplay });
          });

          // ---- 4. Generic markup fallback ----
          document.querySelectorAll("[class*='lottie'],[data-animation-type='lottie']").forEach((el) => {
            if (seen.has(capOf(el) || "")) return;
            const src = abs(
              el.getAttribute("data-src") || el.getAttribute("data-animation-path")
              || el.getAttribute("data-animation_url") || el.getAttribute("data-lottie")
            );
            if (!src) return;
            push({ container: el, via: "attr", src, inlineKey: null, renderer: el.getAttribute("data-renderer"), loop: true, autoplay: true });
          });

          return { lotties: out, inline };
        },
        { budget: budgetMs, maxInline: maxInlineBytes },
      ),
      new Promise<LottieCapture>((resolve) => setTimeout(() => resolve(EMPTY), budgetMs + 1500)),
    ]);

    const cap = (result as LottieCapture) || EMPTY;
    log({ stage: "lottie", found: cap.lotties.length, inline: Object.keys(cap.inline).length });
    return cap;
  } catch (e) {
    log({ stage: "lottie", error: String((e as Error)?.message ?? e) });
    return EMPTY;
  }
}
