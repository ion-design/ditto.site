import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp, serveStatic } from "../validate/render.js";
import { readJSON, ensureDir } from "../util/fsx.js";

/**
 * Visual map of what component extraction produced. Builds the clone, outlines every
 * extracted-component instance in the rendered page with a numbered, colored badge, and
 * draws a legend (number → component name, runs × instances). Single-page runs get one
 * source|clone image; multi-route runs get one annotated clone image per route (the
 * shared chrome's components are shown on each, before the route's own).
 *
 * Requires a run generated with `--components`. Usage:
 *   npx tsx src/runner/componentMap.ts <runDir | siteId> [--runs <dir>] [--clone-only]
 */

const HARNESS = resolve(fileURLToPath(new URL("../../.harness", import.meta.url)));
const VP = { width: 1280, height: 900 };

type Extracted = { name: string; runs: number; instances: number; rootCids: string[] };
type LegendEntry = { num: number; name: string; runs: number; instances: number; color: string };

function color(i: number, n: number): string {
  return `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 75%, 45%)`;
}

function readPng(buf: Buffer): PNG { return PNG.sync.read(buf); }

/** Assign each component a number + color, and flatten cid → {num,color} for overlay. */
function mapComponents(comps: Extracted[]): { legend: LegendEntry[]; cidMap: Record<string, { num: number; color: string }> } {
  const legend = comps.map((c, i) => ({ num: i + 1, name: c.name, runs: c.runs, instances: c.instances, color: color(i, comps.length) }));
  const cidMap: Record<string, { num: number; color: string }> = {};
  comps.forEach((c, i) => { for (const cid of c.rootCids) cidMap[cid] = { num: i + 1, color: color(i, comps.length) }; });
  return { legend, cidMap };
}

