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

/** Full pre-screenshot settle: fonts + optional animation freeze. */
export async function preScreenshotSettle(page: Page, opts?: { freezeCss?: boolean }): Promise<void> {
  await waitForFonts(page);
  if (opts?.freezeCss !== false) await freezeAnimations(page);
}
