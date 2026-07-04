import { chromium, type Browser, type BrowserContext } from "playwright";
import { join } from "node:path";
import { collectPage, type PageSnapshot, type FontFace } from "./walker.js";
import { tagElements, captureInteractions, type InteractionCapture } from "./interactions.js";
import { captureMotion, probeReveals, type MotionCapture } from "./motion.js";
import {
  promoteLazyMedia, settleCarousels, settleScrollReveals, neutralizePreReveal,
  forceRevealForShot, restoreRevealForShot, neutralizeScrollTimelineAnimations,
} from "./stabilize.js";
import {
  enumerateFramesInPage, planForFrameUrl, graftFrameIntoSnapshot, frameHasRenderableContent,
  MAX_GRAFT_FRAMES, FRAME_GRAFT_MAX_NODES, type FrameCandidate,
} from "./graft.js";
import { discoverBreakpoints } from "./breakpoints.js";
import { writeJSON, writeJSONCompact, writeBytes, ensureDir } from "../util/fsx.js";
import { sha1_12, round } from "../util/canonical.js";
import { isZipArchive, extractDotLottieJson } from "./dotlottie.js";
import { buildDeterministicEnvShim, captureEpochMs, DEFAULT_PRNG_SEED } from "../util/envShim.js";
import { isBotWall, classifyNavFailure } from "../util/captureFailure.js";

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
  // Deterministic-env shim parameters actually used for this run (Item 1). Recorded
  // so a recapture can reuse the exact {seed, epochMs} — the pinned wall clock is a
  // run-metadata value, not a hardcoded constant. Absent when the shim was disabled.
  deterministicEnv?: { seed: number; epochMs: number };
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
};

function viewportHeight(width: number): number {
  return VIEWPORT_HEIGHTS[width] ?? Math.round(width * 0.66);
}

// ---- Asset download retry (Fix: transient failures silently degrade to placeholders) ----

/** Types whose absence is visible in the clone (image → transparent GIF, video → blank,
 *  font → fallback face). These earn one retry; css/manifest/lottie degrade gracefully. */
const RETRYABLE_ASSET_TYPES = new Set(["image", "svg", "video", "font"]);
/** Fixed, bounded delay before the single retry — deterministic (no jitter/backoff). */
export const ASSET_RETRY_DELAY_MS = 750;

/** Should a failed download of `type` with HTTP `status` (null = network error / no
 *  response) be retried once? Transient states only: connection failures, 5xx, and 429.
 *  4xx (404/403/…) are authoritative — retrying can't change them. */
export function isRetryableAssetFailure(type: string, status: number | null): boolean {
  if (!RETRYABLE_ASSET_TYPES.has(type)) return false;
  if (status === null) return true;
  return status >= 500 || status === 429;
}

// Bound on a preserved file extension. Real extensions are short, but a hard 5-char cap
// silently truncates legitimate ones (`.lottie` → `.lotti`, `.webmanifest` → `.webma`),
// which then mis-materializes the asset. Keep the guard generous enough for the longest
// real extensions and reject anything absurdly long (a dotted path segment, not an ext).
const MAX_EXT_LEN = 12;

export function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const dot = p.lastIndexOf(".");
    if (dot >= 0 && dot > p.lastIndexOf("/")) {
      const ext = p.slice(dot + 1).toLowerCase();
      if (ext.length <= MAX_EXT_LEN && /^[a-z0-9]+$/.test(ext)) return ext;
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

/** Container-magic check for accepted video bytes: ISO-BMFF (`ftyp` within the first
 *  12 bytes — mp4/m4v/mov), webm/mkv (EBML 0x1A45DFA3), or ogg (`OggS`). A range
 *  fragment (e.g. an mp4's moov-atom tail served as a 206) fails all three, so a
 *  corrupt partial body is never stored as the asset. */
export function looksLikeVideoFile(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const head = bytes.subarray(0, 12);
  if (head.includes("ftyp")) return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // EBML (webm/mkv)
  if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return true; // "OggS"
  return false;
}

/** Container-magic check for accepted font bytes, mirroring `looksLikeVideoFile`. A router that
 *  answers 200+HTML for an unknown `/media/*` path (common on SPA hosts) otherwise gets stored as
 *  a `.woff2`; the browser rejects it as a font and the whole page falls through to a system
 *  fallback. Accept only the real font-container signatures — woff2 (`wOF2`), woff (`wOFF`),
 *  OpenType/CFF (`OTTO`), TrueType (`\x00\x01\x00\x00` or `true`/`ttcf`), and EOT (the version
 *  header at bytes 8..11 is `\x01\x00\x01\x00`/`\x02\x00\x01\x00`, so key EOT off its unique
 *  0x504C signature at offset 34) — and explicitly reject an HTML/text body. */
export function looksLikeFontFile(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const b0 = bytes[0]!, b1 = bytes[1]!, b2 = bytes[2]!, b3 = bytes[3]!;
  // A leading `<` (`<!DOCTYPE`, `<html`, `<?xml`, `<svg`) is never a binary font container.
  if (b0 === 0x3c) return false;
  const tag = bytes.subarray(0, 4).toString("latin1");
  if (tag === "wOF2" || tag === "wOFF") return true; // woff2 / woff
  if (tag === "OTTO" || tag === "true" || tag === "ttcf") return true; // CFF OpenType / TrueType / TrueType collection
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return true; // TrueType sfnt (\x00\x01\x00\x00)
  // EOT: a little-endian byte count precedes a version/flags header; its stable marker is the
  // 0x504C ("LP") magic at byte offset 34.
  if (bytes.length >= 36 && bytes[34] === 0x4c && bytes[35] === 0x50) return true;
  return false;
}

/**
 * A `<source>` candidate for the HTML media resource-selection algorithm. `media`/`type` are the
 * raw attribute strings (null/undefined when absent, matching a missing attribute).
 */
export interface VideoSourceCandidate {
  media?: string | null;
  type?: string | null;
}

/**
 * Pure re-implementation of the source-selection step of the HTML media resource-selection
 * algorithm: return the index of the FIRST `<source>` (document order) that is eligible NOW, or -1
 * when none is. A source is eligible when its `media` query matches (a missing/empty media matches
 * unconditionally) AND the UA can play its `type` (a missing/empty type is not a disqualifier —
 * `canPlayType` is only consulted when a type is present).
 *
 * The predicates are injected so this is testable in Node (the in-page caller passes the real
 * `matchMedia`/`canPlayType`). Kept deterministic: no state, first-match wins in document order.
 */
export function selectVideoSourceIndex(
  sources: VideoSourceCandidate[],
  mediaMatches: (media: string) => boolean,
  canPlay: (type: string) => boolean,
): number {
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    const media = (s.media ?? "").trim();
    if (media && !mediaMatches(media)) continue;
    const type = (s.type ?? "").trim();
    if (type && !canPlay(type)) continue;
    return i;
  }
  return -1;
}

/**
 * Pure decision for the per-video seek in normalizeVideoTime, extracted so the reloaded-set /
 * seek-target branch is unit-testable in Node (the in-page loop applies the same rule to real
 * elements). Returns the seek to perform after the re-selection reload pass, or null to fast-skip.
 *
 * - A `reloaded` video sits at t=0 with the HTML element's show-poster flag freshly set. Seeking to
 *   0 would be a no-op that fires no `seeked` and leaves the poster showing, so force a genuine seek
 *   to a tiny epsilon to clear the flag and paint the new source's frame 0.
 * - A non-reloaded video already at t≈0 needs nothing (skip). Otherwise seek it back to 0.
 */
export function planVideoSeek(
  reloaded: boolean,
  currentTime: number,
): { target: number } | null {
  const EPSILON = 1e-4;
  if (reloaded) return { target: EPSILON };
  if (Math.abs(currentTime) < 1e-3) return null;
  return { target: 0 };
}

async function autoScroll(page: import("playwright").Page, vpHeight: number): Promise<void> {
  // Scroll through the page to trigger lazy-loaded images/backgrounds, then return
  // to the top so document-coordinate bboxes are measured from a settled layout.
  await page.evaluate(async (step: number) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
    let y = 0;
    let guard = 0;
    while (y < maxScroll() && guard < 100) {
      y += step;
      window.scrollTo(0, y);
      await sleep(60);
      guard++;
    }
    window.scrollTo(0, 0);
    await sleep(120);
  }, Math.max(Math.round(vpHeight * 0.8), 300));
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