/** Draw outlines + numbered badges over each instance, and a legend panel. */
async function annotate(page: Page, cidMap: Record<string, { num: number; color: string }>, legend: LegendEntry[], title: string): Promise<void> {
  await page.evaluate(({ cidMap, legend, title }) => {
    for (const [cid, info] of Object.entries(cidMap)) {
      const el = document.querySelector(`[data-cid="${cid}"]`) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;top:${r.top + scrollY}px;left:${r.left + scrollX}px;width:${r.width}px;height:${r.height}px;border:2px solid ${info.color};box-sizing:border-box;z-index:2147483646;pointer-events:none`;
      const badge = document.createElement("div");
      badge.textContent = String(info.num);
      badge.style.cssText = `position:absolute;top:0;left:0;background:${info.color};color:#fff;font:700 11px/1.45 ui-sans-serif,sans-serif;padding:0 5px;border-bottom-right-radius:4px`;
      box.appendChild(badge);
      document.body.appendChild(box);
    }
    const panel = document.createElement("div");
    panel.style.cssText = "position:absolute;top:8px;right:8px;background:rgba(255,255,255,.97);border:1px solid #d0d0d0;border-radius:8px;padding:10px 12px;font:12px/1.55 ui-sans-serif,sans-serif;color:#111;z-index:2147483647;box-shadow:0 2px 10px rgba(0,0,0,.18);max-width:320px";
    panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${title}</div>` +
      (legend.length ? legend.map((l) => `<div style="white-space:nowrap"><span style="display:inline-block;width:11px;height:11px;background:${l.color};border-radius:2px;margin-right:7px;vertical-align:-1px"></span><b>${l.num}</b> &nbsp;${l.name} <span style="color:#888">— ${l.runs} run${l.runs > 1 ? "s" : ""}, ${l.instances}×</span></div>`).join("")
        : '<div style="color:#888">no components extracted</div>');
    document.body.appendChild(panel);
  }, { cidMap, legend, title });
}

/** source (left) | annotated clone (right), white-matted to equal height. */
function compose(left: PNG | null, right: PNG): PNG {
  const gap = 12;
  const lw = left?.width ?? 0;
  const totalW = (left ? lw + gap : 0) + right.width;
  const totalH = Math.max(left?.height ?? 0, right.height);
  const out = new PNG({ width: totalW, height: totalH });
  out.data.fill(255);
  const blit = (src: PNG, dx: number) => {
    for (let yy = 0; yy < src.height; yy++) for (let xx = 0; xx < src.width; xx++) {
      const si = (src.width * yy + xx) << 2, di = (totalW * yy + (dx + xx)) << 2;
      out.data[di] = src.data[si]!; out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!; out.data[di + 3] = src.data[si + 3]!;
    }
  };
  if (left) blit(left, 0);
  blit(right, left ? lw + gap : 0);
  return out;
}

function fileSafe(href: string): string {
  return (href.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]/g, "_") || "home");
}

/** Single-page run: one source|clone image. */
async function componentMapPage(runDir: string, cloneOnly: boolean): Promise<string[]> {
  const input = readJSON<{ url: string }>(join(runDir, "input.json"));
  const comps = readJSON<Extracted[]>(join(runDir, "generated", "extracted-components.json"));
  if (!comps.length) { console.log("no components were extracted for this run"); return []; }
  const { legend, cidMap } = mapComponents(comps);
  console.log("legend:\n" + legend.map((l) => `  ${l.num}. ${l.name} — ${l.runs} run(s), ${l.instances} instance(s)`).join("\n"));

  const build = buildApp(join(runDir, "generated", "app"), HARNESS);
  if (!build.ok || !build.outDir) { console.error("clone build failed"); return []; }
  const server = await serveStatic(build.outDir);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(server.url + "/", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await annotate(page, cidMap, legend, "Extracted components");
    const cloneBuf = await page.screenshot({ fullPage: true });
    let srcPng: PNG | null = null;
    if (!cloneOnly) {
      const sctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
      const sp = await sctx.newPage();
      const ok = await sp.goto(input.url, { waitUntil: "networkidle", timeout: 45000 }).then(() => true).catch(() => false);
      if (ok) { await sp.waitForTimeout(800); srcPng = readPng(await sp.screenshot({ fullPage: true })); }
      await sctx.close();
    }
    ensureDir(join(runDir, "component-map"));
    const file = join(runDir, "component-map", "component-map.png");
    writeFileSync(file, PNG.sync.write(compose(srcPng, readPng(cloneBuf))));
    console.log("wrote " + file);
    return [file];
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Multi-route run: one annotated clone image per route (chrome components first). */
async function componentMapSite(runDir: string): Promise<string[]> {
  const ext = readJSON<{ chrome: Extracted[]; routes: Array<{ routePath: string; href: string; components: Extracted[] }> }>(join(runDir, "generated", "extracted-components.json"));
  const totalRoutes = ext.routes.reduce((a, r) => a + r.components.reduce((s, c) => s + c.instances, 0), 0);
  console.log(`site: ${ext.routes.length} routes, chrome=[${ext.chrome.map((c) => c.name + " ×" + c.instances).join(", ")}], ${totalRoutes} route instances`);

  const build = buildApp(join(runDir, "generated", "app"), HARNESS);
  if (!build.ok || !build.outDir) { console.error("site build failed"); return []; }
  const server = await serveStatic(build.outDir);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const out: string[] = [];
  try {
    ensureDir(join(runDir, "component-map"));
    const seen = new Set<string>();
    for (const route of ext.routes) {
      // chrome (shown on every route) numbered first, then the route's own components.
      const comps = [...ext.chrome, ...route.components];
      const key = fileSafe(route.href);
      if (seen.has(key)) continue; // skip duplicate hrefs (e.g. / and /index.html)
      seen.add(key);
      const { legend, cidMap } = mapComponents(comps);
      const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.goto(server.url + route.href, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      await annotate(page, cidMap, legend, `${route.href} — components`);
      const buf = await page.screenshot({ fullPage: true });
      await ctx.close();
      const file = join(runDir, "component-map", `${key}.png`);
      writeFileSync(file, buf);
      out.push(file);
      console.log(`  ${route.href}: ${route.components.map((c) => c.name + " ×" + c.instances).join(", ") || "(none)"} → ${file}`);
    }
    return out;
  } finally {
    await browser.close();
    await server.close();
  }
}

export async function componentMap(runDir: string, cloneOnly = false): Promise<string[]> {
  if (existsSync(join(runDir, "site-manifest.json"))) return componentMapSite(runDir);
  if (!existsSync(join(runDir, "generated", "extracted-components.json"))) { console.error("no extracted-components.json — regenerate with --components"); return []; }
  return componentMapPage(runDir, cloneOnly);
}

function latestRun(runsDir: string, siteId: string): string | null {
  for (const id of [siteId, "site-" + siteId]) {
    const dir = join(runsDir, id);
    if (!existsSync(dir)) continue;
    const runs = readdirSync(dir).filter((d) => /^\d/.test(d)).sort();
    for (let i = runs.length - 1; i >= 0; i--) {
      if (existsSync(join(dir, runs[i]!, "generated", "extracted-components.json"))) return join(dir, runs[i]!);
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) { console.error("usage: componentMap <runDir | siteId> [--runs <dir>] [--clone-only]"); process.exit(1); }
  const runsArg = args.find((a) => a.startsWith("--runs="))?.split("=")[1];
  const runsDir = runsArg ? resolve(runsArg) : resolve(HARNESS, "..", "..", "runs");
  const runDir = existsSync(join(arg, "input.json")) || existsSync(join(arg, "site-manifest.json")) ? arg : latestRun(runsDir, arg);
  if (!runDir) { console.error("no run with extracted components found for " + arg); process.exit(1); }
  await componentMap(runDir, args.includes("--clone-only"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
