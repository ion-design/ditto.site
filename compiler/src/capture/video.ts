import type { Page } from "playwright";
import type { CapStyle } from "./interactions.js";

/**
 * Stage 4 — video-player recognizer. A poster + play-affordance mockup (remento's
 * macbook: a preview loop and a play circle layered over an embedded player) had no
 * pattern: the clone rendered the poster and the click was dead. This stage recognizes
 * the shape — a media surface (an embed iframe of a known player, or a <video>) whose
 * frame also holds a play affordance — then DRIVES a REAL pointer click on the source
 * page to learn empirically what the play action does: which overlay elements hide, and
 * which media surface plays. The click is a genuine Playwright mouse click at the
 * affordance's centre (play handlers are often split across the overlay stack and some
 * check event.isTrusted, so a synthetic el.click() misses them). Only style/class
 * attribute mutations are accepted (recorded with their old values and UNDONE
 * afterwards, so the page returns to its captured base state for the later motion
 * pass); a candidate that navigates or can't be cleanly undone stays static.
 *
 * Captured values are definitions: the overlay's post-click hidden styles (a state, not
 * a frame) and the embed's URL. The clone replays via a fixed client controller
 * (DittoVideo) that applies the hidden styles and starts the media INLINE — inside the
 * mockup frame — on click. It applies nothing on mount, so the base render (poster,
 * play button, stripped-src iframe) is untouched.
 */

export type VideoOverlay = { cap: string; hide: CapStyle }; // props to apply when playback starts

export type VideoPlayerCapture = {
  frameCap: string;    // the mockup frame containing overlay + media
  triggerCap: string;  // the click target (play affordance / full-frame play button)
  overlays: VideoOverlay[];
  media: {
    cap: string;
    kind: "iframe" | "video";
    embedUrl: string | null; // iframe: the captured player URL (applied only on click)
  };
};

/** Embed hosts that are actual video players (not arbitrary third-party frames). */
const PLAYER_SRC = /player\.vimeo\.com\/video|youtube(?:-nocookie)?\.com\/embed|fast\.wistia\.(?:net|com)\/embed|loom\.com\/embed/i;

type Candidate = {
  frameCap: string; triggerCap: string;
  media: { cap: string; kind: "iframe" | "video"; embedUrl: string | null };
};

