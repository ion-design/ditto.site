import { chromium } from "playwright";

/**
 * Probe: find elements with real event listeners via the Chrome DevTools Protocol
 * (`DOMDebugger.getEventListeners` — not reachable from page JS, but exposed over
 * CDP, which Playwright gives us). This sees click/pointer handlers that the
 * ARIA-based recognizer can't — the "dark matter" of interactivity on sites that
 * don't annotate with role/aria-*. Reports how many handler-bearing elements are
 * NON-ARIA (the gap), with samples, so we know what a drive-and-diff extension would
 * need to classify.
 *
 * This is a DETECTION probe only — it does not drive anything. Turning a detected
 * handler into a reproduced pattern still requires driving it and observing the
 * delta (the conservative contract), which is the natural next step.
 */

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "label", "option", "details"]);
const ACTION_LISTENERS = new Set(["click", "mousedown", "pointerdown", "keydown", "touchstart"]);
// Match the capture pipeline so bot-walled sites (casper) serve the real page.
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type Hit = { tag: string; cls: string; id: string; role: string; aria: boolean; native: boolean; types: string[] };

export async function detectHandlers(url: string, opts?: { cap?: number; log?: (e: Record<string, unknown>) => void }): Promise<{
  scanned: number; withHandlers: number; nonAria: number; samples: Hit[];
}> {
  const cap = opts?.cap ?? 1500;
  const log = opts?.log ?? (() => {});
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"] });
  const hits: Hit[] = [];
  let scanned = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: DESKTOP_UA, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    // scroll through the page to trigger lazy-mounted content, then settle
    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0; y < document.documentElement.scrollHeight; y += 800) { window.scrollTo(0, y); await sleep(40); }
      window.scrollTo(0, 0); await sleep(200);
    }).catch(() => {});
    await page.waitForTimeout(800);
    // Stamp a stable index on every element in-page (CDP querySelectorAll can return
    // a stale/empty node map on JS-rendered pages; resolving by attribute via
    // Runtime.evaluate is reliable).
    const total: number = await page.evaluate(() => {
      const els = document.querySelectorAll("*");
      for (let i = 0; i < els.length; i++) els[i]!.setAttribute("data-h-idx", String(i));
      return els.length;
    });
    scanned = Math.min(total, cap);
    const client = await ctx.newCDPSession(page);
    for (let i = 0; i < scanned; i++) {
      let objectId: string | undefined;
      try {
        const ev = await client.send("Runtime.evaluate", { expression: `document.querySelector('[data-h-idx="${i}"]')` });
        objectId = ev.result.objectId;
        if (!objectId) continue;
        const { listeners } = await client.send("DOMDebugger.getEventListeners", { objectId });
        const types = [...new Set((listeners ?? []).map((l) => l.type).filter((t) => ACTION_LISTENERS.has(t)))];
        if (!types.length) continue;
        const meta = await page.evaluate((idx) => {
          const el = document.querySelector(`[data-h-idx="${idx}"]`);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: (el.getAttribute("class") || "").slice(0, 48),
            id: (el.getAttribute("id") || "").slice(0, 32),
            role: el.getAttribute("role") || "",
            aria: !!(el.getAttribute("role") || el.getAttribute("aria-haspopup") || el.getAttribute("aria-expanded") || el.getAttribute("aria-controls") || el.getAttribute("aria-roledescription")),
            pointer: cs.cursor === "pointer",
            visible: r.width > 0 && r.height > 0,
          };
        }, i);
        if (!meta || !meta.visible) continue;
        hits.push({ tag: meta.tag, cls: meta.cls, id: meta.id, role: meta.role, aria: meta.aria, native: INTERACTIVE_TAGS.has(meta.tag), types });
      } catch { /* unresolvable */ }
      finally { if (objectId) await client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  // The gap = handler-bearing elements that are neither native interactives nor
  // ARIA-annotated (what the current recognizer cannot see).
  const gap = hits.filter((h) => !h.native && !h.aria);
  log({ event: "detect_done", scanned, withHandlers: hits.length, nonAria: gap.length });
  return { scanned, withHandlers: hits.length, nonAria: gap.length, samples: gap.slice(0, 25) };
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) { console.error("usage: detect-handlers <url> [--cap=N]"); process.exit(1); }
  const capArg = process.argv.find((a) => a.startsWith("--cap="))?.split("=")[1];
  const r = await detectHandlers(url, { cap: capArg ? parseInt(capArg, 10) : undefined, log: (e) => console.log(JSON.stringify(e)) });
  console.log(JSON.stringify({
    url, scanned: r.scanned, elementsWithHandlers: r.withHandlers, nonAriaHandlers: r.nonAria,
    samples: r.samples.map((h) => `${h.tag}${h.id ? "#" + h.id : ""}${h.cls ? "." + h.cls.split(" ")[0] : ""} [${h.types.join(",")}]${h.role ? " role=" + h.role : ""}`),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
