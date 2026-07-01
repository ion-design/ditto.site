import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, rmSync, cpSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { collectPage, type PageSnapshot } from "../capture/walker.js";
import { ensureDir, writeJSONCompact } from "../util/fsx.js";
import { scrollForLazyLoad, preScreenshotSettle } from "../settle/recipe.js";

const ESBUILD_SHIM =
  "globalThis.__name = globalThis.__name || ((fn) => fn);" +
  "globalThis.__defProp = globalThis.__defProp || Object.defineProperty;";

const VIEWPORT_HEIGHTS: Record<number, number> = { 375: 812, 768: 1024, 1280: 800, 1920: 1080 };
function viewportHeight(w: number): number { return VIEWPORT_HEIGHTS[w] ?? Math.round(w * 0.66); }

export type BuildResult = {
  ok: boolean;
  outDir: string | null;
  stderr: string;
  durationMs: number;
};

/** Build the generated app inside the shared harness (deps preinstalled). */
export function buildApp(appDir: string, harnessDir: string): BuildResult {
  const t0 = Date.now();
  const isVite = existsSync(join(appDir, "vite.config.ts")) || existsSync(join(appDir, "index.html"));
  if (isVite) {
    for (const entry of readdirSync(harnessDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "package.json" || entry.name === "package-lock.json") continue;
      rmSync(join(harnessDir, entry.name), { recursive: true, force: true });
    }
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "package-lock.json" || entry.name === "package.json") continue;
      cpSync(join(appDir, entry.name), join(harnessDir, entry.name), { recursive: true });
    }
    const res = spawnSync("./node_modules/.bin/vite", ["build"], {
      cwd: harnessDir,
      encoding: "utf8",
      env: { ...process.env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 240000,
    });
    const outDir = join(harnessDir, "dist");
    const ok = res.status === 0 && existsSync(join(outDir, "index.html"));
    return { ok, outDir: ok ? outDir : null, stderr: (res.stderr || "") + (res.stdout || ""), durationMs: Date.now() - t0 };
  }
  for (const sub of ["src", "public", "next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts", "out", ".next/cache/webpack"]) {
    const p = join(harnessDir, sub);
    if (sub === ".next/cache/webpack") continue; // keep webpack cache for speed
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  cpSync(join(appDir, "src"), join(harnessDir, "src"), { recursive: true });
  if (existsSync(join(appDir, "public"))) cpSync(join(appDir, "public"), join(harnessDir, "public"), { recursive: true });
  for (const f of ["next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts"]) {
    if (existsSync(join(appDir, f))) cpSync(join(appDir, f), join(harnessDir, f));
  }

  const res = spawnSync("./node_modules/.bin/next", ["build"], {
    cwd: harnessDir,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240000,
  });
  const outDir = join(harnessDir, "out");
  const ok = res.status === 0 && existsSync(join(outDir, "index.html"));
  return { ok, outDir: ok ? outDir : null, stderr: (res.stderr || "") + (res.stdout || ""), durationMs: Date.now() - t0 };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain",
};

// Bound concurrent file reads: a heavy clone requests hundreds of assets at once,
// which exhausts file descriptors (EMFILE) and made existing assets fail to serve
// (apple: 9/544). A small semaphore + retry keeps every real asset a clean 200.
let activeReads = 0;
const readQueue: Array<() => void> = [];
const MAX_READS = 48;
async function readLimited(p: string): Promise<Buffer> {
  if (activeReads >= MAX_READS) await new Promise<void>((r) => readQueue.push(r));
  activeReads++;
  try {
    for (let i = 0; ; i++) {
      try { return await readFile(p); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 40 * (i + 1))); // EMFILE/EAGAIN: back off
      }
    }
  } finally {
    activeReads--;
    readQueue.shift()?.();
  }
}

