import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { collectPage, type PageSnapshot, type FontFace } from "./walker.js";
import { tagElements, captureInteractions, type InteractionCapture } from "./interactions.js";
import { captureMotion, probeReveals, type MotionCapture } from "./motion.js";
import { discoverBreakpoints } from "./breakpoints.js";
import { writeJSON, writeJSONCompact, writeBytes, ensureDir } from "../util/fsx.js";
import { sha1_12, round } from "../util/canonical.js";
import { scrollForLazyLoad, preScreenshotSettle } from "../settle/recipe.js";
import { isWallText } from "../util/wallText.js";
import { writeLiveWitnessViewport, liveWitnessDir } from "../evidence/liveWitness.js";
import { baseEvidenceManifest, writeEvidenceManifest } from "../evidence/manifest.js";
import { hashAssetStore } from "../materialize/manifest-hash.js";

export const REQUIRED_VIEWPORTS = [375, 768, 1280, 1920] as const;
// The dense width set captured for SIZE INFERENCE: a node sampled at 9 widths reveals its sizing
// law (constant / proportional / clamped / flex-distributed) far better than 4 — enough to drop a
// baked px for a relative construct with confidence (and to surface a shrunk item's natural size,
// which needs widths beyond 1920). REQUIRED_VIEWPORTS ⊂ this; only those 4 carry responsive bands.
export const SAMPLE_VIEWPORTS = [375, 480, 640, 768, 1024, 1280, 1536, 1920, 2560] as const;

const VIEWPORT_HEIGHTS: Record<number, number> = {
  375: 812,
  480: 854,
  640: 960,
  768: 1024,
  1024: 768,
  1280: 800,
  1536: 864,
  1920: 1080,
  2560: 1440,
};

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Defines esbuild/tsx runtime helpers in the page so serialized evaluate
// callbacks that reference them don't throw ReferenceError.
/** Neutralize the two entropy sources page JS can render from, BEFORE any page
 *  script runs: Math.random becomes a seeded PRNG (mulberry32), and the wall
 *  clock is shifted so every capture starts at the same epoch — while still
 *  advancing, so elapsed-time logic (animations, lazy-load timers) behaves.
 *  Raw string: it must not be transformed by tsx/esbuild. */
const DETERMINISTIC_ENV_SHIM = `(() => {
  let s = 0x9e3779b9;
  Math.random = function() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RealDate = Date;
  const delta = 1767225600000 - RealDate.now(); /* pin start to 2026-01-01T00:00:00Z */
  class DittoDate extends RealDate {
    constructor(...args) { args.length ? super(...args) : super(RealDate.now() + delta); }
    static now() { return RealDate.now() + delta; }
  }
  DittoDate.parse = RealDate.parse;
  DittoDate.UTC = RealDate.UTC;
  globalThis.Date = DittoDate;
})();`;

const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

export type DiscoveredAsset = {
  url: string;
  type: string; // image|svg|video|font|lottie|css|manifest|other
  contentType: string | null;
  status: number | null;
  storedAs: string | null; // sha1-named file in assets-store, or null if not downloaded
  bytes: number; // size of stored file
  via: string[]; // discovery sources
};

export type SeoResource = {
  kind: "robots" | "sitemap" | "llms" | "llms-full";
  url: string;
  status: number | null;
  contentType: string | null;
  text?: string;
};

export type CaptureResult = {
  sourceUrl: string;
  capturedAt: string;
  viewports: number[];
  // Browser-as-oracle: the widths where the SOURCE layout actually restructures (display /
  // flex-direction / wrap / grid-track-count / position / visibility flips), found by sweeping the
  // viewport and binary-searching each discrete-signature change. Ground truth for the real
  // responsive band edges — distinct from REQUIRED_VIEWPORTS (our fixed capture widths). Absent if
  // discovery was disabled or the sweep failed. See breakpoints.ts.
  breakpoints?: number[];
  perViewport: Array<{
    viewport: number;
    height: number;
    scrollHeight: number;
    nodeCount: number;
    truncated: boolean;
    overlaysRemaining?: number;
    blocking?: boolean;
    quiescent?: boolean;
  }>;
  assets: DiscoveredAsset[];
  seoResources?: SeoResource[];
  fontFaces: FontFace[];
  cssTexts: string[]; // sha1 names of stored css files
  // Stage 2: overlay/popup dismissal audit (union of actions across viewports).
  dismissal?: { dismissed: string[]; overlaysRemaining: number; removed: number; videoStills: number; blocking: boolean };
  // Stage 4: optional interaction capture (hover/focus + recognized patterns).
  interaction?: InteractionCapture;
  // Stage 5: optional motion capture (WAAPI animations + rotating text). CSS @keyframes
  // motion is reconstructed from the IR, so it isn't re-captured here.
  motion?: MotionCapture;
  // Fast-path (interactions OFF) hover/focus rules recovered from the source
  // stylesheets. capId keys match data-cid-cap attrs carried into the IR.
  pseudoStates?: PseudoStateRule[];
};

export type PseudoStateRule = {
  capId: string;
  pseudo: "hover" | "focus" | "focus-visible" | "focus-within";
  media?: string;
  decls: Record<string, string>;
};

function viewportHeight(width: number): number {
  return VIEWPORT_HEIGHTS[width] ?? Math.round(width * 0.66);
}

function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const dot = p.lastIndexOf(".");
    if (dot >= 0 && dot > p.lastIndexOf("/")) {
      const ext = p.slice(dot + 1).toLowerCase().slice(0, 5);
      if (/^[a-z0-9]+$/.test(ext)) return ext;
    }
  } catch { /* ignore */ }
  return "";
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/avif": "avif", "image/gif": "gif", "image/svg+xml": "svg",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf",
  "application/font-woff2": "woff2", "application/font-woff": "woff",
  "application/x-font-ttf": "ttf", "application/vnd.ms-fontobject": "eot",
  "text/css": "css", "application/json": "json", "application/manifest+json": "webmanifest",
};

function extFromContentType(contentType: string | null): string {
  if (!contentType) return "";
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  return CONTENT_TYPE_EXT[ct] ?? "";
}

function classifyAsset(url: string, contentType: string | null): string | null {
  const u = url.toLowerCase().split("?")[0]!;
  const ct = (contentType || "").toLowerCase();
  if (u.endsWith(".svg") || ct === "image/svg+xml") return "svg";
  if (/\.(jpg|jpeg|png|webp|avif|gif|ico|bmp)$/.test(u) || ct.startsWith("image/")) return "image";
  if (/\.(mp4|mov|webm|m4v|ogv)$/.test(u) || ct.startsWith("video/")) return "video";
  if (/\.(woff2|woff|ttf|otf|eot)$/.test(u) || ct.startsWith("font/") ||
      ct.includes("font-woff") || ct.includes("x-font")) return "font";
  if (u.endsWith(".json") && (u.includes("lottie") || u.includes("animation"))) return "lottie";
  if (u.endsWith(".webmanifest") || /(?:^|\/)manifest\.json$/.test(u) || ct.includes("manifest+json")) return "manifest";
  if (u.endsWith(".css") || ct.startsWith("text/css")) return "css";
  return null;
}

function isCss(url: string, contentType: string | null): boolean {
  return classifyAsset(url, contentType) === "css";
}