export async function captureVideoPlayers(page: Page, opts?: { log?: (e: Record<string, unknown>) => void }): Promise<VideoPlayerCapture[]> {
  const log = opts?.log ?? (() => {});
  try {
    // 1) Recognize candidates (pure read).
    const found: Candidate[] = await page.evaluate((playerSrcSource: string) => {
      const PLAYER = new RegExp(playerSrcSource, "i");
      const capOf = (el: Element | null): string | null => el?.getAttribute?.("data-cid-cap") ?? null;
      const visible = (el: Element): boolean => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") <= 0.05) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      // Media surfaces: player iframes first (the actual full-video player), then
      // non-autoplaying <video>s with a poster (a self-hosted poster player).
      type Surface = { el: Element; kind: "iframe" | "video"; embedUrl: string | null };
      const surfaces: Surface[] = [];
      for (const f of Array.from(document.querySelectorAll("iframe"))) {
        const src = f.getAttribute("src") || "";
        if (PLAYER.test(src)) surfaces.push({ el: f, kind: "iframe", embedUrl: (f as HTMLIFrameElement).src });
      }
      for (const v of Array.from(document.querySelectorAll("video"))) {
        if (v.autoplay) continue; // an autoplaying loop is background art, not a click-to-play player
        if (!v.poster && !v.querySelector("source") && !v.src) continue;
        surfaces.push({ el: v, kind: "video", embedUrl: null });
      }
      // For each surface, resolve the frame: the nearest ancestor that ALSO holds a
      // visible play affordance. The trigger is the largest clickable play affordance in
      // that frame (a full-frame "Play video" button beats the decorative circle).
      const out: Candidate[] = [];
      type Candidate = { frameCap: string; triggerCap: string; media: { cap: string; kind: "iframe" | "video"; embedUrl: string | null } };
      const claimed = new Set<Element>();
      for (const s of surfaces) {
        const mediaCap = capOf(s.el);
        if (!mediaCap) continue;
        let frame: Element | null = s.el.parentElement;
        let plays: Element[] = [];
        for (let hop = 0; frame && hop < 7; hop++) {
          plays = Array.from(frame.querySelectorAll('[aria-label*="play" i], [class*="play" i]')).filter((p) => !s.el.contains(p) && visible(p));
          if (plays.length) break;
          frame = frame.parentElement;
        }
        if (!frame || !plays.length || claimed.has(frame)) continue;
        const clickable = plays.filter((p) => {
          const cs = getComputedStyle(p);
          return p.getAttribute("role") === "button" || p.tagName === "A" || p.tagName === "BUTTON" || cs.cursor === "pointer";
        });
        if (!clickable.length) continue;
        const trigger = clickable.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const d = rb.width * rb.height - ra.width * ra.height;
          return d !== 0 ? d : parseInt(capOf(a) ?? "0", 10) - parseInt(capOf(b) ?? "0", 10);
        })[0]!;
        const frameCap = capOf(frame), triggerCap = capOf(trigger);
        if (!frameCap || !triggerCap) continue;
        claimed.add(frame);
        out.push({ frameCap, triggerCap, media: { cap: mediaCap, kind: s.kind, embedUrl: s.embedUrl } });
        if (out.length >= 4) break;
      }
      return out;
    }, PLAYER_SRC.source);
    if (!found.length) return [];

    // 2) Drive each candidate with a REAL mouse click, diff, undo.
    const out: VideoPlayerCapture[] = [];
    const urlBefore = page.url();
    for (const cand of found) {
      // Prep: record pre-click visibility, arm the undo observer, scroll the frame into
      // view, and report the trigger's centre in viewport coordinates.
      const prep = await page.evaluate(async (c: Candidate) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const capOf = (el: Element | null): string | null => el?.getAttribute?.("data-cid-cap") ?? null;
        const visible = (el: Element): boolean => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") <= 0.05) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        };
        const frame = document.querySelector(`[data-cid-cap="${c.frameCap}"]`);
        const trigger = document.querySelector(`[data-cid-cap="${c.triggerCap}"]`) as HTMLElement | null;
        if (!frame || !trigger) return null;
        const before: Record<string, boolean> = {};
        for (const el of [frame, ...Array.from(frame.querySelectorAll("[data-cid-cap]")).slice(0, 200)]) {
          const cap = capOf(el);
          if (cap) before[cap] = visible(el);
        }
        const firstOld: Array<{ el: Element; attr: string; old: string | null }> = [];
        const seenAttr = new Set<string>();
        const obs = new MutationObserver((records) => {
          for (const rec of records) {
            if (rec.type !== "attributes" || !rec.attributeName) continue;
            const el = rec.target as Element;
            const k = (capOf(el) ?? "?") + "|" + rec.attributeName;
            if (seenAttr.has(k)) continue;
            seenAttr.add(k);
            firstOld.push({ el, attr: rec.attributeName, old: rec.oldValue });
          }
        });
        obs.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class"] });
        (window as unknown as { __dittoVideoDrive?: unknown }).__dittoVideoDrive = { obs, firstOld, before, scrollY: window.scrollY };
        try { frame.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
        await sleep(250);
        const tb = trigger.getBoundingClientRect();
        if (tb.width < 2 || tb.height < 2) return null;
        return { cx: tb.left + tb.width / 2, cy: tb.top + tb.height / 2 };
      }, cand);
      if (!prep) { await disarm(page); continue; }

      // A genuine, trusted pointer click at the affordance's centre — the topmost
      // element receives it and it bubbles through the whole overlay stack. The window
      // is generous on purpose: the overlay often hides only when the embedded player
      // reports playback (a postMessage 'play' event ~1-2s after the click), and a
      // short window would miss — and fail to undo — that late flip.
      await page.mouse.click(prep.cx, prep.cy).catch(() => { /* ignore */ });
      await page.waitForTimeout(2500);
      if (page.url() !== urlBefore) {
        await page.goBack().catch(() => { /* ignore */ });
        await page.waitForTimeout(400);
        await disarm(page);
        continue;
      }

      // Diff + undo (restore first-seen old attribute values; verify the base returned).
      const res = await page.evaluate(async (c: Candidate) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const capOf = (el: Element | null): string | null => el?.getAttribute?.("data-cid-cap") ?? null;
        const visible = (el: Element): boolean => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") <= 0.05) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        };
        const drive = (window as unknown as { __dittoVideoDrive?: { obs: MutationObserver; firstOld: Array<{ el: Element; attr: string; old: string | null }>; before: Record<string, boolean>; scrollY: number } }).__dittoVideoDrive;
        if (!drive) return null;
        drive.obs.disconnect();
        delete (window as unknown as { __dittoVideoDrive?: unknown }).__dittoVideoDrive;
        const frame = document.querySelector(`[data-cid-cap="${c.frameCap}"]`);
        if (!frame) return null;
        const OVERLAY_PROPS = ["display", "opacity", "visibility", "pointerEvents"];
        // Overlay flip: frame elements that were visible and are now hidden.
        const overlays: Array<{ cap: string; hide: Record<string, string> }> = [];
        for (const el of [frame, ...Array.from(frame.querySelectorAll("[data-cid-cap]")).slice(0, 200)]) {
          const cap = capOf(el);
          if (!cap || cap === c.media.cap) continue;
          if (drive.before[cap] !== true || visible(el)) continue;
          const cs = getComputedStyle(el);
          const hide: Record<string, string> = {};
          for (const p of OVERLAY_PROPS) hide[p] = (cs as unknown as Record<string, string>)[p] ?? "";
          overlays.push({ cap, hide });
        }
        // Keep only the outermost hidden elements (children are masked by their parent).
        const elOf = (cap: string): Element | null => document.querySelector(`[data-cid-cap="${cap}"]`);
        const outer = overlays.filter((o) => !overlays.some((p) => {
          if (p.cap === o.cap) return false;
          const pe = elOf(p.cap), oe = elOf(o.cap);
          return !!pe && !!oe && pe.contains(oe);
        }));
        // Media still present with a real box → the reveal points at a playable surface.
        const mediaEl = elOf(c.media.cap) as HTMLElement | null;
        const mb = mediaEl ? mediaEl.getBoundingClientRect() : null;
        const mediaOk = !!mb && mb.width >= 100 && mb.height >= 60;
        // Stop the now-playing media FIRST: the running player keeps firing events that
        // re-hide the overlay right after a restore. Re-assigning an iframe's identical
        // src forces a reload back to its initial (paused) embed state with the DOM
        // byte-unchanged; a <video> is simply paused.
        if (mediaEl) {
          try {
            if (c.media.kind === "iframe") { const f = mediaEl as HTMLIFrameElement; f.src = f.src; }
            else (mediaEl as HTMLVideoElement).pause();
          } catch { /* ignore */ }
          await sleep(600); // let the reload land + pending player-event fades flush
        }
        // UNDO: restore every first-seen style/class attribute to its pre-click value.
        // Two passes: a late one-shot handler write can land after the first restore.
        const restoreAll = () => {
          for (const m of drive.firstOld) {
            try {
              if (m.old === null) m.el.removeAttribute(m.attr);
              else m.el.setAttribute(m.attr, m.old);
            } catch { /* ignore */ }
          }
        };
        restoreAll();
        try { window.scrollTo(0, drive.scrollY); } catch { /* ignore */ }
        await sleep(400);
        let restored = outer.every((o) => { const el = elOf(o.cap); return !!el && visible(el); });
        if (!restored) {
          restoreAll();
          await sleep(400);
          restored = outer.every((o) => { const el = elOf(o.cap); return !!el && visible(el); });
        }
        return { overlays: outer, mediaOk, restored };
      }, cand);
      log({ event: "interactions_video_candidate", frame: cand.frameCap, trigger: cand.triggerCap, kind: cand.media.kind, overlays: res?.overlays.length ?? -1, mediaOk: res?.mediaOk ?? false, restored: res?.restored ?? false });
      if (!res || !res.overlays.length || !res.mediaOk) continue; // click did nothing player-like → static
      if (!res.restored) { log({ event: "interactions_video_undo_failed", frame: cand.frameCap }); continue; }
      out.push({ frameCap: cand.frameCap, triggerCap: cand.triggerCap, overlays: res.overlays, media: cand.media });
    }
    out.sort((a, b) => parseInt(a.frameCap, 10) - parseInt(b.frameCap, 10));
    if (out.length) log({ event: "interactions_video_players", players: out.length });
    return out;
  } catch (e) {
    log({ event: "interactions_video_error", error: String(e).slice(0, 150) });
    return [];
  }
}

/** Tear down a prep that never reached its diff phase (missing elements / navigation). */
async function disarm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __dittoVideoDrive?: { obs: MutationObserver } };
    w.__dittoVideoDrive?.obs.disconnect();
    delete w.__dittoVideoDrive;
  }).catch(() => { /* ignore */ });
}
