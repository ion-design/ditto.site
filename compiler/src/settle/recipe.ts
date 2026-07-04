import type { Page } from "playwright";

/**
 * Unified scroll/settle recipe shared by capture, live-witness, renderApp, and
 * visual audit. One recipe ⇒ comparable screenshots and bbox attribution.
 */
export const SETTLE_RECIPE_VERSION = "1.0.0";
export const SCROLL_STEP_PX = 500;
export const SCROLL_SLEEP_MS = 120;
export const SCROLL_BOTTOM_MS = 400;
export const SCROLL_TOP_MS = 300;
export const DEVICE_SCALE_FACTOR = 1;
export const FONT_READY_TIMEOUT_MS = 6000;

/** Scroll top→bottom to wake lazy images and IntersectionObserver reveals. */
export async function scrollForLazyLoad(page: Page, vpHeight?: number): Promise<void> {
  const step = vpHeight ? Math.max(Math.round(vpHeight * 0.8), SCROLL_STEP_PX) : SCROLL_STEP_PX;
  await page.evaluate(
    async ({ stepPx, sleepMs, bottomMs, topMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const max = document.documentElement.scrollHeight;
      for (let y = 0; y < max; y += stepPx) {
        window.scrollTo(0, y);
        await sleep(sleepMs);
      }
      window.scrollTo(0, max);
      await sleep(bottomMs);
      window.scrollTo(0, 0);
      await sleep(topMs);
    },
    { stepPx: step, sleepMs: SCROLL_SLEEP_MS, bottomMs: SCROLL_BOTTOM_MS, topMs: SCROLL_TOP_MS },
  );
}

export async function waitForFonts(page: Page, timeoutMs = FONT_READY_TIMEOUT_MS): Promise<void> {
  try {
    await Promise.race([
      page.evaluate(() => (document as Document).fonts?.ready as unknown as Promise<void>),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  } catch { /* ignore */ }
}

/** Inject CSS so painted state matches the settled frame used by gates. */
export async function freezeAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;transition:none!important}",
  });
}

/** Freeze opacity-cycling decks/carousels to the first visible card (deterministic). */
export async function freezeOpacityDecks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      if (parseFloat(cs.opacity || "1") < 0.05) return false;
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      return true;
    };
    const children = (el: Element): Element[] => Array.from(el.children).filter((c) => c instanceof HTMLElement);
    let frozen = 0;
    const visit = (root: Element): void => {
      const kids = children(root);
      if (kids.length < 2 || kids.length > 24) {
        for (const k of kids) visit(k);
        return;
      }
      const boxes = kids.map((k) => (k as HTMLElement).getBoundingClientRect());
      const w0 = boxes[0]!.width;
      const h0 = boxes[0]!.height;
      if (w0 < 40 || h0 < 40) {
        for (const k of kids) visit(k);
        return;
      }
      const sameGeom = boxes.every((b) => Math.abs(b.width - w0) < 4 && Math.abs(b.height - h0) < 4);
      if (!sameGeom) {
        for (const k of kids) visit(k);
        return;
      }
      const opacities = kids.map((k) => parseFloat(getComputedStyle(k).opacity || "1"));
      const vis = kids.filter((k, i) => visible(k) && opacities[i]! > 0.5);
      if (vis.length === 1 && opacities.filter((o) => o < 0.05).length >= kids.length - 1) {
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i] as HTMLElement;
          if (i === 0) {
            el.style.opacity = "1";
            el.style.visibility = "visible";
            el.style.pointerEvents = "auto";
          } else {
            el.style.opacity = "0";
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
          }
        }
        frozen++;
        return;
      }
      for (const k of kids) visit(k);
    };
    visit(document.body);
    return frozen;
  });
}

/** Full pre-screenshot settle: fonts + optional animation freeze. */
export async function preScreenshotSettle(page: Page, opts?: { freezeCss?: boolean; freezeDecks?: boolean }): Promise<void> {
  await waitForFonts(page);
  if (opts?.freezeDecks !== false) {
    try { await freezeOpacityDecks(page); } catch { /* non-fatal */ }
  }
  if (opts?.freezeCss !== false) await freezeAnimations(page);
}
