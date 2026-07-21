import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp, serveStatic } from "../validate/render.js";
import { buildIR, isTextChild, type IR } from "../normalize/ir.js";
import { tagElements } from "../capture/interactions.js";
import { readJSON, ensureDir } from "../util/fsx.js";
import type { InteractionCapture, PatternSpec } from "../capture/interactions.js";

/**
 * Visual confirmation: drive each recognized interaction in BOTH the live source and
 * the built clone, screenshot every reachable state, and compose source-vs-clone
 * montages (source left, clone right) so a human can eyeball that the clone reaches
 * the same states. The interaction gate proves it numerically; this proves it to the
 * eye. Source is re-stamped with the same document-order capture-ids, so the captured
 * spec's caps drive it too (exact for deterministic pages).
 */

const HARNESS = resolve(fileURLToPath(new URL("../../.harness", import.meta.url)));
const VP = { width: 1280, height: 800 };

function capToCid(ir: IR): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (n: IR["root"]): void => {
    const c = n.attrs["data-cid-cap"]; if (c !== undefined) m.set(c, n.id);
    for (const k of n.children) if (!isTextChild(k)) walk(k as IR["root"]);
  };
  walk(ir.root); return m;
}

type State = { label: string; caps: string[] }; // caps to click in order (base = [])

/** The reachable states to film for a pattern (base + a couple interacted states). */
function statesFor(p: PatternSpec): { rootCap: string; states: State[] } {
  if (p.kind === "tabs") {
    const last = p.tabs[p.tabs.length - 1]!;
    const mid = p.tabs[Math.min(1, p.tabs.length - 1)]!;
    return { rootCap: p.rootCap, states: [
      { label: "base", caps: [] },
      { label: "tab-2", caps: [mid.triggerCap] },
      { label: "tab-last", caps: [last.triggerCap] },
    ] };
  }
  if (p.kind === "accordion") {
    const collapsed = p.items.find((i) => !i.expandedAtBase) ?? p.items[0]!;
    return { rootCap: p.rootCap, states: [
      { label: "base", caps: [] },
      { label: "expanded", caps: [collapsed.triggerCap] },
    ] };
  }
  if (p.kind === "carousel") {
    const step = p.nextCap;
    const s2 = step ? [step, step] : (p.bulletCaps[2] ? [p.bulletCaps[2]!] : []);
    const s1 = step ? [step] : (p.bulletCaps[1] ? [p.bulletCaps[1]!] : []);
    return { rootCap: p.rootCap, states: [
      { label: "base", caps: [] },
      { label: "next-1", caps: s1 },
      { label: "next-2", caps: s2 },
    ] };
  }
  // disclosure: show a menu opening and (if present) a modal opening
  const menu = p.items.find((i) => !i.isDialog);
  const dialog = p.items.find((i) => i.isDialog);
  const states: State[] = [{ label: "base", caps: [] }];
  if (menu) states.push({ label: "menu-open", caps: [menu.triggerCap] });
  if (dialog) states.push({ label: "modal-open", caps: [dialog.triggerCap] });
  if (states.length === 1) states.push({ label: "open", caps: [p.items[0]!.triggerCap] });
  return { rootCap: p.rootCap, states };
}

async function shot(page: Page, selector: string, clicks: string[], attr: "data-cid-cap" | "data-cid"): Promise<Buffer> {
  // scroll the pattern root into view, then apply the click sequence and snapshot.
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), selector);
  await page.waitForTimeout(150);
  for (const c of clicks) {
    await page.evaluate(({ a, c }) => (document.querySelector(`[${a}="${c}"]`) as HTMLElement | null)?.click(), { a: attr, c });
    await page.waitForTimeout(450);
  }
  return page.screenshot({ clip: { x: 0, y: 0, ...VP } });
}

function readPng(buf: Buffer): PNG { return PNG.sync.read(buf); }

/** source (left) | clone (right), stacked per state into one tall montage. When
 *  `right` is null (clone-only mode) it's a single stacked column. */