export function serveStatic(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]!);
      if (urlPath === "/") urlPath = "/index.html";
      let filePath = join(rootDir, normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
      // Prefer the `.html` export, then `index.html`. A multi-route export can have a
      // route that is BOTH a page and a parent of child routes (e.g. /generators is a
      // listing AND /generators/x exists), producing `generators.html` next to a
      // `generators/` dir — the directory must not shadow the page (reading it as a
      // file throws EISDIR → 500).
      if (existsSync(filePath + ".html")) {
        filePath += ".html";
      } else if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        const idx = join(filePath, "index.html");
        if (existsSync(idx)) filePath = idx;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        const fallback = join(rootDir, "404.html");
        if (existsSync(fallback)) { res.writeHead(404, { "content-type": "text/html" }); res.end(await readLimited(fallback)); return; }
        res.writeHead(404); res.end("not found"); return;
      }
      const data = await readLimited(filePath);
      res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(500); res.end("error");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export type RenderResult = {
  snapshots: Record<number, PageSnapshot>;
  runtimeErrors: string[];
  httpStatus: number;
  failedResources: string[];
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return out;
}

/** Render the served static export at each viewport with the same walker used
 * for capture, dumping DOM/computed/screenshots into the run's rendered/ dir. */
export async function renderApp(opts: {
  url: string;
  viewports: number[];
  renderedDir: string;
  concurrency?: number;
}): Promise<RenderResult> {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const snapshots: Record<number, PageSnapshot> = {};
  try {
    const results = await mapLimit(opts.viewports, opts.concurrency ?? 2, async (vw) => {
      const vh = viewportHeight(vw);
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
      const runtimeErrors: string[] = [];
      const failedResources = new Set<string>();
      let httpStatus = 0;
      try {
        const page = await ctx.newPage();
        await page.addInitScript(ESBUILD_SHIM);
        page.on("pageerror", (e) => runtimeErrors.push(String(e)));
        page.on("response", (r) => { if (r.status() >= 400) failedResources.add(`${r.status()} ${r.url()}`); });
        page.on("requestfailed", (r) => failedResources.add(`failed ${r.url()}`));
        const resp = await page.goto(opts.url, { waitUntil: "networkidle", timeout: 45000 });
        if (resp) httpStatus = resp.status();
        try { await page.evaluate(() => (document as Document).fonts?.ready); } catch { /* ignore */ }
        await scrollForLazyLoad(page, vh);
        // Stage 5: the shipped clone REPLAYS motion on load (CSS @keyframes / WAAPI), but
        // the gates grade the settled base. Cancel all running animations before the walk +
        // screenshot so each element falls back to its emitted base CSS — i.e. exactly the
        // source-captured values the static clone always reproduced. This keeps gates 0–6 +
        // perceptual measuring the proven static frame (no motion regression); the motion
        // gate separately drives an un-cancelled page to verify the animations actually run.
        await page.evaluate(() => {
          const w = window as unknown as { __dittoMotionStopped?: boolean; __dittoMotionStop?: () => void };
          // Set the stopped flag FIRST so a not-yet-hydrated DittoMotion skips applying motion
          // on mount (closes the hydration race that could leave reveal content hidden).
          try { w.__dittoMotionStopped = true; } catch { /* ignore */ }
          // Restore rotating-text to the captured word, reveal all reveals, stop timers/WAAPI.
          try { w.__dittoMotionStop?.(); } catch { /* ignore */ }
          // Cancel any remaining running animations (CSS @keyframes / WAAPI) so each element
          // shows its emitted base CSS = the source-captured settled frame the gates expect.
          try { for (const a of (document.getAnimations ? document.getAnimations() : [])) { try { a.cancel(); } catch { /* ignore */ } } } catch { /* ignore */ }
        });
        const snapshot = await page.evaluate(collectPage);
        writeJSONCompact(join(opts.renderedDir, "dom", `dom-${vw}.json`), snapshot);
        try {
          await preScreenshotSettle(page);
          await page.screenshot({ path: join(opts.renderedDir, "screenshots", `${vw}.png`), fullPage: true, timeout: 90_000, animations: "disabled" });
        } catch { /* ignore */ }
        return { viewport: vw, snapshot, runtimeErrors, failedResources: [...failedResources], httpStatus };
      } finally {
        await ctx.close();
      }
    });
    const runtimeErrors = results.flatMap((r) => r.runtimeErrors);
    const failedResources = new Set(results.flatMap((r) => r.failedResources));
    for (const r of results) snapshots[r.viewport] = r.snapshot;
    const non200 = results.find((r) => r.httpStatus && r.httpStatus !== 200);
    const httpStatus = non200?.httpStatus ?? results.find((r) => r.httpStatus)?.httpStatus ?? 0;
    ensureDir(join(opts.renderedDir, "computed"));
    return { snapshots, runtimeErrors, httpStatus, failedResources: [...failedResources] };
  } finally {
    await browser.close();
  }
}