async function autoScroll(page: import("playwright").Page, vpHeight: number): Promise<void> {
  await scrollForLazyLoad(page, vpHeight);
}

async function settle(page: import("playwright").Page, maxMs = 2500): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.max(maxMs / 2, 800) });
  } catch { /* ignore */ }
  try {
    // document.fonts.ready can never resolve when a font request hangs (heavy SaaS
    // pages), and page.evaluate has no default timeout — so bound it explicitly.
    await Promise.race([
      page.evaluate(() => (document as Document).fonts?.ready as unknown as Promise<void>),
      new Promise<void>((r) => setTimeout(r, 6000)),
    ]);
  } catch { /* ignore */ }
  await page.waitForTimeout(250);
}

export type DismissResult = { dismissed: string[]; overlaysRemaining: number; removed: number; blocking: boolean };

/**
 * Stage 2 — overlay/popup dismissal, phase 1: click the accept/close affordance.
 * Cookie-consent walls, newsletter modals, region/age/app-install interstitials
 * cover the real page; the capture must see the state a returning user sees.
 * Deterministic + replayable: click the same known/accept controls in DOM order.
 * Removal of a stuck overlay happens later (finalizeOverlays) AFTER a settle, so a
 * just-clicked dialog has time to close and unlock scrolling before we judge it.
 */
async function clickDismiss(page: import("playwright").Page): Promise<string[]> {
  try {
    return await Promise.race([
      page.evaluate(() => {
        const dismissed: string[] = [];
        const vis = (el: Element): boolean => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const click = (el: Element): void => { try { (el as HTMLElement).click(); } catch { /* ignore */ } };

        // 1) Known consent-framework / generic close affordances, in priority order.
        const KNOWN = [
          "#onetrust-accept-btn-handler", "#accept-recommended-btn-handler", ".onetrust-close-btn-handler",
          "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept",
          "#truste-consent-button", ".osano-cm-accept-all", ".osano-cm-dialog__close",
          "[data-testid='uc-accept-all-button']", "[data-testid='uc-deny-all-button']",
          "#didomi-notice-agree-button", ".didomi-continue-without-agreeing",
          ".qc-cmp2-summary-buttons button[mode='primary']", "button[aria-label='Consent']",
          ".cc-allow", ".cookie-consent-accept", "#hs-eu-confirmation-button", "#gdpr-consent-tool-wrapper button",
        ];
        for (const sel of KNOWN) {
          try {
            for (const el of Array.from(document.querySelectorAll(sel))) {
              if (vis(el)) { click(el); dismissed.push(sel); break; }
            }
          } catch { /* invalid selector in this browser */ }
        }

        // 2) Scoped text-button pass: only inside overlay-ish containers (dialogs,
        //    or id/class naming cookie/consent/modal/popup/newsletter) so we never
        //    click an ordinary page button.
        const ACCEPT = new Set([
          "accept", "accept all", "accept all cookies", "accept cookies", "accept & close",
          "i accept", "i agree", "agree", "agree and continue", "allow all", "allow cookies",
          "allow all cookies", "got it", "ok", "okay", "continue", "no thanks", "no, thanks",
          "dismiss", "close", "got it!", "understood", "yes, i agree",
        ]);
        const containerSel =
          "[role='dialog'],[aria-modal='true'],[id*='cookie' i],[class*='cookie' i],[id*='consent' i]," +
          "[class*='consent' i],[class*='gdpr' i],[id*='gdpr' i],[class*='modal' i],[class*='popup' i]," +
          "[class*='newsletter' i],[class*='interstitial' i]";
        let containers: Element[] = [];
        try { containers = Array.from(document.querySelectorAll(containerSel)); } catch { /* ignore */ }
        for (const c of containers) {
          if (!vis(c)) continue;
          const btns = Array.from(c.querySelectorAll("button,[role='button'],a,input[type='button'],input[type='submit']"));
          for (const b of btns) {
            const t = (b.textContent || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (t && ACCEPT.has(t) && vis(b)) { click(b); dismissed.push("text:" + t); break; }
          }
        }
        return dismissed;
      }),
      new Promise<string[]>((res) => setTimeout(() => res([]), 6000)),
    ]);
  } catch {
    return [];
  }
}

/**
 * Stage 2 — overlay/popup dismissal, phase 2 (run after a settle). Detect any
 * full-viewport, high-z, fixed/sticky overlay still present. A fixed nav is wide
 * but short; a sticky sidebar is tall but narrow — both excluded; a consent wall /
 * modal backdrop covers most of both axes. If the page is *still scroll-locked*
 * (the modal is genuinely blocking) remove the overlay — but ONLY when its id/class
 * looks like a consent/modal layer, never a header/nav/main/footer, so legitimate
 * sticky chrome is never stripped. Reports `blocking` = a scroll-locking overlay we
 * could not clear (the pollution gate keys off this, not mere overlay presence).
 */
async function finalizeOverlays(page: import("playwright").Page): Promise<{ overlaysRemaining: number; removed: number; blocking: boolean; removedLabels: string[] }> {
  try {
    return await Promise.race([
      page.evaluate(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const bigOverlays = (): HTMLElement[] => {
          const out: HTMLElement[] = [];
          for (const el of Array.from(document.body.querySelectorAll("*"))) {
            const cs = getComputedStyle(el);
            if (cs.position !== "fixed" && cs.position !== "sticky") continue;
            if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) continue;
            const r = (el as HTMLElement).getBoundingClientRect();
            const z = parseInt(cs.zIndex || "0", 10) || 0;
            const area = (r.width * r.height) / (vw * vh);
            if (area >= 0.5 && z >= 100 && r.width >= vw * 0.7 && r.height >= vh * 0.5) out.push(el as HTMLElement);
          }
          return out.filter((el) => !out.some((o) => o !== el && o.contains(el)));
        };
        const isLocked = (): boolean => {
          const b = document.body, h = document.documentElement;
          return getComputedStyle(b).overflow === "hidden" || getComputedStyle(h).overflow === "hidden" ||
            getComputedStyle(b).position === "fixed";
        };
        // A scroll-locked page behind a full-viewport overlay IS a blocking modal by
        // definition (legit pages don't scroll-lock). So remove ANY such overlay that
        // isn't page chrome — many modals/drawers carry no consent/modal keyword and
        // an icon-only close, so a keyword/aria allowlist misses them (ruggable's
        // z-[1001] drawer). PROTECTED guards real chrome (header/nav/footer) only.
        const PROTECTED = /header|navbar|nav-|site-nav|topbar|masthead|footer/i;
        const sig = (el: HTMLElement): string => `${el.id} ${el.className}`.toString();

        const removedLabels: string[] = [];
        let removed = 0;
        let remaining = bigOverlays();
        if (remaining.length && isLocked()) {
          for (const el of remaining) {
            const s = sig(el);
            const z = parseInt(getComputedStyle(el).zIndex || "0", 10) || 0;
            // Scroll-locked + full-viewport ⇒ blocking modal; remove unless it's page
            // chrome. Always remove iframes (cross-origin close, unclickable) and the
            // max-z-index popup trick.
            const removable = !PROTECTED.test(s) || el.getAttribute("aria-modal") === "true" ||
              el.tagName === "IFRAME" || z >= 2_000_000_000;
            if (removable) { el.remove(); removed++; removedLabels.push((el.id || el.className || el.tagName).toString().slice(0, 40)); }
          }
          if (removed) { document.body.style.overflow = "visible"; document.documentElement.style.overflow = "visible"; document.body.style.position = "static"; }
          remaining = bigOverlays();
        }
        return { overlaysRemaining: remaining.length, removed, blocking: remaining.length > 0 && isLocked(), removedLabels };
      }),
      new Promise<{ overlaysRemaining: number; removed: number; blocking: boolean; removedLabels: string[] }>((res) => setTimeout(() => res({ overlaysRemaining: 0, removed: 0, blocking: false, removedLabels: [] }), 6000)),
    ]);
  } catch {
    return { overlaysRemaining: 0, removed: 0, blocking: false, removedLabels: [] };
  }
}

