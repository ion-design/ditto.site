/** Diff computed styles of named elements between the LIVE site and the local clone. Temp tool.
 *  usage: tsx src/runner/diag.ts <liveUrl> <cloneUrl> <vw> "<text1>" "<text2>" ... */
import { chromium } from "playwright";

const PROPS = [
  "display", "boxSizing", "height", "minHeight", "width", "minWidth", "maxWidth",
  "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
  "alignItems", "justifyContent", "flexGrow", "flexShrink", "flexBasis",
  "fontWeight", "fontFamily", "fontSize", "lineHeight",
];

async function probe(url: string, vw: number, texts: string[]): Promise<Record<string, any>> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: vw, height: 900 }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  for (let y = 0; y < 8; y++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {}); await page.waitForTimeout(300); }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(800);
  const out = await page.evaluate(({ texts, PROPS }) => {
    const res: Record<string, any> = {};
    for (const t of texts) {
      // smallest element whose trimmed text equals/contains t
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      const matches = all.filter((e) => (e.textContent || "").trim().toLowerCase().includes(t.toLowerCase()) && e.offsetParent !== null);
      // pick the deepest (fewest descendants matching) — the tightest wrapper
      matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      const el = matches[0];
      if (!el) { res[t] = "NOT FOUND"; continue; }
      const cs = getComputedStyle(el);
      const o: Record<string, string> = { tag: el.tagName.toLowerCase() };
      for (const p of PROPS) o[p] = (cs as any)[p];
      const r = el.getBoundingClientRect();
      o.box = `${Math.round(r.width)}x${Math.round(r.height)}`;
      res[t] = o;
    }
    return res;
  }, { texts, PROPS });
  await browser.close();
  return out;
}

async function main(): Promise<void> {
  const [live, clone, vwStr, ...texts] = process.argv.slice(2);
  const vw = parseInt(vwStr!, 10);
  const L = await probe(live!, vw, texts);
  const C = await probe(clone!, vw, texts);
  for (const t of texts) {
    console.log(`\n=== "${t}" @${vw} ===`);
    const l = L[t], c = C[t];
    if (typeof l === "string" || typeof c === "string") { console.log("live:", l, "| clone:", c); continue; }
    for (const p of ["tag", "box", ...PROPS]) {
      const lv = String(l[p]), cv = String(c[p]);
      const flag = lv !== cv ? "  <-- DIFF" : "";
      if (lv !== cv) console.log(`  ${p.padEnd(14)} live=${lv.slice(0, 40).padEnd(42)} clone=${cv.slice(0, 40)}${flag}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