function compose(rows: Array<{ left: PNG; right: PNG | null }>): PNG {
  const gap = 16, mid = 8;
  const twoCol = rows.some((r) => r.right);
  const cellW = Math.max(...rows.flatMap((r) => [r.left.width, r.right?.width ?? 0]));
  const rowH = (r: { left: PNG; right: PNG | null }) => Math.max(r.left.height, r.right?.height ?? 0);
  const totalW = twoCol ? cellW * 2 + mid : cellW;
  const totalH = rows.reduce((s, r) => s + rowH(r) + gap, gap);
  const out = new PNG({ width: totalW, height: totalH });
  out.data.fill(255);
  let y = gap;
  const blit = (src: PNG, dx: number, dy: number) => {
    for (let yy = 0; yy < src.height; yy++) for (let xx = 0; xx < src.width; xx++) {
      const si = (src.width * yy + xx) << 2, di = (totalW * (dy + yy) + (dx + xx)) << 2;
      out.data[di] = src.data[si]!; out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!; out.data[di + 3] = src.data[si + 3]!;
    }
  };
  for (const r of rows) { blit(r.left, 0, y); if (r.right) blit(r.right, cellW + mid, y); y += rowH(r) + gap; }
  return out;
}

export async function filmstrip(runDir: string, outDir: string, cloneOnly = false): Promise<string[]> {
  const input = readJSON<{ url: string; viewports: number[] }>(join(runDir, "input.json"));
  const sourceDir = join(runDir, "source");
  const interaction = readJSON<InteractionCapture>(join(sourceDir, "interaction.json"));
  const patterns = (interaction.patterns ?? []).slice(0, 4);
  if (!patterns.length) { console.log("no recognized patterns to film"); return []; }
  const ir = buildIR(sourceDir, input.viewports);
  const c2c = capToCid(ir);
  ensureDir(outDir);

  const build = buildApp(join(runDir, "generated", "app"), HARNESS);
  if (!build.ok || !build.outDir) { console.error("clone build failed"); return []; }
  const server = await serveStatic(build.outDir);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const out: string[] = [];
  try {
    for (let pi = 0; pi < patterns.length; pi++) {
      const p = patterns[pi]!;
      const { rootCap, states } = statesFor(p);
      const rootCid = c2c.get(rootCap);
      if (!rootCid) continue;
      const rows: Array<{ left: PNG; right: PNG | null }> = [];
      for (const st of states) {
        // SOURCE: fresh load, re-stamp (same doc order ⇒ caps valid for deterministic
        // pages), drive, shoot. Skipped in clone-only mode (re-stamp drifts on dynamic
        // multi-widget pages, so the clone column alone is the honest artifact there).
        let sBuf: Buffer | null = null;
        if (!cloneOnly) {
          const sctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
          const sp = await sctx.newPage();
          await sp.goto(input.url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
          await sp.waitForTimeout(400); await tagElements(sp);
          sBuf = await shot(sp, `[data-cid-cap="${rootCap}"]`, st.caps, "data-cid-cap").catch(() => null);
          await sctx.close();
        }
        // CLONE: fresh load, drive by cid, shoot.
        const cctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
        const cp = await cctx.newPage();
        await cp.goto(server.url + "/", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        await cp.waitForTimeout(300);
        const cCaps = st.caps.map((c) => c2c.get(c)).filter((x): x is string => !!x);
        const cBuf = await shot(cp, `[data-cid="${rootCid}"]`, cCaps, "data-cid").catch(() => null);
        await cctx.close();
        if (cBuf && cloneOnly) rows.push({ left: readPng(cBuf), right: null });
        else if (cBuf && sBuf) rows.push({ left: readPng(sBuf), right: readPng(cBuf) });
        console.log(JSON.stringify({ event: "filmed", pattern: p.kind, state: st.label }));
      }
      if (rows.length) {
        const png = compose(rows);
        const file = join(outDir, `${pi}-${p.kind}.png`);
        writeFileSync(file, PNG.sync.write(png));
        out.push(file);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return out;
}

function latestRun(runsDir: string, siteId: string): string | null {
  const dir = join(runsDir, siteId);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) if (existsSync(join(dir, runs[i]!, "source", "interaction.json"))) return join(dir, runs[i]!);
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) { console.error("usage: filmstrip <runDir | siteId> [--runs <dir>]"); process.exit(1); }
  const runsDir = args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? resolve(process.cwd(), "..", "runs");
  const runDir = existsSync(join(arg, "input.json")) ? arg : (latestRun(resolve(runsDir), arg) ?? arg);
  const outDir = join(runDir, "filmstrip");
  const files = await filmstrip(runDir, outDir, args.includes("--clone-only"));
  console.log(JSON.stringify({ event: "done", files }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