/**
 * Stage 2 — animation settling. Wait until layout stops moving (entrance/scroll
 * reveals finished) before measuring, so geometry isn't sampled mid-transition
 * ("sizes off due to animations in progress"). Samples large-box geometry across
 * frames; resolves when stable for several windows or the bound elapses.
 */
async function waitForQuiescence(page: import("playwright").Page, maxMs = 4000): Promise<boolean> {
  try {
    return await Promise.race([
      page.evaluate(async (budget: number) => {
        const sample = (): string => {
          const els = Array.from(document.body.querySelectorAll("*")).filter((e) => {
            const r = (e as HTMLElement).getBoundingClientRect();
            return r.width > 80 && r.height > 40;
          }).slice(0, 240);
          return els.map((e) => {
            const r = (e as HTMLElement).getBoundingClientRect();
            return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
          }).join("|");
        };
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const deadline = Date.now() + budget;
        let prev = sample();
        let stable = 0;
        while (Date.now() < deadline && stable < 3) {
          await sleep(130);
          const cur = sample();
          if (cur === prev) stable++; else { stable = 0; prev = cur; }
        }
        return stable >= 3;
      }, maxMs),
      new Promise<boolean>((res) => setTimeout(() => res(false), maxMs + 1500)),
    ]);
  } catch {
    return false;
  }
}

/**
 * Stage 2 — dynamic-media first frame. A streamed `<video>` has no deterministic
 * frame and its request aborts at snapshot time, so the element would render blank.
 * For videos lacking a `poster`, materialize a representative still and point the
 * element's poster at it (via a synthetic URL whose bytes the normal asset pipeline
 * rewrites to a local file). Two acquisition paths:
 *   1. canvas — draw the decoded frame; exact, but THROWS for cross-origin/tainted
 *      videos (common: CDN-hosted hero videos with no CORS header).
 *   2. element screenshot (the fallback) — rasterize the element's painted region
 *      via the DevTools protocol; works regardless of CORS and even when the video
 *      decoded late, because it reads composited pixels rather than the media buffer.
 * This closes the "poster-less video renders blank" gap (e.g. descript's hero).
 *
 * Returns canvas stills (bytes ready) + the videos that still need a node-side
 * element screenshot (the page can't screenshot itself), each tagged with a stable
 * selector. Videos with no usable surface (no poster obtainable) fall back to the
 * transparent placeholder, same as before.
 */
type VideoStillPlan = { stills: Array<{ url: string; dataUrl: string }>; shots: Array<{ url: string; sel: string }> };
async function captureVideoStills(page: import("playwright").Page): Promise<VideoStillPlan> {
  try {
    const plan = await Promise.race([
      page.evaluate(async () => {
        const stills: Array<{ url: string; dataUrl: string }> = [];
        const shots: Array<{ url: string; sel: string }> = [];
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const hash = (s: string): string => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
        const vids = Array.from(document.querySelectorAll("video"));
        let i = 0;
        for (const v of vids) {
          if (v.getAttribute("poster")) continue; // real poster already discovered
          const r = v.getBoundingClientRect();
          if (r.width < 16 || r.height < 16) continue; // not a visible media surface
          const idx = i++;
          v.setAttribute("data-clone-vid", String(idx));
          const key = v.currentSrc || (v.querySelector("source") as HTMLSourceElement | null)?.src || String(idx);
          const url = `https://clone-still.local/${idx}-${hash(key)}.jpg`;
          try { v.pause(); } catch { /* ignore */ }
          try { v.currentTime = 0; } catch { /* ignore */ }
          await sleep(100);
          // Lazy background videos (preload="none" / range-aborted) sit at
          // readyState < 2 with no decodable frame — force one in (bounded) so the
          // canvas readback has pixels. Elementor hero videos land here.
          if (v.readyState < 2 && (v.currentSrc || v.querySelector("source"))) {
            try {
              v.muted = true;
              v.preload = "auto";
              v.load();
              const p = v.play();
              if (p && typeof p.catch === "function") p.catch(() => { /* autoplay denied */ });
            } catch { /* ignore */ }
            for (let t = 0; t < 20 && v.readyState < 2; t++) await sleep(100);
            try { v.pause(); v.currentTime = 0; } catch { /* ignore */ }
            await sleep(100);
          }
          let done = false;
          const w = v.videoWidth, h = v.videoHeight;
          if (w && h && v.readyState >= 2) {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(v, 0, 0, w, h);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.82); // throws if tainted
                if (dataUrl.startsWith("data:image/jpeg")) { stills.push({ url, dataUrl }); done = true; }
              }
            } catch { /* tainted/cross-origin — fall through to the element screenshot */ }
          }
          if (done) {
            v.setAttribute("poster", url);
          } else {
            // Element screenshots capture composited pixels. For background hero
            // videos with text/CTAs overlaid, that would bake the foreground into
            // the poster and then render the live DOM on top again.
            let occluded = false;
            for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,p,span,a,button,li"))) {
              if (v.contains(el) || (el.textContent || "").trim().length < 3) continue;
              const cs = getComputedStyle(el);
              if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity || "1") < 0.05) continue;
              const er = el.getBoundingClientRect();
              if (er.width < 2 || er.height < 2) continue;
              const ix = Math.min(er.right, r.right) - Math.max(er.left, r.left);
              const iy = Math.min(er.bottom, r.bottom) - Math.max(er.top, r.top);
              if (ix > 0 && iy > 0 && ix * iy > 0.05 * er.width * er.height) { occluded = true; break; }
            }
            if (!occluded) {
              v.setAttribute("poster", url);
              shots.push({ url, sel: `video[data-clone-vid="${idx}"]` });
            }
          }
        }
        return { stills, shots };
      }),
      new Promise<VideoStillPlan>((res) => setTimeout(() => res({ stills: [], shots: [] }), 12000)),
    ]);
    return plan;
  } catch {
    return { stills: [], shots: [] };
  }
}

/**
 * Full-page screenshot with robustness for heavy/animated pages. The default 30s
 * timeout is exceeded by tall SaaS pages (Playwright also waits for web fonts);
 * use a long timeout, freeze animations (also improves determinism), and retry.
 * As a last resort take a viewport-only shot so the file exists (the capture gate
 * checks presence; a partial image still beats none).
 */
async function captureScreenshot(
  page: import("playwright").Page,
  path: string,
  vw: number,
  log: (e: Record<string, unknown>) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.screenshot({ path, fullPage: true, timeout: 90_000, animations: "disabled" });
      return;
    } catch (e) {
      if (attempt === 1) {
        try {
          await page.screenshot({ path, fullPage: false, timeout: 30_000, animations: "disabled" });
          log({ event: "screenshot_fallback_viewport", viewport: vw });
          return;
        } catch (e2) {
          log({ event: "screenshot_error", viewport: vw, error: String(e2) });
        }
      }
    }
  }
}