/** Render the served clone at widths the grader never captured (between and beyond the
 *  captured band edges) and return a snapshot per width. Used by the responsive gate to
 *  measure behaviour where baked-px output stairsteps or off-centres — the blind spot that
 *  let non-fluid output pass every gate. Deliberately light: no screenshots, just one DOM
 *  walk per width, with motion cancelled exactly as renderApp does so we grade the settled
 *  frame. Never throws — a probe that fails to load is simply omitted. */
export async function measureProbeWidths(opts: { url: string; widths: number[] }): Promise<Record<number, PageSnapshot>> {
  const out: Record<number, PageSnapshot> = {};
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  } catch { return out; }
  try {
    for (const w of opts.widths) {
      try {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: viewportHeight(w) }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        await page.addInitScript(ESBUILD_SHIM);
        await page.goto(opts.url, { waitUntil: "networkidle", timeout: 45000 });
        try { await page.evaluate(() => (document as Document).fonts?.ready); } catch { /* ignore */ }
        await page.evaluate(() => {
          const win = window as unknown as { __dittoMotionStopped?: boolean; __dittoMotionStop?: () => void };
          try { win.__dittoMotionStopped = true; } catch { /* ignore */ }
          try { win.__dittoMotionStop?.(); } catch { /* ignore */ }
          try { for (const a of (document.getAnimations ? document.getAnimations() : [])) { try { a.cancel(); } catch { /* ignore */ } } } catch { /* ignore */ }
        });
        out[w] = await page.evaluate(collectPage);
        await ctx.close();
      } catch { /* skip this width */ }
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** Generated asset references that still point to a remote origin (rubric Gate 2
 * forbids these unless explicitly external-allowed). Scans rendered DOM attrs +
 * computed background images. */
export function findRemoteRefs(snapshots: Record<number, PageSnapshot>): string[] {
  const remote = new Set<string>();
  const isRemote = (u: string): boolean =>
    /^https?:\/\//.test(u) && !u.includes("127.0.0.1") && !u.includes("localhost");
  for (const snap of Object.values(snapshots)) {
    const walk = (node: PageSnapshot["root"]): void => {
      for (const a of ["src", "poster"]) {
        const v = node.attrs[a];
        if (v && isRemote(v)) remote.add(v);
      }
      const srcset = node.attrs.srcset;
      if (srcset) for (const part of srcset.split(",")) { const u = part.trim().split(/\s+/)[0]; if (u && isRemote(u)) remote.add(u); }
      const bg = node.computed.backgroundImage;
      if (bg) { const m = bg.match(/url\(['"]?([^'")]+)['"]?\)/g); if (m) for (const mm of m) { const u = mm.replace(/url\(['"]?|['"]?\)/g, ""); if (isRemote(u)) remote.add(u); } }
      for (const c of node.children) if ((c as { text?: string }).text === undefined) walk(c as PageSnapshot["root"]);
    };
    walk(snap.root);
  }
  return [...remote];
}

/** Index a rendered snapshot's nodes by their data-cid for source↔generated alignment. */
export type GenNode = {
  cid: string;
  tag: string;
  attrs: Record<string, string>;
  computed: Record<string, string>;
  bbox: { x: number; y: number; width: number; height: number };
  visible: boolean;
  text: string; // direct text content
};

export function indexByCid(snapshot: PageSnapshot): Map<string, GenNode> {
  const map = new Map<string, GenNode>();
  const walk = (node: PageSnapshot["root"]): void => {
    const cid = node.attrs["data-cid"];
    if (cid !== undefined) {
      let directText = "";
      for (const c of node.children) {
        if ((c as { text?: string }).text !== undefined) directText += (c as { text: string }).text;
      }
      map.set(cid, {
        cid, tag: node.tag, attrs: node.attrs, computed: node.computed,
        bbox: node.bbox, visible: node.visible, text: directText,
      });
    }
    for (const c of node.children) {
      if ((c as { text?: string }).text === undefined) walk(c as PageSnapshot["root"]);
    }
  };
  walk(snapshot.root);
  return map;
}
