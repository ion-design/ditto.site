// Probe the recent-highlights container width vs its parent across desktop widths — confirm it
// FILLS (no gutter/snap) instead of freezing at a baked w-310.
import { chromium } from "playwright";
const url = process.argv[2] || "http://127.0.0.1:8139";
const widths = [1280, 1400, 1536, 1700, 1920];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

// the grid that holds the highlight cards: a grid with grid-cols and >=3 <a> children
const ok = await page.evaluate(() => {
  const g = [...document.querySelectorAll("div")].find(
    (d) => /grid/.test(getComputedStyle(d).display) && d.querySelectorAll(":scope > div > article, :scope > div > a, :scope > a").length >= 3
      && d.closest("section")?.textContent?.includes("Recent highlights")
  );
  if (!g) return false;
  g.setAttribute("data-hl", "1");
  return true;
});
if (!ok) { console.log("recent-highlights grid not found"); await browser.close(); process.exit(0); }

console.log(`\n=== ${url} (recent-highlights) ===`);
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(200);
  const d = await page.evaluate(() => {
    const g = document.querySelector("[data-hl]");
    const p = g.parentElement;
    const gw = g.getBoundingClientRect().width;
    const pw = p.getBoundingClientRect().width;
    return { gw: Math.round(gw), pw: Math.round(pw), gutter: Math.round(pw - gw) };
  });
  console.log(`w=${String(w).padEnd(5)} grid=${d.gw} parent=${d.pw} gutter=${d.gutter}px ${d.gutter > 4 ? "**GUTTER**" : "fills"}`);
}
await browser.close();
