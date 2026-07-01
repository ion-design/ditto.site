import { chromium } from "playwright";
import { PNG } from "pngjs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { buildApp, serveStatic } from "../validate/render.js";
import { readJSON } from "../util/fsx.js";

/**
 * Stage 5 motion verification (dev tool, off the default path). Builds an EXISTING
 * generated clone (no re-capture / re-clone), serves it, and records the clone actually
 * REPLAYING its motion — as a timeline filmstrip PNG (frames stacked over ~2.5s so CSS
 * @keyframes / WAAPI / rotating text are caught at different phases) plus a short webm.
 * Lets a human eyeball that the motion the gate verified is really there.
 *
 *   npx tsx src/runner/motionFilmstrip.ts <runDir> [--out <dir>]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, "..", "..", ".harness");
const VP = { width: 1280, height: 800 };
const CLIP_H = 680; // capture the motion-bearing top region
const FRAMES_MS = [120, 480, 880, 1350, 1900, 2500]; // offsets after load-settle

function readPng(buf: Buffer): PNG { return PNG.sync.read(buf); }

/** Stack frames vertically into one filmstrip (time goes top→bottom), thin separators. */
function stack(frames: PNG[]): PNG {
  const w = Math.max(...frames.map((f) => f.width));
  const sep = 3;
  const totalH = frames.reduce((s, f) => s + f.height, 0) + sep * (frames.length - 1);
  const out = new PNG({ width: w, height: totalH });
  out.data.fill(0x22);
  let y = 0;
  for (const f of frames) {
    for (let row = 0; row < f.height; row++) {
      for (let col = 0; col < f.width; col++) {
        const si = (f.width * row + col) << 2;
        const di = (w * (y + row) + col) << 2;
        out.data[di] = f.data[si]!; out.data[di + 1] = f.data[si + 1]!;
        out.data[di + 2] = f.data[si + 2]!; out.data[di + 3] = f.data[si + 3]!;
      }
    }
    y += f.height + sep;
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  if (!runDir) { console.error("usage: motion-filmstrip <runDir> [--out=<dir>] [--scroll]"); process.exit(1); }
  const outArg = args.find((a) => a.startsWith("--out="))?.split("=")[1];
  // --scroll: progressively scroll the page while capturing, so scroll-triggered reveals fire.
  const doScroll = args.includes("--scroll");
  const input = readJSON<{ url: string; siteId: string }>(join(resolve(runDir), "input.json"));
  const siteId = input.siteId;
  const outDir = resolve(outArg ?? join(HERE, "..", "..", "..", "examples", "motion", "evidence", siteId));
  mkdirSync(outDir, { recursive: true });

  console.log(JSON.stringify({ event: "build_start", siteId }));
  const build = buildApp(join(resolve(runDir), "generated", "app"), HARNESS);
  if (!build.ok || !build.outDir) { console.error("build failed: " + build.stderr.split("\n").filter(Boolean).slice(-3).join(" | ")); process.exit(1); }
  console.log(JSON.stringify({ event: "build_done", ms: build.durationMs }));

  const server = await serveStatic(build.outDir);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    // --- webm video of the clone replaying motion ---
    const vidCtx = await browser.newContext({ viewport: VP, recordVideo: { dir: outDir, size: VP } });
    const vpage = await vidCtx.newPage();
    await vpage.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await vpage.goto(server.url + "/", { waitUntil: "networkidle", timeout: 45000 });
    if (doScroll) {
      // Slowly scroll down (reveals fire on view), then back up.
      await vpage.evaluate(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const max = document.documentElement.scrollHeight - innerHeight;
        for (let y = 0; y <= max; y += Math.round(innerHeight * 0.35)) { scrollTo(0, y); await sleep(260); }
        await sleep(400);
      });
    } else {
      await vpage.waitForTimeout(3800); // entrance + several loops + rotator swaps
    }
    await vidCtx.close(); // flushes the video
    // rename the random webm to a stable name
    const webm = readdirSync(outDir).find((f) => f.endsWith(".webm"));
    if (webm) { const dst = join(outDir, "clone-motion.webm"); if (existsSync(dst)) rmSync(dst); renameSync(join(outDir, webm), dst); }

    // --- timeline filmstrip PNG ---
    const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await page.goto(server.url + "/", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(150);
    const frames: PNG[] = [];
    if (doScroll) {
      // Capture at increasing scroll offsets so reveals are caught mid/post-transition.
      const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        await page.evaluate((y) => scrollTo(0, y), Math.round((max * i) / (steps - 1)));
        await page.waitForTimeout(420);
        frames.push(readPng(await page.screenshot({ clip: { x: 0, y: 0, width: VP.width, height: CLIP_H }, animations: "allow" })));
      }
    } else {
      const t0 = Date.now();
      for (const ms of FRAMES_MS) {
        const wait = ms - (Date.now() - t0);
        if (wait > 0) await page.waitForTimeout(wait);
        frames.push(readPng(await page.screenshot({ clip: { x: 0, y: 0, width: VP.width, height: CLIP_H }, animations: "allow" })));
      }
    }
    const strip = stack(frames);
    const stripPath = join(outDir, "clone-motion-filmstrip.png");
    writeFileSync(stripPath, PNG.sync.write(strip));
    await ctx.close();
    console.log(JSON.stringify({ event: "motion_filmstrip_done", siteId, frames: frames.length, dir: outDir }));
  } finally {
    await browser.close();
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