export async function captureSite(opts: {
  url: string;
  outDir: string; // source/ directory
  viewports?: number[];
  interactions?: boolean; // Stage 4: opt-in interaction capture (hover/focus + patterns)
  motion?: boolean; // Stage 5: opt-in motion capture (WAAPI + rotating text)
  breakpoints?: boolean; // discover the source's real responsive band edges (default on; read-only sweep)
  deterministicEnv?: boolean; // seed Math.random + pin the clock epoch BEFORE page JS runs (default on),
                              // so shuffled carousels / random ids / "posted N minutes ago" render the
                              // same across captures. Relative time still advances (timers behave).
  screenshots?: boolean; // write per-viewport full-page PNGs (default on). ONLY the validator reads these
                         // (generation never touches pixels), and full-page shots of tall pages are the
                         // dominant capture cost — so a production clone that won't be perceptually graded
                         // can skip them. The cheap poster-less-video element stills are always kept
                         // (generation needs a first frame), this only gates the per-viewport page shots.
  log?: (event: Record<string, unknown>) => void;
}): Promise<CaptureResult> {
  const viewports = opts.viewports ?? [...REQUIRED_VIEWPORTS];
  const log = opts.log ?? (() => {});
  const captureDir = join(opts.outDir, "capture");
  const screenshotsDir = join(opts.outDir, "screenshots");
  const cssDir = join(captureDir, "css");
  const storeDir = join(opts.outDir, "assets-store");
  ensureDir(captureDir);
  ensureDir(screenshotsDir);

  // url -> discovered asset (merged across viewports)
  const assetMap = new Map<string, DiscoveredAsset>();
  const cssStored = new Set<string>();
  const fontFaceMap = new Map<string, FontFace>();
  const seoResourceUrls = new Map<string, SeoResource["kind"]>();

  const sourceOrigin = (() => {
    try {
      const u = new URL(opts.url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
    } catch {
      return "";
    }
  })();
  const addSeoResource = (url: string, kind: SeoResource["kind"], base = opts.url): void => {
    try {
      const abs = new URL(url, base).href;
      if (!/^https?:\/\//i.test(abs)) return;
      if (!seoResourceUrls.has(abs)) seoResourceUrls.set(abs, kind);
    } catch { /* ignore malformed resource hints */ }
  };
  if (sourceOrigin) {
    addSeoResource(sourceOrigin + "/robots.txt", "robots");
    addSeoResource(sourceOrigin + "/sitemap.xml", "sitemap");
    addSeoResource(sourceOrigin + "/sitemap_index.xml", "sitemap");
    addSeoResource(sourceOrigin + "/llms.txt", "llms");
    addSeoResource(sourceOrigin + "/llms-full.txt", "llms-full");
  }

  const recordAsset = (url: string, type: string, contentType: string | null, status: number | null, via: string): DiscoveredAsset => {
    let a = assetMap.get(url);
    if (!a) {
      a = { url, type, contentType, status, storedAs: null, bytes: 0, via: [] };
      assetMap.set(url, a);
    }
    if (!a.via.includes(via)) a.via.push(via);
    if (contentType && !a.contentType) a.contentType = contentType;
    if (status != null && a.status == null) a.status = status;
    // SVG/specific types win over generic
    if (type && (a.type === "other" || (a.type === "image" && type === "svg"))) a.type = type;
    return a;
  };

  const storeBytes = (url: string, type: string, bytes: Buffer): void => {
    if (!bytes || bytes.length === 0) return;
    const a = assetMap.get(url) ?? recordAsset(url, type, null, null, "network");
    if (a.storedAs) return;
    const ext = extFromUrl(url) || extFromContentType(a.contentType) ||
      (type === "css" ? "css" : type === "font" ? "woff2" : type === "svg" ? "svg" :
       type === "video" ? "mp4" : type === "lottie" ? "json" : "png");
    const name = `${sha1_12(url)}.${ext}`;
    if (type === "css") {
      writeBytes(join(cssDir, name), bytes);
      cssStored.add(name);
    } else {
      writeBytes(join(storeDir, name), bytes);
    }
    a.storedAs = name;
    a.bytes = bytes.length;
  };

  const parseManifestForAssets = (text: string, baseUrl: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;
    const push = (raw: unknown, via: string): void => {
      if (typeof raw !== "string" || !raw.trim() || raw.trim().startsWith("data:")) return;
      let abs = raw;
      try { abs = new URL(raw, baseUrl).href; } catch { /* keep raw */ }
      const t = classifyAsset(abs, null) ?? "image";
      recordAsset(abs, t, null, null, via);
    };
    const iconList = (parsed as { icons?: unknown }).icons;
    if (Array.isArray(iconList)) {
      for (const icon of iconList) if (icon && typeof icon === "object") push((icon as { src?: unknown }).src, "manifest:icons");
    }
    const screenshots = (parsed as { screenshots?: unknown }).screenshots;
    if (Array.isArray(screenshots)) {
      for (const shot of screenshots) if (shot && typeof shot === "object") push((shot as { src?: unknown }).src, "manifest:screenshots");
    }
    const shortcuts = (parsed as { shortcuts?: unknown }).shortcuts;
    if (Array.isArray(shortcuts)) {
      for (const shortcut of shortcuts) {
        const icons = shortcut && typeof shortcut === "object" ? (shortcut as { icons?: unknown }).icons : undefined;
        if (Array.isArray(icons)) for (const icon of icons) if (icon && typeof icon === "object") push((icon as { src?: unknown }).src, "manifest:shortcuts");
      }
    }
  };

  // Honor the standard HTTPS_PROXY env so capture works behind an egress proxy
  // (sandboxed/CI environments). The proxy re-terminates TLS, so the per-context
  // `ignoreHTTPSErrors` below covers its CA. Capture is not part of the determinism
  // gate, so this never affects generated output.
  // Honor HTTPS_PROXY for real remote captures behind an egress proxy (sandboxed/CI),
  // but ONLY for non-loopback http(s) targets — file:// and localhost fixtures (tests,
  // the validator's static server) must be fetched directly. Playwright otherwise routes
  // even loopback through the proxy (its default `<-loopback>`), which would replace a
  // local fixture with the proxy's error page. Capture is not part of the determinism
  // gate, so this never affects generated output.
  let proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  try {
    const u = new URL(opts.url);
    // Skip the proxy ONLY for a localhost http(s) target (test fixtures, the validator's
    // static server) — Playwright otherwise routes loopback through the proxy and replaces
    // the page with the proxy error page. file:// keeps the proxy on so any REMOTE assets
    // the local page references fast-fail through the proxy instead of hanging on a blocked
    // direct connection; external targets obviously keep it.
    const isHttp = u.protocol === "http:" || u.protocol === "https:";
    const isLoopback = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(u.hostname);
    if (isHttp && isLoopback) proxyServer = "";
  } catch { /* keep proxy */ }
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });

  const perViewport: CaptureResult["perViewport"] = [];
  let interaction: InteractionCapture | undefined;
  let motion: MotionCapture | undefined;
  let pseudoStates: PseudoStateRule[] = [];
  let discoveredBreakpoints: number[] | undefined;
  const captureSeoResources: SeoResource[] = [];
  const cssTextsForParsing: Array<{ baseUrl: string; text: string }> = [];
  const dismissUnion = { dismissed: [] as string[], overlaysRemaining: 0, removed: 0, videoStills: 0, blocking: false };
  // Carry cookies/localStorage across the per-viewport contexts so the SAME page
  // is captured at every width: A/B-test buckets and consent state are usually
  // session-persisted, so without this each fresh context can load a different
  // variant (grammarly served a different hero per viewport) and the cross-
  // viewport IR alignment then can't reconcile them. Sharing the session also
  // means a banner dismissed at the first width stays dismissed at the rest.
  const canonical = viewports.includes(1280) ? 1280 : viewports[Math.floor(viewports.length / 2)]!;

  try {
    // Single context + single navigation; every viewport is captured by RESIZING
    // the same loaded page (no reload). This guarantees identical content across
    // widths — eliminating both A/B-per-load variance (grammarly served a different
    // hero on each fresh load) and session-reuse degeneration (warbyparker returned
    // a 13-node shell when reloaded with a carried session). The IR's cross-viewport
    // alignment then operates on one logical DOM that CSS merely reflows.
    const bodyPromises: Promise<void>[] = [];
    const isClosedError = (e: unknown) =>
      /Target page, context or browser has been closed|page closed|has crashed|browser has been closed/i.test(String(e));

    const attachPageHandlers = (pg: Page) => {
      pg.on("crash", () => log({ event: "page_crash" }));
      pg.on("response", (resp) => {
        try {
          const url = resp.url();
          if (url.startsWith("data:") || url.startsWith("blob:")) return;
          const ct = resp.headers()["content-type"] || null;
          const type = classifyAsset(url, ct);
          if (!type) return;
          const status = resp.status();
          recordAsset(url, type, ct, status, "network");
          const existing = assetMap.get(url);
          if (existing?.storedAs) return;
          if (status >= 400) return;
          // A 206 body is a RANGE FRAGMENT (media elements fetch videos in chunks) —
          // storing it would freeze a truncated file as "downloaded" (cropin's hero
          // video landed as 27KB of a multi-MB mp4). Leave it unstored; the fallback
          // downloader fetches the complete file with a plain GET.
          if (status === 206) return;
          bodyPromises.push(
            (async () => {
              try {
                const buf = await resp.body();
                storeBytes(url, type, buf);
                if (type === "css") cssTextsForParsing.push({ baseUrl: url, text: buf.toString("utf8") });
                if (type === "manifest") parseManifestForAssets(buf.toString("utf8"), url);
              } catch { /* body unavailable */ }
            })(),
          );
        } catch { /* ignore */ }
      });
    };

    const newSession = async (): Promise<{ context: BrowserContext; page: Page }> => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: canonical, height: viewportHeight(canonical) },
        deviceScaleFactor: 1,
        userAgent: DESKTOP_UA,
        javaScriptEnabled: true,
      });
      const page = await context.newPage();
      // tsx/esbuild wraps functions with a __name() helper for stack traces; that
      // helper does not exist in the browser when we serialize page.evaluate
      // callbacks. Shim it (as a raw string so it isn't itself transformed).
      attachPageHandlers(page);
      await page.addInitScript(ESBUILD_SHIM);
      if (opts.deterministicEnv ?? true) await page.addInitScript(DETERMINISTIC_ENV_SHIM);
      return { context, page };
    };

    // Single navigation at the canonical width; every viewport below is a resize.
    // Bounded by a TOTAL budget (not per-attempt × retries) so a hanging origin
    // fails fast with a clear error instead of stalling the pipeline for minutes.
    const navigateLoaded = async (pg: Page): Promise<void> => {
      log({ event: "goto", url: opts.url });
      const NAV_BUDGET_MS = 60_000;
      const navStart = Date.now();
      let navigated = false;
      let navErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
        const remaining = NAV_BUDGET_MS - (Date.now() - navStart);
        if (remaining < 5_000) break;
        try {
          await pg.goto(opts.url, {
            waitUntil: attempt === 0 ? "load" : "domcontentloaded",
            timeout: Math.min(attempt === 0 ? 30_000 : 15_000, remaining),
          });
          navigated = true;
        } catch (e) {
          navErr = e;
          await pg.waitForTimeout(1000);
        }
      }
      if (!navigated) {
        throw new Error(
          `navigation failed for ${opts.url} within ${Math.round((Date.now() - navStart) / 1000)}s: ${String(navErr).slice(0, 300)}`,
        );
      }
      await settle(pg);
    };

    let { context, page } = await newSession();
    await navigateLoaded(page);

    const recoverSession = async (): Promise<void> => {
      log({ event: "capture_recover", reason: "browser_or_page_closed" });
      try {
        if (!page.isClosed()) await page.close();
      } catch { /* ignore */ }
      try {
        await context.close();
      } catch { /* ignore */ }
      ({ context, page } = await newSession());
      await navigateLoaded(page);
    };

    const safeSetViewport = async (vw: number, vh: number): Promise<void> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (page.isClosed()) throw new Error("page closed");
          await page.setViewportSize({ width: vw, height: vh });
          return;
        } catch (e) {
          if (attempt === 0 && isClosedError(e)) {
            await recoverSession();
            continue;
          }
          throw e;
        }
      }
    };

    // Auth/bot-wall fast fail: a wall page would otherwise burn the full
    // multi-viewport capture and only get flagged by the pollution gate afterward.
    // Same signature set as the gate (util/wallText.ts) so the judgments agree.
    const wallProbe = await page
      .evaluate(() => ({
        text: (document.body?.innerText ?? "").slice(0, 20_000),
        nodes: document.querySelectorAll("*").length,
      }))
      .catch(() => null);
    if (wallProbe && wallProbe.nodes < 220 && isWallText(wallProbe.text)) {
      throw new Error(
        `auth/bot wall detected at ${opts.url} (${wallProbe.nodes} nodes, wall text matched): capture aborted early`,
      );
    }

    for (const vw of viewports) {
      if (perViewport.some((p) => p.viewport === vw)) continue;
      const vh = viewportHeight(vw);
      await safeSetViewport(vw, vh);
      await settle(page, 1500); // let the resize reflow + any width-triggered content settle

      // Stage 2: dismiss cookie/consent/newsletter/region overlays. Run TWICE —
      // once after initial load (cookie/consent walls appear immediately), and
      // again after the scroll pass (newsletter/email-capture modals are usually
      // timer- or scroll-triggered and only mount a few seconds in). Each pass
      // clicks the accept/close control, settles (so a just-closed dialog unlocks
      // scrolling), THEN removes only a genuinely-stuck consent/modal layer.
      let overlaysRemaining = 0;
      let blocking = false;
      const applyDismiss = async (phase: string): Promise<void> => {
        const clicked = await clickDismiss(page);
        if (clicked.length) await settle(page, 1000);
        const fin = await finalizeOverlays(page);
        for (const d of clicked) if (!dismissUnion.dismissed.includes(d)) dismissUnion.dismissed.push(d);
        for (const d of fin.removedLabels) { const k = "removed:" + d; if (!dismissUnion.dismissed.includes(k)) dismissUnion.dismissed.push(k); }
        dismissUnion.removed += fin.removed;
        overlaysRemaining = fin.overlaysRemaining;
        blocking = blocking || fin.blocking;
        if (clicked.length || fin.removed) { await settle(page, 1000); log({ event: "dismissed", viewport: vw, phase, count: clicked.length, removed: fin.removed, remaining: fin.overlaysRemaining, blocking: fin.blocking }); }
      };
      await applyDismiss("load");

      // Stage 5 (scroll reveals): at the FIRST viewport, before any scroll, tag elements
      // and snapshot the pre-reveal hidden state — scroll reveals fire on the first
      // autoScroll and stay revealed, so this is the only moment their hidden state is
      // observable. Idempotent + motion-gated; the settled snapshot is unchanged.
      if (opts.motion && vw === viewports[0]) { await tagElements(page); await probeReveals(page); }

      await autoScroll(page, vh);
      await settle(page, 1500);
      await applyDismiss("post-scroll");
      dismissUnion.overlaysRemaining = Math.max(dismissUnion.overlaysRemaining, overlaysRemaining);
      dismissUnion.blocking = dismissUnion.blocking || blocking;
      // Stage 2: wait for entrance/scroll animations to settle so geometry isn't
      // sampled mid-transition.
      const quiescent = await waitForQuiescence(page);

      // Fast-path hover/focus recovery: when Stage 4 (live interaction driving) is
      // OFF, recover state-variant styling from the stylesheets instead — parse
      // :hover/:focus rules, match their base selectors against the live DOM, and
      // tag matches (data-cid-cap survives into the IR). Cross-origin sheets are
      // unreadable via CSSOM, so their intercepted raw text is re-parsed through
      // constructed stylesheets. Runs once, before any DOM walk.
      if (!opts.interactions && vw === viewports[0]) {
        try {
          pseudoStates = await collectPseudoStates(page, cssTextsForParsing.map((t) => t.text));
          if (pseudoStates.length) log({ event: "pseudo_states", rules: pseudoStates.length });
        } catch (e) {
          log({ event: "pseudo_states_error", error: String(e).slice(0, 160) });
        }
      }

      // Reset window + all inner scrollable containers to scroll 0 so captured
      // positions match the generated app's default (un-scrolled) render. Inner
      // scroll state is runtime JS state and otherwise non-deterministic.
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (el.scrollLeft) el.scrollLeft = 0;
          if (el.scrollTop) el.scrollTop = 0;
        }
      });
      await page.waitForTimeout(150);

      // Stage 2: dynamic-media first frame. Materialize a still for poster-less
      // videos so they don't render blank — canvas where the frame is readable, else
      // an element screenshot (the page cannot screenshot itself). Done once at the
      // canonical viewport: it's the highest-fidelity width, the poster attr persists
      // across the later resizes, and the IR reads attrs from the canonical snapshot.
      if (vw === canonical) {
        const plan = await captureVideoStills(page);
        for (const s of plan.stills) {
          const comma = s.dataUrl.indexOf(",");
          if (comma < 0) continue;
          try {
            const buf = Buffer.from(s.dataUrl.slice(comma + 1), "base64");
            recordAsset(s.url, "image", "image/jpeg", 200, "video-still");
            storeBytes(s.url, "image", buf);
            dismissUnion.videoStills++;
          } catch { /* ignore */ }
        }
        for (const s of plan.shots) {
          try {
            const buf = await page.locator(s.sel).first().screenshot({ type: "jpeg", quality: 82, timeout: 5000, animations: "disabled" });
            recordAsset(s.url, "image", "image/jpeg", 200, "video-still");
            storeBytes(s.url, "image", buf);
            dismissUnion.videoStills++;
          } catch { /* element not shootable (off-screen/detached) — poster falls back to placeholder */ }
        }
        // Element screenshots scroll the target into view; restore scroll 0 so the
        // canonical DOM walk + screenshot match the generated app's default render.
        if (plan.shots.length) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(80);
        }
      }

      // Stage 4/5: stamp capture-ids before the canonical snapshot so the IR carries
      // them (whitelisted), enabling interaction deltas + motion specs to map to cids.
      if ((opts.interactions || opts.motion) && vw === canonical) await tagElements(page);

      // Bound the in-page DOM walk: page.evaluate has no default timeout, so a
      // pathologically large/animated DOM (e.g. asana.com) could hang forever.
      const snapshot: PageSnapshot = await Promise.race([
        page.evaluate(collectPage),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`collectPage timeout vp${vw}`)), 60_000)),
      ]);

      // Merge discovered references from the snapshot (DOM + accessible CSS).
      for (const da of snapshot.domAssets) {
        const t = classifyAsset(da.url, null) ?? (da.kind === "manifest" ? "manifest" : da.kind === "video" ? "video" : da.kind === "svg" ? "svg" : "image");
        recordAsset(da.url, t, null, null, da.via);
      }
      for (const link of snapshot.doc.head?.links ?? []) {
        const rel = (link.rel || "").toLowerCase();
        const href = link.href || "";
        if (!href) continue;
        if (/\bsitemap\b/.test(rel)) addSeoResource(href, "sitemap", snapshot.doc.url);
        if (/llms-full\.txt(?:$|[?#])/i.test(href) || /\bllms-full\b/.test(rel)) addSeoResource(href, "llms-full", snapshot.doc.url);
        else if (/llms\.txt(?:$|[?#])/i.test(href) || /\bllms\b/.test(rel)) addSeoResource(href, "llms", snapshot.doc.url);
      }
      for (const u of snapshot.cssUrls) {
        const t = classifyAsset(u, null) ?? "other";
        recordAsset(u, t, null, null, "css-url");
      }
      for (const ff of snapshot.fontFaces) {
        const key = `${ff.family}|${ff.weight ?? ""}|${ff.style ?? ""}|${ff.src}`;
        if (!fontFaceMap.has(key)) fontFaceMap.set(key, ff);
      }

      // Cap body collection: resp.body() has no timeout, so a streaming/long-poll
      // response (common on heavy SaaS pages) would hang allSettled forever. By
      // now bodies have been downloading throughout navigation+scroll; stragglers
      // are dropped (the post-pass fallback fetch re-fetches anything missing).
      await Promise.race([
        Promise.allSettled(bodyPromises),
        new Promise((r) => setTimeout(r, 20_000)),
      ]);

      // Persist DOM snapshot, and (unless skipped for a production clone) the full-page screenshot.
      writeJSONCompact(join(captureDir, `dom-${vw}.json`), snapshot);
      if (opts.screenshots !== false) {
        await preScreenshotSettle(page);
        await captureScreenshot(page, join(screenshotsDir, `${vw}.png`), vw, log);
      }

      // Frozen live witness (HTML + DOM + screenshot) for validate gates — no live re-fetch.
      const witnessVpDir = join(liveWitnessDir(opts.outDir), String(vw));
      ensureDir(witnessVpDir);
      writeJSONCompact(join(witnessVpDir, "dom.json"), snapshot);
      try {
        const pageHtml = await page.content();
        writeLiveWitnessViewport({
          sourceDir: opts.outDir,
          viewport: vw,
          html: pageHtml,
          screenshotSrc: opts.screenshots !== false ? join(screenshotsDir, `${vw}.png`) : undefined,
        });
      } catch (e) {
        log({ event: "live_witness_error", viewport: vw, error: String(e).slice(0, 160) });
      }

      // Stage 4: drive recognized affordances at the canonical viewport (opt-in).
      if (opts.interactions && vw === canonical) {
        try { interaction = await captureInteractions(page, { log }); }
        catch (e) { log({ event: "interactions_error", error: String(e).slice(0, 200) }); }
      }

      // Stage 5: capture motion (WAAPI + rotating text) at the canonical viewport.
      if (opts.motion && vw === canonical) {
        try { motion = await captureMotion(page, { log }); }
        catch (e) { log({ event: "motion_error", error: String(e).slice(0, 200) }); }
      }

      perViewport.push({
        viewport: vw,
        height: vh,
        scrollHeight: round(snapshot.doc.scrollHeight),
        nodeCount: snapshot.doc.nodeCount,
        truncated: snapshot.doc.truncated,
        overlaysRemaining,
        blocking,
        quiescent,
      });
      log({ event: "captured", viewport: vw, nodes: snapshot.doc.nodeCount, scrollHeight: snapshot.doc.scrollHeight });
    }

    // Conditional-asset sweep: harvest lazy refs the scroll pass never fired
    // (data-src / data-bg aliases, srcset variants, loading=lazy images). They are
    // only RECORDED here — the fallback downloader below fetches whatever the
    // network listener didn't store, so this is purely additive discovery. Gate 2b's
    // `untracked` metric measures exactly this gap.
    try {
      const lazyRefs = await page.evaluate(() => {
        const urls = new Set<string>();
        const push = (v: string | null | undefined) => {
          if (!v || v.startsWith("data:")) return;
          try { urls.add(new URL(v, location.href).href) } catch { /* ignore */ }
        };
        const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-bg", "data-background", "data-background-image"];
        for (const el of Array.from(document.querySelectorAll(LAZY_ATTRS.map((a) => `[${a}]`).join(",")))) {
          for (const a of LAZY_ATTRS) push(el.getAttribute(a));
        }
        for (const el of Array.from(document.querySelectorAll("picture source[srcset], picture source[src], source[srcset]"))) {
          const ss = el.getAttribute("srcset") ?? el.getAttribute("src") ?? "";
          for (const part of ss.split(",")) push(part.trim().split(/\s+/)[0]);
        }
        for (const el of Array.from(document.querySelectorAll("[style*='background'], [style*='url(']"))) {
          const st = el.getAttribute("style") ?? "";
          for (const m of st.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) push(m[1]);
        }
        for (const el of Array.from(document.querySelectorAll("noscript"))) {
          for (const m of (el.textContent ?? "").matchAll(/(?:src|href|srcset)\s*=\s*['"]([^'"]+)['"]/gi)) push(m[1]);
        }
        for (const el of Array.from(document.querySelectorAll("img[srcset], source[srcset], [data-srcset]"))) {
          const ss = el.getAttribute("srcset") ?? el.getAttribute("data-srcset") ?? "";
          for (const part of ss.split(",")) push(part.trim().split(/\s+/)[0]);
        }
        for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img[loading=lazy]"))) push(img.currentSrc || img.src);
        return [...urls].sort();
      });
      let swept = 0;
      for (const url of lazyRefs) {
        if (swept >= 100) break; // bound pathological pages; fallback fetch is 30s/asset
        if (!/^https?:\/\//i.test(url) || assetMap.has(url)) continue;
        const t = classifyAsset(url, null);
        if (!t || !["image", "svg", "video", "font", "lottie"].includes(t)) continue;
        recordAsset(url, t, null, null, "lazy-sweep");
        swept++;
      }
      if (swept) log({ event: "lazy_sweep", recorded: swept, seen: lazyRefs.length });
    } catch (e) {
      log({ event: "lazy_sweep_error", error: String(e).slice(0, 160) });
    }

    // Browser-as-oracle: discover the source's real responsive band edges by sweeping the viewport
    // and binary-searching each width where the discrete (media-query-toggled) layout signature
    // changes. Read-only and bounded; runs once here — overlays are dismissed and the DOM settled, so
    // the signature is the real page, not a consent wall. Never fatal: a failed sweep just omits the
    // field. The context closes right after, so the swept viewport size needs no restore.
    if (opts.breakpoints ?? true) {
      try {
        const edges = await Promise.race([
          discoverBreakpoints(page, { min: 320, max: 1920 }),
          new Promise<number[]>((_, rej) => setTimeout(() => rej(new Error("breakpoint sweep timeout")), 60_000)),
        ]);
        discoveredBreakpoints = edges;
        log({ event: "breakpoints_discovered", edges });
      } catch (e) {
        log({ event: "breakpoints_error", error: String(e).slice(0, 200) });
      }
    }
    await context.close();

    // Parse @font-face + url() from cross-origin CSS texts we fetched at the
    // network layer (the in-page walker can only read same-origin sheets).
    for (const { baseUrl, text } of cssTextsForParsing) {
      parseCssForFonts(text, baseUrl, fontFaceMap, (u) => {
        const t = classifyAsset(u, null) ?? "other";
        recordAsset(u, t, null, null, "css-text");
      });
    }

    // Fallback: download any referenced-but-not-yet-stored asset using the
    // browser context (shares TLS handling). Fonts and CSS-referenced images are
    // commonly missed by the response listener when served from cache.
    const fallbackCtx = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: DESKTOP_UA });
    for (const a of assetMap.values()) {
      if (a.storedAs) continue;
      if (a.url.startsWith("data:")) continue;
      if (!["image", "svg", "video", "font", "lottie", "css", "manifest"].includes(a.type)) continue;
      try {
        const resp = await fallbackCtx.request.get(a.url, { timeout: 30000 });
        a.status = resp.status();
        if (resp.ok()) {
          const buf = await resp.body();
          a.contentType = a.contentType ?? (resp.headers()["content-type"] || null);
          storeBytes(a.url, a.type, buf);
          if (a.type === "css") parseCssForFonts(buf.toString("utf8"), a.url, fontFaceMap, (u) => {
            const t = classifyAsset(u, null) ?? "other";
            recordAsset(u, t, null, null, "css-text");
          });
          if (a.type === "manifest") parseManifestForAssets(buf.toString("utf8"), a.url);
        }
      } catch { /* unreachable/signed — left as skipped */ }
    }
    const seoResources: SeoResource[] = [];
    const fetchedSeo = new Set<string>();
    const fetchSeoResource = async (url: string, kind: SeoResource["kind"]): Promise<void> => {
      if (fetchedSeo.has(url)) return;
      fetchedSeo.add(url);
      try {
        const resp = await fallbackCtx.request.get(url, { timeout: 15000 });
        const contentType = resp.headers()["content-type"] || null;
        const resource: SeoResource = { kind, url, status: resp.status(), contentType };
        if (resp.ok() && (kind === "llms" || kind === "llms-full" || kind === "robots")) {
          const text = await resp.text();
          resource.text = text;
          if (kind === "robots") {
            for (const line of text.split(/\r?\n/)) {
              const m = /^sitemap:\s*(\S+)/i.exec(line.trim());
              if (m) addSeoResource(m[1]!, "sitemap", url);
            }
          }
        }
        seoResources.push(resource);
      } catch {
        seoResources.push({ kind, url, status: null, contentType: null });
      }
    };
    for (let pass = 0; pass < 2; pass++) {
      const entries = [...seoResourceUrls.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [url, kind] of entries) await fetchSeoResource(url, kind);
    }
    await fallbackCtx.close();

    if (seoResources.length) {
      (captureSeoResources as SeoResource[]).push(...seoResources.sort((a, b) => a.url.localeCompare(b.url) || a.kind.localeCompare(b.kind)));
    }
  } finally {
    await browser.close();
  }

  const assets = [...assetMap.values()].sort((a, b) => a.url.localeCompare(b.url));
  const fontFaces = [...fontFaceMap.values()].sort((a, b) =>
    `${a.family}${a.weight}${a.style}`.localeCompare(`${b.family}${b.weight}${b.style}`),
  );

  const result: CaptureResult = {
    sourceUrl: opts.url,
    capturedAt: new Date().toISOString(),
    viewports,
    breakpoints: discoveredBreakpoints,
    perViewport,
    assets,
    ...(captureSeoResources.length ? { seoResources: captureSeoResources } : {}),
    fontFaces,
    cssTexts: [...cssStored].sort(),
    dismissal: dismissUnion,
    interaction,
    motion,
    ...(pseudoStates.length ? { pseudoStates } : {}),
  };

  if (interaction) writeJSON(join(opts.outDir, "interaction.json"), interaction);
  if (motion) writeJSON(join(opts.outDir, "motion.json"), motion);
  writeJSON(join(opts.outDir, "assets-discovered.json"), assets);
  writeJSON(join(opts.outDir, "fonts-discovered.json"), fontFaces);
  writeJSON(join(captureDir, "capture-result.json"), result);

  const assetManifest = hashAssetStore(opts.outDir);
  writeEvidenceManifest(opts.outDir, baseEvidenceManifest({
    sourceUrl: opts.url,
    viewports,
    userAgent: DESKTOP_UA,
    assetManifest,
  }));
  log({ event: "evidence_frozen", assetFiles: assetManifest.fileCount, assetHash: assetManifest.hash.slice(0, 12) });

  return result;
}

// Kebab-case mirror of interactions.ts PSEUDO_PROPS — the curated set a
// :hover/:focus rule realistically changes. Filtering to it keeps recovered
// rules from dragging layout-shifting junk (display/position) into the clone.
const PSEUDO_DECL_ALLOW = [
  "color", "background-color", "background-image", "background-position",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "box-shadow", "opacity", "transform", "filter",
  "text-decoration-line", "text-decoration-color", "text-decoration",
  "outline-color", "outline-width", "outline-style", "letter-spacing",
];

/** Scan every reachable stylesheet for self-targeting :hover/:focus rules, match
 *  their base selectors against the live DOM, tag matches with data-cid-cap, and
 *  return the (deduped) rules. Cross-origin sheets can't be read via CSSOM, so
 *  their intercepted raw text is re-parsed through constructed stylesheets. */
async function collectPseudoStates(page: Page, crossOriginCssTexts: string[]): Promise<PseudoStateRule[]> {
  const raw = await page.evaluate(
    ({ texts, allow }: { texts: string[]; allow: string[] }) => {
      const out: Array<{ capId: string; pseudo: string; media?: string; decls: Record<string, string> }> = [];
      const allowSet = new Set(allow);
      let counter = 0;
      const idFor = (el: Element): string => {
        let id = el.getAttribute("data-cid-cap");
        if (!id) {
          id = "ps" + counter++;
          el.setAttribute("data-cid-cap", id);
        }
        return id;
      };
      const PSEUDO_RE = /^(.*?):(hover|focus-visible|focus-within|focus)$/;
      const sheets: CSSStyleSheet[] = Array.from(document.styleSheets) as CSSStyleSheet[];
      for (const t of texts) {
        try {
          const s = new CSSStyleSheet();
          s.replaceSync(t);
          sheets.push(s);
        } catch { /* unparseable text */ }
      }
      const visit = (rules: CSSRuleList | null | undefined, media: string | undefined): void => {
        if (!rules) return;
        for (const r of Array.from(rules)) {
          if (out.length >= 400) return;
          const asMedia = r as CSSMediaRule;
          const asStyle = r as CSSStyleRule;
          if (asMedia.media && (asMedia as { cssRules?: CSSRuleList }).cssRules) {
            visit(asMedia.cssRules, asMedia.media.mediaText || media);
            continue;
          }
          if (!asStyle.selectorText && (r as { cssRules?: CSSRuleList }).cssRules) {
            visit((r as { cssRules?: CSSRuleList }).cssRules, media); // @supports / @layer
            continue;
          }
          if (!asStyle.selectorText || !asStyle.style || !/:(hover|focus)/.test(asStyle.selectorText)) continue;
          for (const part of asStyle.selectorText.split(",")) {
            const m = PSEUDO_RE.exec(part.trim());
            if (!m || !m[1]) continue; // self-targeting only; `.card:hover .overlay` reveals stay Stage 4's job
            const decls: Record<string, string> = {};
            for (let i = 0; i < asStyle.style.length; i++) {
              const prop = asStyle.style.item(i);
              if (allowSet.has(prop)) decls[prop] = asStyle.style.getPropertyValue(prop);
            }
            if (!Object.keys(decls).length) continue;
            let els: Element[] = [];
            try {
              els = Array.from(document.querySelectorAll(m[1])).slice(0, 30);
            } catch { continue; } // selector syntax the engine rejects
            for (const el of els) {
              out.push({ capId: idFor(el), pseudo: m[2]!, ...(media ? { media } : {}), decls });
            }
          }
        }
      };
      for (const s of sheets) {
        try { visit(s.cssRules, undefined); } catch { /* cross-origin CSSOM — covered by texts */ }
      }
      return out;
    },
    { texts: crossOriginCssTexts, allow: PSEUDO_DECL_ALLOW },
  );
  // Same-origin sheets appear both in CSSOM and in the intercepted texts — dedupe.
  const seen = new Set<string>();
  const rules: PseudoStateRule[] = [];
  for (const r of raw) {
    const key = `${r.capId}|${r.pseudo}|${r.media ?? ""}|${JSON.stringify(r.decls)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(r as PseudoStateRule);
  }
  return rules;
}

function parseCssForFonts(
  cssText: string,
  baseUrl: string,
  fontFaceMap: Map<string, FontFace>,
  onUrl: (url: string) => void,
): void {
  const abs = (u: string): string => {
    try { return new URL(u, baseUrl).href; } catch { return u; }
  };
  // Extract @font-face blocks. src urls are rewritten to absolute so they can be
  // resolved/downloaded regardless of where the CSS file lived.
  const faceRe = /@font-face\s*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = faceRe.exec(cssText)) !== null) {
    const block = m[1]!;
    const family = /font-family\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    let src = /src\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    if (!family || !src) continue;
    src = src.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_full, _q, u) =>
      u.startsWith("data:") ? `url(${u})` : `url(${abs(u)})`);
    const weight = /font-weight\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    const style = /font-style\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    const display = /font-display\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    const unicodeRange = /unicode-range\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    const key = `${family}|${weight ?? ""}|${style ?? ""}|${src}`;
    if (!fontFaceMap.has(key)) {
      fontFaceMap.set(key, { family, src, weight, style, display, unicodeRange });
    }
  }
  // Extract all url() references for asset discovery.
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  while ((m = urlRe.exec(cssText)) !== null) {
    const raw = m[2];
    if (raw && !raw.startsWith("data:")) onUrl(abs(raw));
  }
}
