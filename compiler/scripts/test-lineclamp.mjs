// Hypothesis test: does adding -webkit-line-clamp:5 to quote cards make their
// heights uniform? Inject the clamp at runtime and re-measure heights.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8139";
const widths = [1024, 1100, 1200, 1280, 1440];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

const gridSel = await page.evaluate(() => {
  const grids = [...document.querySelectorAll("div")].filter(
    (d) => getComputedStyle(d).display === "grid" && d.querySelector("blockquote")
  );
  if (!grids[0]) return null;
  grids[0].setAttribute("data-probe-grid", "1");
  return true;
});
if (!gridSel) { console.log("no grid"); await browser.close(); process.exit(0); }

const measure = async (label) => {
  console.log(`\n--- ${label} ---`);
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(200);
    const d = await page.evaluate(() => {
      const grid = document.querySelector('[data-probe-grid]');
      const vis = [...grid.children].filter((c) => getComputedStyle(c).display !== "none");
      const H = vis.map((c) => Math.round((c.querySelector(":scope > div") || c).getBoundingClientRect().height * 10) / 10);
      return { cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length, H, uniq: [...new Set(H)].length };
    });
    console.log(`w=${String(w).padEnd(5)} cols=${d.cols} H=${JSON.stringify(d.H)} ${d.uniq === 1 ? "UNIFORM" : "**NONUNIFORM " + d.uniq + "**"}`);
  }
};

await measure("BEFORE (current clone)");

// (0) h-full ONLY (no line-clamp) — does filling the definite grid cell alone equalize within rows?
await page.addStyleTag({
  content: `[data-probe-grid] > div > div { height:100% !important; }
            [data-probe-grid] figure { height:100% !important; }`,
});
await measure("AFTER-0 (card/figure h-full ONLY, no line-clamp)");

// (1) add line-clamp:5 on top.
await page.addStyleTag({
  content: `[data-probe-grid] blockquote p { display:-webkit-box !important; -webkit-box-orient:vertical !important; -webkit-line-clamp:5 !important; overflow:hidden !important; }`,
});
await measure("AFTER-1 (h-full + line-clamp:5)");

await browser.close();