/**
 * Stage 2 — scroll-state reset immediately before a per-viewport snapshot. The motion /
 * dwell-scroll / carousel / element-screenshot passes above all leave the page scrolled or
 * mid-transition; scroll-linked styles (Webflow scroll-state transforms, position:sticky
 * offsets) then get baked into the captured computed styles for THAT viewport only, so a
 * scroll-driven translateY leaks into one band and cascades. Reset window + inner scrollers
 * to the top, wait for scroll-linked effects to settle across a few rAF ticks plus a short
 * quiescence window, THEN let the caller snapshot. Bounded and deterministic.
 */
async function settleScrollTopBeforeSnapshot(page: import("playwright").Page): Promise<void> {
  try {
    await Promise.race([
      page.evaluate(async () => {
        const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const resetAll = () => {
          window.scrollTo(0, 0);
          for (const el of Array.from(document.querySelectorAll("*"))) {
            if (el.scrollLeft) el.scrollLeft = 0;
            if (el.scrollTop) el.scrollTop = 0;
          }
        };
        resetAll();
        // Let scroll-linked effects (scroll-state classes, sticky offsets, JS scroll handlers)
        // recompute at scroll 0 over several frames, re-asserting the top position each tick in
        // case a handler nudged it, then hold briefly for quiescence.
        for (let i = 0; i < 6; i++) { await raf(); resetAll(); }
        await new Promise<void>((r) => setTimeout(r, 120));
        resetAll();
        await raf();
      }),
      new Promise<void>((r) => setTimeout(r, 4000)),
    ]);
  } catch { /* ignore — a best-effort reset never blocks the snapshot */ }
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
/**
 * In-page dismissal click pass (exported for fixture tests). Runs in ONE document — the main
 * page OR a cross-origin frame (Attentive/Recart/Klaviyo creatives host their Decline/× inside
 * an iframe, so the caller runs this in every `page.frames()`). Traverses open shadow roots
 * (Recart mounts its popup in a shadow tree) when scanning both containers and buttons.
 */
export function clickDismissInPage(): string[] {
  const dismissed: string[] = [];
  // Deep collector across open shadow roots.
  const deepEls = (root: ParentNode, sel: string): Element[] => {
    const out: Element[] = [];
    const walk = (r: ParentNode): void => {
      let hits: Element[] = [];
      try { hits = Array.from(r.querySelectorAll(sel)); } catch { /* invalid selector */ }
      out.push(...hits);
      for (const el of Array.from(r.querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(root);
    return out;
  };
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
    for (const el of deepEls(document, sel)) {
      if (vis(el)) { click(el); dismissed.push(sel); break; }
    }
  }

  // 2) Scoped text-button pass: only inside overlay-ish containers (dialogs, or id/class naming
  //    cookie/consent/modal/popup/newsletter/overlay/ccpa/privacy) so we never click an ordinary
  //    page button. ACCEPT now also covers email-capture DECLINE affordances ("decline",
  //    "no thanks", "not now", …) — a popup's own opt-out is the surest deterministic close.
  const ACCEPT = new Set([
    "accept", "accept all", "accept all cookies", "accept cookies", "accept & close",
    "i accept", "i agree", "agree", "agree and continue", "allow all", "allow cookies",
    "allow all cookies", "got it", "ok", "okay", "continue", "no thanks", "no, thanks",
    "dismiss", "close", "got it!", "understood", "yes, i agree",
    "decline", "no, thank you", "not now", "maybe later", "no thank you", "skip", "reject all",
  ]);
  const containerSel =
    "[role='dialog'],[aria-modal='true'],[id*='cookie' i],[class*='cookie' i],[id*='consent' i]," +
    "[class*='consent' i],[class*='gdpr' i],[id*='gdpr' i],[class*='modal' i],[class*='popup' i]," +
    "[class*='newsletter' i],[class*='interstitial' i],[class*='overlay' i],[id*='overlay' i]," +
    "[class*='ccpa' i],[id*='ccpa' i],[class*='privacy' i],[id*='pop' i]";
  const containers = deepEls(document, containerSel);
  for (const c of containers) {
    if (!vis(c)) continue;
    // Text/value-matched accept/decline buttons.
    const btns = deepEls(c, "button,[role='button'],a,input[type='button'],input[type='submit']");
    let clicked = false;
    for (const b of btns) {
      const t = (b.textContent || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t && ACCEPT.has(t) && vis(b)) { click(b); dismissed.push("text:" + t); clicked = true; break; }
    }
    if (clicked) continue;
    // aria-label / title close affordance (icon-only ×, no text content to match).
    const closers = deepEls(c, "[aria-label*='close' i],[aria-label*='dismiss' i],[title*='close' i],button.close,.close-button,[class*='close' i][role='button']");
    for (const x of closers) {
      if (vis(x)) { click(x); dismissed.push("close:" + ((x.getAttribute("aria-label") || x.getAttribute("title") || "x")).slice(0, 24)); break; }
    }
  }
  return dismissed;
}

async function clickDismiss(page: import("playwright").Page): Promise<string[]> {
  // Run the click pass in the main document AND every frame — cross-origin popup creatives
  // (Attentive/Recart/…) host their Decline/close controls inside an iframe that the top
  // document cannot reach, but Playwright can evaluate inside each frame from Node.
  const runOne = (frame: import("playwright").Frame): Promise<string[]> =>
    Promise.race([
      frame.evaluate(clickDismissInPage).catch(() => [] as string[]),
      new Promise<string[]>((res) => setTimeout(() => res([]), 6000)),
    ]);
  try {
    const frames = page.frames();
    const results = await Promise.all(frames.map((f) => runOne(f).catch(() => [] as string[])));
    return results.flat();
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
export type FinalizeOverlaysResult = { overlaysRemaining: number; removed: number; blocking: boolean; removedLabels: string[] };

/**
 * In-page overlay finalizer (exported so fixture tests can page.evaluate it directly).
 * Detects any full-viewport, fixed/sticky BLOCKING layer still present and — when the page
 * is scroll-locked (a state legit pages never enter) — removes it. Key robustness rules:
 *
 *  (a) EFFECTIVE z-index: an element with `z-index:auto` inherits its stacking position from
 *      the nearest positioned/opacity/transform ancestor that establishes a stacking context.
 *      A vendor popup iframe is z:auto but sits inside a z=INT_MAX wrapper, so per-element
 *      `parseInt("auto")` under-reads it — resolve z through the ancestor chain instead.
 *  (b) LOCK relaxes the z gate: on a scroll-locked page, ANY fixed/sticky full-viewport layer
 *      is blocking regardless of z (catches a z:auto creative and a z=50 CCPA dialog). Off a
 *      locked page we keep the z>=100 floor to avoid stripping legit fixed content.
 *  (c) OVERLAY UNIT: a 0-size (height:0) max-z wrapper whose descendant is a full-viewport
 *      fixed iframe is ONE overlay — the wrapper carries the z, the iframe carries the pixels.
 *      Detecting either means removing BOTH (climb from a removable iframe to its high-z
 *      wrapper ancestor; and treat a max-z 0-size wrapper as an overlay via its full-viewport
 *      descendant). Neither alone passes the area+z gate, so they must be grouped.
 *  (d) LOUD FAILURE: if the lock persists after removal (or was locked with nothing detected),
 *      report blocking=true so the pollution gate fails rather than shipping a polluted capture.
 */
export function finalizeOverlaysInPage(): FinalizeOverlaysResult {
  const vw = window.innerWidth, vh = window.innerHeight;
  // Deep element walk that descends into OPEN shadow roots. A shadow host reports 0 light-DOM
  // children, so a popup mounted inside a shadow tree (Recart's `#recart-popup-root`) is invisible
  // to a plain `querySelectorAll("*")` — its full-viewport fixed layer would never be detected and
  // would paint into every screenshot. Traverse `element.shadowRoot` (open only; closed roots are
  // unreachable — the host itself is still caught by the geometry gate below and removed whole).
  const deepEls = (root: ParentNode): Element[] => {
    const out: Element[] = [];
    const push = (r: ParentNode): void => {
      for (const el of Array.from(r.querySelectorAll("*"))) {
        out.push(el);
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) push(sr);
      }
    };
    push(root);
    return out;
  };
  const isLocked = (): boolean => {
    const b = document.body, h = document.documentElement;
    const bs = getComputedStyle(b), hs = getComputedStyle(h);
    return bs.overflow === "hidden" || hs.overflow === "hidden" ||
      bs.overflowY === "hidden" || hs.overflowY === "hidden" ||
      bs.position === "fixed" || bs.position === "absolute";
  };
  // Effective z-index: climb to the nearest ancestor that both is positioned/creates a stacking
  // context AND reports a numeric z-index. `z-index:auto` on a positioned child paints in its
  // parent stacking context, so the parent's z is the layer's true stacking rank.
  const effectiveZ = (el: Element): number => {
    let cur: Element | null = el;
    let hops = 0;
    while (cur && hops < 20) {
      const cs = getComputedStyle(cur);
      const zi = parseInt(cs.zIndex || "", 10);
      const positioned = cs.position !== "static";
      if (Number.isFinite(zi) && positioned) return zi;
      cur = cur.parentElement;
      hops++;
    }
    return 0;
  };
  const rectOf = (el: Element) => (el as HTMLElement).getBoundingClientRect();
  const fullViewport = (r: DOMRect): boolean => r.width >= vw * 0.7 && r.height >= vh * 0.5 && (r.width * r.height) / (vw * vh) >= 0.5;
  const painting = (cs: CSSStyleDeclaration): boolean =>
    cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") !== 0;

  const locked = isLocked();

  // Candidate blocking layers. A layer qualifies when it is fixed/sticky, painting, and either
  // (1) itself full-viewport, or (2) a 0-size/high-z wrapper whose descendant is full-viewport
  // (the overlay-unit case — the wrapper holds the z, an inner iframe holds the pixels).
  // Full-viewport descendant test that pierces shadow roots (Recart mounts the covering layer
  // inside the host's shadow tree, so a light-DOM `querySelectorAll` would find nothing).
  const hasFullDescendant = (el: Element): boolean => {
    const scope: ParentNode = (el as HTMLElement).shadowRoot ?? el;
    return deepEls(scope).some((d) => { const dcs = getComputedStyle(d); return painting(dcs) && (dcs.position === "fixed" || dcs.position === "sticky" || dcs.position === "absolute") && fullViewport(rectOf(d)); });
  };
  const bigOverlays = (): HTMLElement[] => {
    const out: HTMLElement[] = [];
    for (const el of deepEls(document.body)) {
      const cs = getComputedStyle(el);
      const isShadowHost = !!(el as HTMLElement).shadowRoot;
      // A shadow host is usually position:static with a fixed layer INSIDE its root; still test it
      // (via its shadow descendants) so the whole host can be removed as one overlay unit.
      if (cs.position !== "fixed" && cs.position !== "sticky" && !isShadowHost) continue;
      if (!painting(cs)) continue;
      const r = rectOf(el);
      const z = effectiveZ(el);
      // Off a locked page keep the z>=100 floor; on a locked page any full-viewport fixed
      // layer is blocking (rule b). A max-z wrapper is a blocking layer even at 0 size when it
      // wraps a full-viewport descendant (rule c) — legit chrome never reaches the INT_MAX band.
      const positioned = cs.position === "fixed" || cs.position === "sticky";
      const selfFull = positioned && fullViewport(r);
      const wrapsFull = (isShadowHost || r.width < 4 || r.height < 4) && (isShadowHost || z >= 100) && hasFullDescendant(el);
      if (!selfFull && !wrapsFull) continue;
      const zPass = locked || z >= 100 || (wrapsFull && isShadowHost);
      if (zPass) out.push(el as HTMLElement);
    }
    // Keep outermost only (a wrapper subsumes its inner full-viewport iframe — the overlay unit).
    // `Node.contains` does NOT cross shadow boundaries, so also treat a candidate that lives inside
    // another candidate's shadow tree as contained — otherwise a shadow host AND its inner layer
    // both survive and we double-remove (or leave the inner layer behind).
    const shadowContains = (host: Element, node: Element): boolean => {
      let cur: Node | null = node;
      while (cur) {
        const rootNode = cur.getRootNode();
        if (rootNode instanceof ShadowRoot) {
          if (rootNode.host === host || host.contains(rootNode.host)) return true;
          cur = rootNode.host;
        } else break;
      }
      return false;
    };
    return out.filter((el) => !out.some((o) => o !== el && (o.contains(el) || shadowContains(o, el))));
  };

  // A scroll-locked page behind a full-viewport overlay IS a blocking modal by definition
  // (legit pages don't scroll-lock). Remove ANY such overlay that isn't page chrome — many
  // modals/drawers carry no consent/modal keyword and an icon-only close, so a keyword/aria
  // allowlist misses them. PROTECTED guards real chrome (header/nav/footer) only.
  const PROTECTED = /header|navbar|nav-|site-nav|topbar|masthead|footer/i;
  const sig = (el: HTMLElement): string => `${el.id} ${el.className}`.toString();

  const removedLabels: string[] = [];
  let removed = 0;
  let remaining = bigOverlays();
  if (remaining.length && locked) {
    for (const el of remaining) {
      const s = sig(el);
      const z = effectiveZ(el);
      // Scroll-locked + full-viewport ⇒ blocking modal; remove unless it's page chrome. Always
      // remove iframes (cross-origin close, unclickable), max-z wrappers, and the overlay unit:
      // when the layer IS or CONTAINS a full-viewport fixed iframe, remove the whole subtree
      // (rule c — the 0-size wrapper + its iframe come out together as one node).
      const isShadowHost = !!(el as HTMLElement).shadowRoot;
      const containsIframe = el.tagName === "IFRAME" || !!el.querySelector("iframe") ||
        (isShadowHost && !!(el as HTMLElement).shadowRoot!.querySelector("iframe"));
      const removable = !PROTECTED.test(s) || el.getAttribute("aria-modal") === "true" ||
        containsIframe || isShadowHost || z >= 100;
      if (removable) { el.remove(); removed++; removedLabels.push((el.id || el.className || el.tagName).toString().slice(0, 40)); }
    }
    if (removed) {
      document.body.style.overflow = "visible"; document.documentElement.style.overflow = "visible";
      document.body.style.overflowY = "visible"; document.documentElement.style.overflowY = "visible";
      document.body.style.position = "static";
    }
    remaining = bigOverlays();
  }
  // Loud failure (rule d): a persisting lock is blocking whether or not a specific overlay was
  // still detectable — a scroll-locked capture is polluted, so surface it to the pollution gate.
  const stillLocked = isLocked();
  return { overlaysRemaining: remaining.length, removed, blocking: stillLocked && (remaining.length > 0 || locked), removedLabels };
}

async function finalizeOverlays(page: import("playwright").Page): Promise<FinalizeOverlaysResult> {
  try {
    return await Promise.race([
      page.evaluate(finalizeOverlaysInPage),
      new Promise<FinalizeOverlaysResult>((res) => setTimeout(() => res({ overlaysRemaining: 0, removed: 0, blocking: false, removedLabels: [] }), 6000)),
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
 * Stage 2 — canvas raster fallback. A visible <canvas> (animated background, chart,
 * WebGL scene) is a runtime-drawn surface the clone cannot reproduce as DOM, so it
 * would render as an empty box. Rasterize each meaningful canvas to a PNG still under
 * a synthetic URL (the normal asset pipeline rewrites it to a local file); the node is
 * then marked with a `src` attr so generation emits the still as an <img> filling the
 * canvas's box. `toDataURL` is exact but THROWS for tainted canvases and for WebGL
 * contexts without preserveDrawingBuffer — those return a shot plan for the node-side
 * element-screenshot fallback (composited pixels, works regardless). A WebGL canvas may
 * also toDataURL to a blank image when the drawing buffer was already presented; that
 * blank is accepted as-is (detecting blankness would be heuristic, not deterministic).
 * The in-page part is exported for the fixture tests (page.evaluate'd directly).
 */
export type CanvasStillPlan = { stills: Array<{ url: string; dataUrl: string; sel: string }>; shots: Array<{ url: string; sel: string }> };
export function captureCanvasStillsInPage(): CanvasStillPlan {
  const stills: CanvasStillPlan["stills"] = [];
  const shots: CanvasStillPlan["shots"] = [];
  const hash = (s: string): string => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const canvases = Array.from(document.querySelectorAll("canvas"));
  let i = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue; // not a meaningful painted surface
    const cs = getComputedStyle(c);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") < 0.05) continue;
    const idx = i++;
    c.setAttribute("data-clone-canvas", String(idx));
    const sel = `canvas[data-clone-canvas="${idx}"]`;
    const url = `https://clone-canvas.local/${idx}-${hash(c.id + "|" + c.width + "|" + c.height + "|" + idx)}.png`;
    let ok = false;
    try {
      const dataUrl = c.toDataURL("image/png"); // throws if tainted / WebGL buffer unreadable
      if (dataUrl.startsWith("data:image/png")) { stills.push({ url, dataUrl, sel }); ok = true; }
    } catch { /* fall through to the element-screenshot plan */ }
    if (!ok) shots.push({ url, sel });
  }
  return { stills, shots };
}

async function captureCanvasStills(page: import("playwright").Page): Promise<CanvasStillPlan> {
  try {
    return await Promise.race([
      page.evaluate(captureCanvasStillsInPage),
      new Promise<CanvasStillPlan>((res) => setTimeout(() => res({ stills: [], shots: [] }), 12_000)),
    ]);
  } catch {
    return { stills: [], shots: [] };
  }
}

// Chromium refuses/truncates screenshots past a texture-size cap; keep clip dimensions
// under a conservative bound so captureFullPageViaCDP fails cleanly (→ Playwright fallback)
// instead of returning a truncated image on pathologically tall pages.
const CDP_MAX_SHOT_DIMENSION = 16_384;

/**
 * Item 2: extended lazy-asset DISCOVERY. Returns the deduped, sorted set of asset
 * URLs referenced through channels the walker + promoteLazyMedia miss:
 *   (1) <noscript> fallback markup (the walker skips <noscript> entirely) — parsed as
 *       HTML so real img/source src + srcset are read, not regex-scraped;
 *   (2) inline element style="…url(…)…" (the walker harvests url() from STYLESHEET
 *       rules only, not from an element's own style attribute);
 *   (3) data-background / data-background-image lazy-bg aliases (beyond promoteLazyMedia's
 *       single data-bg);
 *   (4) img[loading=lazy] currentSrc — the variant a below-fold image resolved to.
 * data: URLs and unresolvable refs are dropped. Discovery-only: the caller RECORDS these
 * for the fallback downloader; nothing here mutates the DOM (snapshots are already taken).
 * Exported for the fixture tests (page.evaluate'd directly).
 */
export function discoverLazyAssetsInPage(): string[] {
  const urls = new Set<string>();
  const push = (v: string | null | undefined): void => {
    if (!v) return;
    const s = v.trim();
    if (!s || s.startsWith("data:")) return;
    try { urls.add(new URL(s, document.baseURI).href); } catch { /* not a URL */ }
  };
  const firstOfSrcset = (ss: string): void => {
    for (const part of ss.split(",")) push(part.trim().split(/\s+/)[0]);
  };
  // (1) <noscript> fallback markup.
  for (const ns of Array.from(document.querySelectorAll("noscript"))) {
    const html = ns.textContent ?? "";
    if (!html.includes("<")) continue;
    let frag: Document;
    try { frag = new DOMParser().parseFromString(html, "text/html"); } catch { continue; }
    for (const el of Array.from(frag.querySelectorAll("img,source"))) {
      push(el.getAttribute("src"));
      const ss = el.getAttribute("srcset");
      if (ss) firstOfSrcset(ss);
    }
  }
  // (2) inline style url(...) on any element (background-image / mask / etc.).
  for (const el of Array.from(document.querySelectorAll("[style]"))) {
    const st = el.getAttribute("style") ?? "";
    if (!st.includes("url(")) continue;
    for (const m of st.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) push(m[2]);
  }
  // (3) lazy-background data-* aliases the promoter doesn't cover.
  const BG_ATTRS = ["data-background", "data-background-image"];
  for (const el of Array.from(document.querySelectorAll(BG_ATTRS.map((a) => `[${a}]`).join(",")))) {
    for (const a of BG_ATTRS) {
      const raw = el.getAttribute(a);
      if (!raw) continue;
      const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(raw);
      push(m ? m[2] : raw);
    }
  }
  // (4) the variant a lazy image actually resolved to.
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img[loading=lazy]"))) {
    push(img.currentSrc || img.src);
  }
  return [...urls].sort();
}

/**
 * Full-page screenshot via CDP `Page.captureScreenshot` with `captureBeyondViewport:true`.
 * Unlike Playwright's `fullPage:true` (which scroll-stitches — scrolling the page to render
 * each band, FIRING scroll events that drive scroll-linked animations, e.g. IX2 grow-on-scroll
 * or WAAPI scroll-timelines), CDP renders the whole page in ONE shot WITHOUT scrolling and
 * never fires scroll events. So the resulting still is the genuine at-rest (unscrolled) page,
 * matching the DOM snapshot the walk grades. Writes a PNG to `path`. Throws on any failure so
 * the caller can fall back to the Playwright path.
 */
export async function captureFullPageViaCDP(page: import("playwright").Page, path: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    const metrics = await client.send("Page.getLayoutMetrics") as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;
    if (!size || !(size.width > 0) || !(size.height > 0)) throw new Error("cdp: empty content size");
    const width = Math.ceil(size.width);
    const height = Math.ceil(size.height);
    if (width > CDP_MAX_SHOT_DIMENSION || height > CDP_MAX_SHOT_DIMENSION) {
      throw new Error(`cdp: content ${width}x${height} exceeds max shot dimension`);
    }
    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }) as { data: string };
    if (!shot?.data) throw new Error("cdp: no screenshot data");
    writeBytes(path, Buffer.from(shot.data, "base64"));
  } finally {
    await client.detach().catch(() => { /* ignore */ });
  }
}

/**
 * Full-page screenshot with robustness for heavy/animated pages. Prefers CDP capture
 * (captureFullPageViaCDP — no scroll-stitch, so scroll-linked animations aren't scrubbed
 * and the still is the true at-rest page). On ANY CDP failure, falls back to Playwright's
 * `fullPage:true` (which scroll-stitches but freezes animations); the default 30s timeout
 * is exceeded by tall pages (Playwright also waits for web fonts), so use a long timeout and
 * retry. As a last resort take a viewport-only shot so the file exists (the capture gate
 * checks presence; a partial image still beats none).
 */
async function captureScreenshot(
  page: import("playwright").Page,
  path: string,
  vw: number,
  log: (e: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await captureFullPageViaCDP(page, path);
    log({ event: "screenshot_cdp", viewport: vw });
    return;
  } catch (eCdp) {
    log({ event: "screenshot_cdp_fallback", viewport: vw, error: String(eCdp).slice(0, 200) });
  }
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

/**
 * Pause every <video> and seek it to time 0, then wait for that seek to actually PAINT, so a
 * screenshot taken right after is deterministic. A video's playback time is runtime state: a one-shot
 * animation ends on its last frame, an autoplaying loop sits at an arbitrary offset, and the time a
 * given viewport's shot happens to catch is nondeterministic. Without normalization the SOURCE and the
 * (frame-0, non-playing) CLONE can show different frames of the same element — a phantom perceptual
 * diff that no CSS change can close. Seeking BOTH sides to frame 0 before EVERY viewport screenshot
 * removes it. `seeked` fires once the new frame is decoded; we still yield two rAFs so the compositor
 * has painted it before the screenshot reads pixels. Bounded so a stalled/unseekable video can't hang.
 *
 * FIRST it re-runs `<source media>` resource selection for THIS viewport. The capture pipeline loads
 * the page once at the canonical width and reaches every other viewport by resizing — but the HTML
 * media resource-selection algorithm evaluates `<source media>` only at load, so an aspect/orientation
 * -gated hero video stays frozen on whatever variant matched at load width across all resized shots.
 * The validator fresh-loads per viewport and correctly re-selects, so the two channels disagree on
 * which variant is on screen (a large phantom diff on full-bleed portrait/landscape hero videos).
 * Re-selecting here keeps the channels symmetric; it is a no-op on the fresh-loading validator side
 * and — the common case — a no-op whenever the current selection is still the right one, so the fast
 * path never touches `video.load()`.
 */
export async function normalizeVideoTime(
  page: import("playwright").Page,
  log?: (event: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const reselections = await page.evaluate(async () => {
      const vids = Array.from(document.querySelectorAll("video"));
      const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

      // Re-select the <source> the resource-selection algorithm would pick at the CURRENT viewport,
      // mirroring selectVideoSourceIndex (Node-side, unit-tested): first source in document order
      // whose media matches (missing media matches unconditionally) and whose type is playable
      // (missing type is never disqualifying). Only reload when the winner differs from what is
      // currently loaded — the fast path leaves untouched videos alone.
      //
      // Track which videos we reloaded. A reload resets the element's *show-poster flag* to true and
      // sets currentTime to 0; the follow-up pause() cancels the pending autoplay, so the one thing
      // that would have cleared that flag (playback beginning) never happens. Left uncleared, the
      // element renders its `poster` image — which for an aspect-gated hero is a frame of the WRONG
      // variant — instead of the freshly-selected source's frame 0. A real seek is the other
      // flag-clearing path, but the fast-skip below bails at t=0. So force a genuine seek (to a tiny
      // epsilon, not to the already-current 0) on exactly the reloaded videos to clear the flag and
      // present the new source's decoded frame. Non-reloaded videos keep the existing fast skip.
      const reloaded = new WeakSet<HTMLVideoElement>();
      const reselections: { from: string; to: string; readyState: number }[] = [];
      const reloadWaits: Promise<void>[] = [];
      for (const v of vids) {
        try {
          const sources = Array.from(v.querySelectorAll("source"));
          if (sources.length === 0) continue; // src attribute (no <source> children): nothing to re-select
          let winner: HTMLSourceElement | null = null;
          for (const s of sources) {
            const media = (s.getAttribute("media") ?? "").trim();
            if (media && !window.matchMedia(media).matches) continue;
            const type = (s.getAttribute("type") ?? "").trim();
            if (type && !v.canPlayType(type)) continue;
            winner = s;
            break;
          }
          if (!winner || !winner.src) continue;
          // Compare resolved URLs; currentSrc is absolute, winner.src is already resolved.
          if (v.currentSrc === winner.src) continue; // no change — fast path, do not reload
          const from = v.currentSrc;
          const to = winner.src;
          v.load();
          reloaded.add(v);
          reloadWaits.push(new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              v.removeEventListener("loadeddata", done);
              v.removeEventListener("seeked", done);
              reselections.push({ from, to, readyState: v.readyState });
              resolve();
            };
            if (v.readyState >= 2 /* HAVE_CURRENT_DATA */) { done(); return; }
            // A post-reload `seeked` implies a decoded frame is ready too, so treat it as an
            // additional readiness signal: on slow CDNs the epsilon seek (below) can land its
            // `seeked` before `loadeddata`, which unblocks the FIRST viewport instead of waiting
            // out the 4s bound and shooting the poster.
            v.addEventListener("loadeddata", done, { once: true });
            v.addEventListener("seeked", done, { once: true });
            setTimeout(done, 4000); // bound: a stalled reload resolves anyway so the shot never hangs
          }));
        } catch { /* a malformed <source>/media query must not block the others */ }
      }

      const waits: Promise<void>[] = [];
      const seekTo = (v: HTMLVideoElement, t: number) =>
        new Promise<void>((resolve) => {
          let settled = false;
          const done = () => { if (settled) return; settled = true; v.removeEventListener("seeked", done); resolve(); };
          v.addEventListener("seeked", done, { once: true });
          try { v.currentTime = t; } catch { done(); }
          setTimeout(done, 400); // bound: a stalled/unseekable video resolves anyway
        });
      for (const v of vids) {
        try { v.pause(); } catch { /* ignore */ }
        if (reloaded.has(v)) {
          // A just-reloaded video sits at t=0 with the show-poster flag set. Seek to a tiny epsilon
          // (not 0, which is already the current time and would fire no `seeked`) to force a genuine
          // seek: it clears the flag and paints the new source's frame 0. Start it eagerly so its
          // `seeked` can also satisfy the reload wait above on slow networks.
          waits.push(seekTo(v, 1e-4));
          continue;
        }
        // Seek to 0 only when not already there (a fresh seek to the current time may not fire `seeked`).
        if (Math.abs(v.currentTime) < 1e-3) continue;
        waits.push(seekTo(v, 0));
      }
      // Await the reload settles and the seeks together; the reload wait can be released by an
      // epsilon seek's `seeked`, so both sets must be in flight before we block on either.
      await Promise.all([...reloadWaits, ...waits]);
      await raf(); await raf(); // let the decoded frame composite before the screenshot reads pixels
      return reselections;
    });
    if (log && reselections && reselections.length) {
      for (const r of reselections) {
        log({ event: "video_source_reselected", from: r.from, to: r.to, readyState: r.readyState });
      }
    }
  } catch { /* a page with no videos / an eval hiccup must never block the screenshot */ }
}

export async function captureSite(opts: {
  url: string;
  outDir: string; // source/ directory
  viewports?: number[];
  interactions?: boolean; // Stage 4: opt-in interaction capture (hover/focus + patterns)
  motion?: boolean; // Stage 5: opt-in motion capture (WAAPI + rotating text)
  breakpoints?: boolean; // discover the source's real responsive band edges (default on; read-only sweep)
  deterministicEnv?: boolean; // Item 1: seed Math.random + pin the Date epoch BEFORE page JS runs
                              // (default on), so shuffled carousels / random ids / relative-time text
                              // ("posted N minutes ago") render the same across captures. Relative time
                              // still advances (timers behave) and performance.now() stays real.
  captureEpochMs?: number | string; // pinned wall-clock origin for the shim (ms since epoch, or a
                                     // date string). Recorded in the result; a recapture passes the
                                     // previously-recorded value to reproduce time-dependent content.
  prngSeed?: number; // mulberry32 seed for the pinned Math.random (recorded in the result).
  screenshots?: boolean; // write per-viewport full-page PNGs (default on). ONLY the validator reads these
                         // (generation never touches pixels), and full-page shots of tall pages are the
                         // dominant capture cost — so a production clone that won't be perceptually graded
                         // can skip them. The cheap poster-less-video element stills are always kept
                         // (generation needs a first frame), this only gates the per-viewport page shots.
  log?: (event: Record<string, unknown>) => void;
}): Promise<CaptureResult> {
  const viewports = opts.viewports ?? [...REQUIRED_VIEWPORTS];
  const log = opts.log ?? (() => {});
  // Item 1: resolve the deterministic-env parameters once, at run start, and record
  // them in the result. The epoch is a run-metadata value (recorded, reproducible),
  // not a hardcoded constant; performance.now() is left real so motion capture is
  // unaffected. Defaults on; opts.deterministicEnv === false disables the shim.
  const deterministicEnvOn = opts.deterministicEnv !== false;
  const prngSeed = Number.isFinite(opts.prngSeed) ? Math.trunc(opts.prngSeed!) : DEFAULT_PRNG_SEED;
  const epochMs = captureEpochMs(opts.captureEpochMs);
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
    // Reject non-container bytes for video from EVERY path (a range fragment or error
    // page stored under first-stored-wins ships a corrupt file). Left unstored, the
    // asset surfaces in visual_assets_missing instead.
    if (type === "video" && !looksLikeVideoFile(bytes)) return;
    // Same guard for fonts: a 200+HTML body (SPA router answering an unknown /media/* path) must not
    // be stored as a .woff2. Left unstored, the face surfaces as failed, so the font graph can fall
    // back to a correctly-resolved duplicate url instead of shipping an impostor the browser rejects.
    if (type === "font" && !looksLikeFontFile(bytes)) return;
    const a = assetMap.get(url) ?? recordAsset(url, type, null, null, "network");
    if (a.storedAs) return;
    // A `.lottie` (dotLottie) asset is a ZIP archive, not bare lottie-web JSON. lottie-web's
    // `path:` loader does a JSON.parse and throws on the ZIP bytes, blanking the container. So
    // unwrap it here: extract the default animation JSON and store THAT, materializing every
    // lottie source as plain JSON regardless of the container it arrived in.
    let extOverride: string | null = null;
    if (type === "lottie" && isZipArchive(bytes)) {
      const json = extractDotLottieJson(bytes);
      if (!json) return; // unreadable dotLottie — leave unstored rather than ship a broken ZIP
      bytes = json;
      extOverride = "json";
    }
    const ext = extOverride || extFromUrl(url) || extFromContentType(a.contentType) ||
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

    // Response listener + init scripts are attached the same way to the initial page
    // and to any fresh recovery page (Item 3c), so factor the wiring into one helper.
    const attachResponseListener = (pg: import("playwright").Page): void => {
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
          // A 206 body is a RANGE FRAGMENT (media seek), not the asset — storing it would
          // ship a corrupt file under first-stored-wins and the full-download fallback
          // would then skip the asset. Record only; the fallback pass fetches the 200 body.
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

    const newSession = async (): Promise<{ context: BrowserContext; page: import("playwright").Page }> => {
      const ctx: BrowserContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: canonical, height: viewportHeight(canonical) },
        deviceScaleFactor: 1,
        userAgent: DESKTOP_UA,
        javaScriptEnabled: true,
      });
      const pg = await ctx.newPage();
      attachResponseListener(pg);
      // tsx/esbuild wraps functions with a __name() helper for stack traces; that
      // helper does not exist in the browser when we serialize page.evaluate
      // callbacks. Shim it (as a raw string so it isn't itself transformed).
      await pg.addInitScript(ESBUILD_SHIM);
      // Item 1: deterministic-env shim — seed Math.random + pin the Date epoch BEFORE
      // any page script runs. Raw string so tsx/esbuild leaves it byte-exact; the
      // {seed, epochMs} are the recorded run-metadata values. performance.now() stays
      // real, so motion.ts marquee/rotator velocity sampling is unaffected.
      if (deterministicEnvOn) {
        await pg.addInitScript(buildDeterministicEnvShim({ seed: prngSeed, epochMs }));
      }
      return { context: ctx, page: pg };
    };

    // Single context + single navigation; every viewport is captured by RESIZING the
    // same loaded page (see the block comment above). Item 3c: session recovery is
    // deliberately scoped to the INITIAL navigation only — carrying one session across
    // viewports is load-bearing (a reload can degenerate: warbyparker's 13-node shell),
    // so we never recover mid-loop; we only retry the first nav with a fresh context
    // when the page/browser died before any content was captured.
    let { context, page } = await newSession();

    // Total nav budget (Item 3a): a hung origin used to stall for up to ~3×45s + retries
    // with no ceiling. Bound the WHOLE navigation phase so a dead host fails fast with a
    // structured error instead of tying up the pipeline. Attempt 0 waits for `load`;
    // later attempts fall back to `domcontentloaded` (a heavy page may never fire `load`).
    const NAV_BUDGET_MS = 90_000;
    const navigateLoaded = async (pg: import("playwright").Page): Promise<void> => {
      log({ event: "goto", url: opts.url });
      const navStart = Date.now();
      let navigated = false;
      let navErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
        const remaining = NAV_BUDGET_MS - (Date.now() - navStart);
        if (remaining < 5_000) break; // not enough budget left for a meaningful attempt
        try {
          await pg.goto(opts.url, {
            waitUntil: attempt === 0 ? "load" : "domcontentloaded",
            timeout: Math.min(attempt === 0 ? 45_000 : 20_000, remaining),
          });
          navigated = true;
        } catch (e) {
          navErr = e;
          await pg.waitForTimeout(1000);
        }
      }
      if (!navigated) {
        throw new Error(
          `navigation failed for ${opts.url} within ${Math.round((Date.now() - navStart) / 1000)}s: ${String((navErr as { message?: string })?.message ?? navErr).slice(0, 300)}`,
        );
      }
      await settle(pg);
    };

    try {
      await navigateLoaded(page);
    } catch (navErr) {
      // Item 3c: one fresh-context retry, but ONLY for a session-death class of failure
      // (browser/page/context closed, crash, transient reset/timeout). A wall or a hard
      // terminal error (DNS/cert/refused) is not retried — a fresh context can't fix it.
      const cls = classifyNavFailure(navErr);
      if (cls !== "retryable") throw navErr;
      log({ event: "capture_recover", reason: "session_death_on_initial_nav" });
      try { if (!page.isClosed()) await page.close(); } catch { /* ignore */ }
      try { await context.close(); } catch { /* ignore */ }
      ({ context, page } = await newSession());
      await navigateLoaded(page); // second failure propagates (no further retry)
    }

    // Item 3b: bot/auth-wall fast-fail. A wall page would otherwise burn the full
    // multi-viewport capture and only get flagged by the pollution gate afterward.
    // Uses the SAME signatures + node-count threshold as the gate (util/captureFailure.ts)
    // so the abort and the grade agree; the pollution gate stays the shipped-capture
    // authority, this only saves the wasted work of capturing an obvious wall.
    const wallProbe = await page
      .evaluate(() => ({
        text: (document.body?.innerText ?? "").slice(0, 20_000),
        nodes: document.querySelectorAll("*").length,
      }))
      .catch(() => null);
    if (isBotWall(wallProbe)) {
      throw new Error(
        `auth/bot wall detected at ${opts.url} (${wallProbe!.nodes} nodes, wall text matched): capture aborted early`,
      );
    }

    // Stage 2: lazy-loader promotion. WP Rocket/lazysizes keep a 0-size placeholder in
    // `src` with the real URL in data attrs; autoScroll outruns their IntersectionObserver
    // (collapsed sections in the snapshot) and the interaction pass can trigger the swap
    // midway (viewports then DISAGREE about the section's size). Promote once, before any
    // snapshot, so every viewport measures the same loaded media.
    const lazyPromoted = await promoteLazyMedia(page);
    if (lazyPromoted) {
      log({ event: "lazy_promoted", count: lazyPromoted });
      await settle(page, 2000); // newly-real images reflow the layout
    }

    // Stage 2: reveal settling. Scroll reveals (Elementor waypoints, WOW/AOS class swaps)
    // are the same class of one-shot load-state as lazy media: fire them ONCE, before any
    // viewport snapshot, so every width records the POST-REVEAL steady state — otherwise
    // the snapshot bakes `visibility:hidden` wrappers (or a mid-fade opacity) with no JS
    // to ever reveal them, and the clone renders below-fold content blank.
    // A scroll-locking consent wall would defeat the dwell walk, so clear it first (the
    // per-viewport dismissal below still runs and owns the audit trail).
    const preClicked = await clickDismiss(page);
    if (preClicked.length) {
      for (const d of preClicked) if (!dismissUnion.dismissed.includes(d)) dismissUnion.dismissed.push(d);
      await settle(page, 1000);
    }
    // Motion capture needs the PRE-reveal hidden state, observable only before the first
    // scroll — tag + probe now (captureMotion confirms the candidates at the canonical
    // snapshot, reading each revealed element's entrance animation from computed style).
    if (opts.motion) { await tagElements(page); await probeReveals(page); }
    const revealSettle = await settleScrollReveals(page);
    log({ event: "reveals_settled", ...revealSettle });
    // Belt-and-braces: reveal any element STILL carrying a known-library pre-reveal marker
    // (below the step bound, or keyed to a non-scroll trigger) via the library's own
    // revealed state, so captured computed styles are genuine post-reveal values.
    const neutralized = await neutralizePreReveal(page);
    if (neutralized) log({ event: "prereveal_neutralized", count: neutralized });
    await settle(page, 1500); // revealed content reflows the layout

    for (const vw of viewports) {
      const vh = viewportHeight(vw);
      await page.setViewportSize({ width: vw, height: vh });
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

      // (Scroll-reveal probing happens once, before the viewport loop — see the reveal
      // settling pass above; by this point all one-shot reveals have already fired.)
      await autoScroll(page, vh);
      await settle(page, 1500);
      await applyDismiss("post-scroll");
      dismissUnion.overlaysRemaining = Math.max(dismissUnion.overlaysRemaining, overlaysRemaining);
      dismissUnion.blocking = dismissUnion.blocking || blocking;
      // Stage 2: wait for entrance/scroll animations to settle so geometry isn't
      // sampled mid-transition.
      const quiescent = await waitForQuiescence(page);

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

      // Stage 2: settle autoplaying carousels (pause + navigate to the home slide)
      // before EVERY snapshot — otherwise each viewport freezes a different track
      // offset (per-band CSS then bakes four different slides), and the interaction
      // pass between the canonical and last snapshots would leave the final viewport
      // contaminated. Scoped to named-library tracks so motion.ts's marquee/rotator
      // capture (which runs after the canonical snapshot) observes them unchanged.
      const carousels = await settleCarousels(page);
      if (carousels.roots) log({ event: "carousels_settled", viewport: vw, ...carousels });

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
          // A visibility:hidden video (entrance animation not yet fired) passes the size
          // gate, but locator.screenshot auto-waits for visibility and times out —
          // force-reveal the hidden ancestor chain for the shot, restore exactly after.
          let shot = false;
          try {
            await page.evaluate(forceRevealForShot, s.sel);
            const buf = await page.locator(s.sel).first().screenshot({ type: "jpeg", quality: 82, timeout: 5000, animations: "disabled" });
            recordAsset(s.url, "image", "image/jpeg", 200, "video-still");
            storeBytes(s.url, "image", buf);
            dismissUnion.videoStills++;
            shot = true;
          } catch (e) {
            log({ event: "video_still_error", viewport: vw, sel: s.sel, error: String(e).slice(0, 200) });
          } finally {
            await page.evaluate(restoreRevealForShot).catch(() => { /* ignore */ });
          }
          // A synthetic poster with no bytes behind it generates a transparent tile —
          // on failure, remove the attr so the video renders as it did pre-capture.
          if (!shot) {
            await page.evaluate((sel) => { document.querySelector(sel)?.removeAttribute("poster"); }, s.sel).catch(() => { /* ignore */ });
          }
        }
        // Element screenshots scroll the target into view; restore scroll 0 so the
        // canonical DOM walk + screenshot match the generated app's default render.
        if (plan.shots.length) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(80);
        }

        // Stage 2: canvas raster fallback — same synthetic-URL mechanism as the video
        // stills above (captureCanvasStills). Bytes ride the normal asset pipeline; the
        // canvas node gets a `src` attr (whitelisted → survives the IR) that generation
        // reads to emit the still as an <img> carrying the canvas's cid/box. The attr is
        // stamped only AFTER bytes are stored, so a failed capture leaves the canvas
        // rendering as an empty box, same as before.
        const cplan = await captureCanvasStills(page);
        const stampCanvasSrc = (sel: string, u: string): Promise<void> =>
          page.evaluate(({ s, u: uu }) => { document.querySelector(s)?.setAttribute("src", uu); }, { s: sel, u }).catch(() => { /* ignore */ });
        for (const s of cplan.stills) {
          const comma = s.dataUrl.indexOf(",");
          if (comma < 0) continue;
          try {
            const buf = Buffer.from(s.dataUrl.slice(comma + 1), "base64");
            recordAsset(s.url, "image", "image/png", 200, "canvas-still");
            storeBytes(s.url, "image", buf);
            await stampCanvasSrc(s.sel, s.url);
            log({ event: "canvas_still", viewport: vw, sel: s.sel });
          } catch { /* ignore */ }
        }
        for (const s of cplan.shots) {
          // Same reveal discipline as the video shots: a hidden canvas (entrance
          // animation not yet fired) would time out locator.screenshot's visibility wait.
          try {
            await page.evaluate(forceRevealForShot, s.sel);
            const buf = await page.locator(s.sel).first().screenshot({ type: "png", timeout: 5000, animations: "disabled" });
            recordAsset(s.url, "image", "image/png", 200, "canvas-still");
            storeBytes(s.url, "image", buf);
            await stampCanvasSrc(s.sel, s.url);
            log({ event: "canvas_still", viewport: vw, sel: s.sel });
          } catch (e) {
            log({ event: "canvas_still_error", viewport: vw, sel: s.sel, error: String(e).slice(0, 200) });
          } finally {
            await page.evaluate(restoreRevealForShot).catch(() => { /* ignore */ });
          }
        }
        if (cplan.shots.length) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(80);
        }
      }

      // Stage 4/5: stamp capture-ids before the canonical snapshot so the IR carries
      // them (whitelisted), enabling interaction deltas + motion specs to map to cids.
      if ((opts.interactions || opts.motion) && vw === canonical) await tagElements(page);

      // Stage 2.6: cross-origin iframe content. The in-page walker cannot see into a
      // cross-origin frame (newsletter/form embeds), but Node CAN evaluate in it — run the
      // SAME collectPage per meaningful frame here, then graft each subtree into this
      // viewport's snapshot below (graft.ts). Frames that can't be grafted (media players,
      // dead frames) get an element-screenshot recorded as the iframe's background at the
      // canonical viewport, so the box at least PAINTS. Runs before the main collectPage so
      // the fallback's inline background is part of the canonical computed style.
      const frameCands: FrameCandidate[] = await Promise.race([
        page.evaluate(enumerateFramesInPage),
        new Promise<FrameCandidate[]>((res) => setTimeout(() => res([]), 8000)),
      ]).catch(() => [] as FrameCandidate[]);
      const frameGrafts: Array<{ cand: FrameCandidate; snap: PageSnapshot }> = [];
      let graftBudget = MAX_GRAFT_FRAMES;
      let stillBudget = MAX_GRAFT_FRAMES; // fallback stills share the same per-page bound
      let frameShotScrolled = false;
      for (const cand of frameCands) {
        if (!cand.visible) continue;
        const plan = planForFrameUrl(cand.url);
        if (plan === "skip") continue;
        let frameSnap: PageSnapshot | null = null;
        if (plan === "graft" && graftBudget > 0) {
          try {
            const handle = await page.$(`iframe[data-ditto-frame="${cand.idx}"]`);
            const frame = handle ? await handle.contentFrame() : null;
            if (frame) {
              await frame.evaluate(ESBUILD_SHIM);
              frameSnap = await Promise.race([
                frame.evaluate(collectPage, { maxNodes: FRAME_GRAFT_MAX_NODES }),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error("frame collect timeout")), 20_000)),
              ]);
            }
            await handle?.dispose();
          } catch (e) {
            log({ event: "frame_graft_error", viewport: vw, frame: cand.idx, url: cand.url.slice(0, 160), error: String(e).slice(0, 200) });
            frameSnap = null;
          }
        }
        if (frameSnap && frameHasRenderableContent(frameSnap.root)) {
          graftBudget--;
          frameGrafts.push({ cand, snap: frameSnap });
          // Merge the frame's discoveries exactly like the main document's below: its
          // assets/fonts flow through the same pipeline so grafted <img>/@font-face resolve.
          for (const da of frameSnap.domAssets) {
            const t = classifyAsset(da.url, null) ?? (da.kind === "video" ? "video" : da.kind === "svg" ? "svg" : "image");
            recordAsset(da.url, t, null, null, `frame${cand.idx}:${da.via}`);
          }
          for (const u of frameSnap.cssUrls) {
            const t = classifyAsset(u, null) ?? "other";
            recordAsset(u, t, null, null, "css-url");
          }
          for (const ff of frameSnap.fontFaces) {
            const key = `${ff.family}|${ff.weight ?? ""}|${ff.style ?? ""}|${ff.src}`;
            if (!fontFaceMap.has(key)) fontFaceMap.set(key, ff);
          }
        } else if (vw === canonical && stillBudget > 0) {
          stillBudget--;
          // Screenshot fallback — synthetic-poster pattern (see captureVideoStills): the
          // still's bytes ride the normal asset pipeline under a synthetic URL; the iframe's
          // inline background then rewrites to the local file at generation.
          const stillUrl = `https://clone-frame.local/${cand.idx}-${sha1_12(cand.url || String(cand.idx))}.jpg`;
          const sel = `iframe[data-ditto-frame="${cand.idx}"]`;
          try {
            await page.evaluate(forceRevealForShot, sel);
            const buf = await page.locator(sel).first().screenshot({ type: "jpeg", quality: 82, timeout: 5000, animations: "disabled" });
            recordAsset(stillUrl, "image", "image/jpeg", 200, "iframe-still");
            storeBytes(stillUrl, "image", buf);
            frameShotScrolled = true;
            await page.evaluate(({ s, u }) => {
              const el = document.querySelector(s) as HTMLElement | null;
              if (el) {
                el.style.backgroundImage = `url("${u}")`;
                el.style.backgroundSize = "100% 100%";
                el.style.backgroundRepeat = "no-repeat";
              }
            }, { s: sel, u: stillUrl });
            log({ event: "frame_still", viewport: vw, frame: cand.idx, url: cand.url.slice(0, 160) });
          } catch (e) {
            log({ event: "frame_still_error", viewport: vw, frame: cand.idx, error: String(e).slice(0, 200) });
          } finally {
            await page.evaluate(restoreRevealForShot).catch(() => { /* ignore */ });
          }
        }
      }
      // Element screenshots scroll the target into view; restore scroll 0 before the walk.
      if (frameShotScrolled) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(80);
      }

      // Scroll-linked animations (animation-timeline: scroll()/view()) are held at their
      // end keyframe by `fill-mode:both` after the dwell-scroll pass, even with scroll reset
      // to 0 — so the walk would bake the frozen END state (e.g. a text-fill stuck at 100%).
      // Cancel them here so the snapshot records the genuine AT-REST (unscrolled, 0%) values.
      // Time-based reveals use the default document timeline and are untouched.
      const scrollAnimsCanceled = await neutralizeScrollTimelineAnimations(page);
      if (scrollAnimsCanceled) log({ event: "scroll_timeline_anims_canceled", viewport: vw, count: scrollAnimsCanceled });

      // Final scroll-state reset immediately before the walk: every preceding pass (dwell
      // scroll, carousel settle, element screenshots) can leave the page scrolled, which bakes
      // scroll-linked transforms/offsets into this viewport's computed styles. Scroll to top and
      // let scroll-linked effects settle so the snapshot records the genuine at-rest values.
      await settleScrollTopBeforeSnapshot(page);

      // Late-mounting dialogs (a CCPA opt-out that opens between the canonical and last
      // viewport; a Recart/Attentive promo that fires on a timer) mount AFTER the load /
      // post-scroll passes and would otherwise pollute this viewport's DOM snapshot. Re-run
      // the dismissal pass immediately before the walk. Cheap when nothing matches — the
      // settle only runs when a control was actually clicked or an overlay removed.
      await applyDismiss("pre-snapshot");
      dismissUnion.overlaysRemaining = Math.max(dismissUnion.overlaysRemaining, overlaysRemaining);
      dismissUnion.blocking = dismissUnion.blocking || blocking;

      // Bound the in-page DOM walk: page.evaluate has no default timeout, so a
      // pathologically large/animated DOM (e.g. asana.com) could hang forever.
      const snapshot: PageSnapshot = await Promise.race([
        page.evaluate(collectPage),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`collectPage timeout vp${vw}`)), 60_000)),
      ]);

      // Graft the captured frame subtrees into this viewport's snapshot (offset bboxes,
      // namespaced ids, frame-URL-absolutized src/href — see graft.ts).
      for (const g of frameGrafts) {
        const ok = graftFrameIntoSnapshot(snapshot, g.cand, g.snap);
        log({ event: ok ? "frame_grafted" : "frame_graft_orphaned", viewport: vw, frame: g.cand.idx, url: g.cand.url.slice(0, 160), nodes: g.snap.doc.nodeCount });
      }

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
        // A promo popup can mount in the window between the DOM walk and the screenshot (Recart
        // fires into a shadow root on a short timer). The screenshot is the ground-truth channel
        // the perceptual gate compares against, so re-run dismissal right before it — otherwise a
        // late popup paints over every shot even though the DOM snapshot came out clean. Cheap
        // when nothing matches.
        await applyDismiss("pre-screenshot");
        dismissUnion.blocking = dismissUnion.blocking || blocking;
        // Normalize every video to frame 0 (paused) at THIS viewport before the shot — the clone is
        // always at frame 0, so pinning the source there too makes the two channels comparable
        // regardless of the playback time the viewport happened to catch.
        await normalizeVideoTime(page, log);
        await captureScreenshot(page, join(screenshotsDir, `${vw}.png`), vw, log);
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
        // Register lottie source JSONs as assets so the asset stage downloads + materializes
        // them (the in-page detector only records the URL; the fallback fetch grabs the file).
        for (const l of motion?.lotties ?? []) {
          if (l.src) { recordAsset(l.src, "lottie", null, null, "lottie"); continue; }
          // Inline animationData (no fetchable URL): store it as a real .json asset so it
          // materializes to /assets/cloned/lottie like any other source, instead of being
          // embedded in the page spec. Content-hashed so output stays deterministic.
          if (l.inlineKey && motion?.lottieInline) {
            const data = motion.lottieInline[l.inlineKey];
            if (data === undefined) continue;
            const buf = Buffer.from(JSON.stringify(data), "utf8");
            const synthUrl = `ditto-inline:/lottie/${sha1_12(buf.toString("utf8"))}.json`;
            recordAsset(synthUrl, "lottie", "application/json", 200, "lottie-inline");
            storeBytes(synthUrl, "lottie", buf);
            l.src = synthUrl; // now resolves to a local path through the asset graph
            l.inlineKey = null;
          }
        }
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

    // Item 2: extended lazy-asset discovery sweep. The walker + promoteLazyMedia
    // already harvest img/source src/srcset and the common data-* lazy attrs
    // (data-src / data-lazy-src / data-original / data-ll-src / data-(lazy-)srcset)
    // and picture <source> variants — this sweep ONLY adds the references those miss:
    //   • <noscript> contents — the walker skips <noscript> entirely, but the fallback
    //     markup real browsers render with JS off often carries the true <img>/<source> URL;
    //   • inline element style="…url(…)…" — the walker harvests url() from STYLESHEET
    //     rules, not from an element's own style attribute (hero background-image inlined);
    //   • data-background / data-background-image — lazy-bg aliases beyond promoteLazyMedia's
    //     single data-bg;
    //   • img[loading=lazy] currentSrc — the resolved variant a below-fold image settled on.
    // Discovery-ONLY: URLs are recorded through recordAsset so the fallback downloader
    // fetches them; nothing is promoted into the DOM (the snapshots are already taken, so
    // this can never shift a captured layout). Bounded so a pathological page can't explode
    // the fallback fetch phase.
    try {
      const sweptRefs: string[] = await page.evaluate(discoverLazyAssetsInPage);
      let swept = 0;
      for (const url of sweptRefs) {
        if (swept >= 120) break; // bound pathological pages (fallback fetch is 30s/asset)
        if (!/^https?:\/\//i.test(url) || assetMap.has(url)) continue;
        const t = classifyAsset(url, null);
        if (!t || !["image", "svg", "video", "font", "lottie"].includes(t)) continue;
        recordAsset(url, t, null, null, "lazy-sweep");
        swept++;
      }
      if (swept) log({ event: "lazy_sweep", recorded: swept, seen: sweptRefs.length });
    } catch (e) {
      log({ event: "lazy_sweep_error", error: String((e as { message?: string })?.message ?? e).slice(0, 160) });
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
      // One bounded retry for transiently-failed VISUAL assets (network error / 5xx / 429):
      // a single flaky fetch otherwise degrades an image to the transparent-GIF placeholder.
      for (let attempt = 0; attempt < 2; attempt++) {
        let failStatus: number | null = null;
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
            break;
          }
          failStatus = resp.status();
        } catch { failStatus = null; /* unreachable/signed — left as skipped */ }
        if (attempt > 0 || !isRetryableAssetFailure(a.type, failStatus)) break;
        log({ event: "asset_retry", url: a.url, type: a.type, status: failStatus });
        await new Promise((r) => setTimeout(r, ASSET_RETRY_DELAY_MS));
      }
    }
    // Every visual asset that ultimately failed, in one machine-readable event: these are
    // the boxes that will paint as placeholders (image → transparent GIF, video → blank).
    const visualMissing = [...assetMap.values()]
      .filter((a) => !a.storedAs && !a.url.startsWith("data:") && (a.type === "image" || a.type === "svg" || a.type === "video"))
      .map((a) => ({ url: a.url, type: a.type, status: a.status }))
      .sort((x, y) => x.url.localeCompare(y.url));
    if (visualMissing.length) log({ event: "visual_assets_missing", count: visualMissing.length, assets: visualMissing });
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
    ...(deterministicEnvOn ? { deterministicEnv: { seed: prngSeed, epochMs } } : {}),
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
  };

  if (interaction) writeJSON(join(opts.outDir, "interaction.json"), interaction);
  if (motion) writeJSON(join(opts.outDir, "motion.json"), motion);
  writeJSON(join(opts.outDir, "assets-discovered.json"), assets);
  writeJSON(join(opts.outDir, "fonts-discovered.json"), fontFaces);
  writeJSON(join(captureDir, "capture-result.json"), result);

  return result;
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
