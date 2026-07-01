/** Screenshot live vs clone at given viewports (top region) for side-by-side eyeballing. Temp. */
import { chromium } from "playwright";
import { resolve } from "node:path";
const [live, clone, name] = process.argv.slice(2);
const SHOTS = "/tmp/cmp";
async function shot(url: string, tag: string, vw: number, clip?: { h: number }): Promise<void> {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: vw, height: 1000 }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2500); // let fonts + hero load
  await p.screenshot({ path: resolve(SHOTS, `${name}-${tag}-${vw}.png`), clip: { x: 0, y: 0, width: vw, height: clip?.h ?? 1000 } });
  await b.close();
}
async function main(): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(SHOTS, { recursive: true });
  for (const vw of [1280, 390]) {
    await shot(live!, "live", vw);
    await shot(clone!, "clone", vw);
    console.log(`done ${vw}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
