import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, rmSync, cpSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { collectPage, type PageSnapshot } from "../capture/walker.js";
import { captureFullPageViaCDP, normalizeVideoTime } from "../capture/capture.js";
import { ensureDir, writeJSONCompact } from "../util/fsx.js";

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

/** Dependencies the app's package.json declares that are absent from the harness's
 *  preinstalled node_modules. The harness copies app SOURCE over its own tree but keeps its
 *  preinstalled node_modules/package.json (for speed + determinism), so a dep the generator
 *  injects for this clone but that the harness was never provisioned with (e.g. `lottie-web`,
 *  added by injectLottieDep only for clones with Lottie content) would be missing at build time
 *  → "Module not found" webpack error. Returns each such dep pinned to the app's exact version. */
export function missingHarnessDeps(appDir: string, harnessDir: string): Array<{ name: string; version: string }> {
  const pkgPath = join(appDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let deps: Record<string, string> = {};
  try { deps = (JSON.parse(readFileSync(pkgPath, "utf8")).dependencies ?? {}) as Record<string, string>; }
  catch { return []; }
  const out: Array<{ name: string; version: string }> = [];
  for (const [name, version] of Object.entries(deps)) {
    // A dep is present iff its package.json resolves under the harness node_modules.
    if (!existsSync(join(harnessDir, "node_modules", name, "package.json"))) {
      out.push({ name, version: String(version).replace(/^[\^~]/, "") });
    }
  }
  return out;
}

/** Install any app-declared dependency missing from the harness node_modules, pinned to the
 *  app's exact version. --no-save keeps the harness package.json/lockfile untouched (the install
 *  is per-clone and idempotent); returns an error string if the install failed (surfaced as a
 *  build-gate issue) or null on success/no-op. */
function ensureHarnessDeps(appDir: string, harnessDir: string): string | null {
  const missing = missingHarnessDeps(appDir, harnessDir);
  if (!missing.length) return null;
  const specs = missing.map((d) => `${d.name}@${d.version}`);
  const res = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...specs], {
    cwd: harnessDir,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  if (res.status !== 0) {
    return `harness dep install failed for ${specs.join(", ")}: ${(res.stderr || res.stdout || "").split("\n").filter(Boolean).slice(-3).join(" | ")}`;
  }
  return null;
}

/** Build the generated app inside the shared harness (deps preinstalled). */
export function buildApp(appDir: string, harnessDir: string): BuildResult {
  const t0 = Date.now();
  const depErr = ensureHarnessDeps(appDir, harnessDir);
  if (depErr) return { ok: false, outDir: null, stderr: depErr, durationMs: Date.now() - t0 };
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

/** Result of interpreting a `Range` header against a known resource size.
 *  - `kind: "full"`  → no (usable) Range header; answer with a normal 200 full body.
 *  - `kind: "range"` → a single satisfiable `bytes=start-end`; answer 206 with [start,end].
 *  - `kind: "unsatisfiable"` → a syntactically valid range wholly past EOF; answer 416. */
export type RangeResolution =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** Parse a single-range HTTP `Range` header ("bytes=start-end", "bytes=start-",
 *  "bytes=-suffix") against a resource of `size` bytes. Multi-range ("a-b,c-d") is
 *  intentionally collapsed to a full 200 (Chromium's media element only ever asks for a
 *  single range, and RFC 7233 lets a server ignore Range and reply 200). Anything the
 *  spec calls malformed (missing "bytes=", non-numeric, inverted, both bounds empty) is
 *  also treated as "full" — the safe fallback. A well-formed range that starts at or past
 *  EOF is "unsatisfiable" → 416. `end` is inclusive and clamped to size-1. */
export function parseRangeHeader(header: string | undefined, size: number): RangeResolution {
  if (!header) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "full" }; // absent/malformed/multi-range → serve full body
  const startStr = m[1]!;
  const endStr = m[2]!;
  if (startStr === "" && endStr === "") return { kind: "full" }; // "bytes=-" is malformed
  if (size <= 0) return { kind: "unsatisfiable" };
  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: "bytes=-N" → last N bytes.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "full" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isFinite(start)) return { kind: "full" };
    if (start >= size) return { kind: "unsatisfiable" }; // start past EOF
    end = endStr === "" ? size - 1 : Number(endStr);
    if (!Number.isFinite(end)) return { kind: "full" };
    if (end < start) return { kind: "full" }; // inverted → ignore Range
    end = Math.min(end, size - 1);
  }
  return { kind: "range", start, end };
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
      const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      const size = statSync(filePath).size;
      // HTTP Range support (RFC 7233). Chromium requests <video>/<audio> with `Range: bytes=0-`
      // and, absent a 206, holds the single progressive stream open throttled to playback — a
      // long autoplay hero (76s) then means `waitUntil:"networkidle"` can mathematically never
      // fire. Answering 206 with bounded chunks lets Chromium fetch in pieces so the network
      // goes idle between reads. A HEAD-style range far past EOF gets a 416.
      const range = parseRangeHeader(req.headers.range as string | undefined, size);
      if (range.kind === "unsatisfiable") {
        res.writeHead(416, { "content-type": contentType, "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        res.end();
        return;
      }
      const data = await readLimited(filePath);
      if (range.kind === "range") {
        const chunk = data.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          "content-type": contentType,
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
          "accept-ranges": "bytes",
          "content-length": String(chunk.length),
        });
        res.end(chunk);
        return;
      }
      res.writeHead(200, { "content-type": contentType, "accept-ranges": "bytes", "content-length": String(data.length) });
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
  /** Non-fatal diagnostics: families the app declared via @font-face that never reached
   *  `status:"loaded"` within the wait bound (their text was measured with a fallback face). */
  fontWarnings: string[];
};

/** A single entry of `document.fonts` as reported in-page, reduced to the fields the
 *  load decision needs. Serializable so the decision logic can be unit-tested outside a browser. */
export type FontFaceStatus = { family: string; weight: string; style: string; status: string };

/** Pure decision for the font-load wait: given the current `document.fonts` entries, return the
 *  families that are DECLARED (an @font-face exists for them) and still actively `"loading"`. Only
 *  `"loading"` is pending: browsers lazy-load faces, so after `document.fonts.ready` a face the
 *  rendered text actually needs is already fetching (`"loading"`), while a face left `"unloaded"`
 *  is by definition unreferenced by any rendered text and will never load on its own — waiting on
 *  it just burns the cap. `"loaded"`/`"error"` are terminal. Empty return ⇒ no face is still
 *  fetching and the DOM may be measured. The check is state-based (not time-based), so the caller's
 *  poll is deterministic: it ends the instant this returns empty, regardless of wall-clock timing. */
export function pendingFontFamilies(faces: FontFaceStatus[]): string[] {
  const pending = new Set<string>();
  for (const f of faces) {
    const fam = f.family.replace(/^["']|["']$/g, "");
    // Only a face still actively fetching keeps its family pending; "unloaded" (unreferenced),
    // "loaded", and "error" are all non-blocking.
    if (f.status === "loading") pending.add(fam);
  }
  return [...pending].sort();
}

/** Declared @font-face faces left `"unloaded"` after the wait bound: not fetched because no
 *  rendered text resolves to them (unreferenced weight/style/unicode-subset siblings). Reported
 *  per-face (family+weight+style) for an informational-only log — these are benign, never a
 *  fidelity problem, since the text that IS measured renders in the face that actually loaded. */
export function unreferencedFontFaces(faces: FontFaceStatus[]): FontFaceStatus[] {
  return faces
    .filter((f) => f.status === "unloaded")
    .map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), weight: f.weight, style: f.style, status: f.status }))
    .sort((a, b) => `${a.family} ${a.weight} ${a.style}`.localeCompare(`${b.family} ${b.weight} ${b.style}`));
}

/** In-page: await `document.fonts.ready`, then poll (bounded) until no declared @font-face is still
 *  `"loading"`. Browsers lazy-load faces, so once ready has fired the faces the rendered text needs
 *  are already fetching; the poll only waits on those. Returns `{ pending, unreferenced }`: `pending`
 *  = families whose face was STILL `"loading"` when the bound expired (a genuinely stuck fetch, kept
 *  as a warning); `unreferenced` = faces left `"unloaded"` (declared but no rendered text resolves to
 *  them — benign, surfaced per-face for an informational log only). Runs entirely inside the browser
 *  context so it reads the live FontFaceSet. Bounded + state-based ⇒ deterministic (ends on state,
 *  never on a fixed sleep). `capMs` is a hard ceiling so a hung font request can't stall the render. */
async function awaitFontsLoaded(
  page: import("playwright").Page,
  opts?: { capMs?: number; pollMs?: number },
): Promise<{ pending: string[]; unreferenced: FontFaceStatus[] }> {
  const capMs = opts?.capMs ?? 3000;
  const pollMs = opts?.pollMs ?? 50;
  try {
    return await page.evaluate(
      async ({ capMs, pollMs }) => {
        const doc = document as Document;
        const set = doc.fonts as unknown as { ready?: Promise<unknown>; forEach?: (cb: (f: FontFaceStatus) => void) => void } | undefined;
        if (!set) return { pending: [], unreferenced: [] };
        const snapshot = (): { family: string; weight: string; style: string; status: string }[] => {
          const out: { family: string; weight: string; style: string; status: string }[] = [];
          set.forEach?.((f) => out.push({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
          return out;
        };
        // Only a face still actively fetching is pending; "unloaded" is unreferenced (never fetched).
        const pending = (faces: { family: string; weight: string; style: string; status: string }[]): string[] => {
          const p = new Set<string>();
          for (const f of faces) {
            if (f.status === "loading") p.add(f.family.replace(/^["']|["']$/g, ""));
          }
          return [...p].sort();
        };
        // First give the browser's own aggregate signal a chance (bounded — a hung request must not
        // hold ready forever). Then poll the per-face states until none are loading or the cap expires.
        await Promise.race([set.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, capMs))]);
        const deadline = Date.now() + capMs;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const faces = snapshot();
          const left = pending(faces);
          const done = left.length === 0 || Date.now() >= deadline;
          if (done) {
            const unreferenced = faces
              .filter((f) => f.status === "unloaded")
              .map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), weight: f.weight, style: f.style, status: f.status }));
            return { pending: left, unreferenced };
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
      { capMs, pollMs },
    ) as { pending: string[]; unreferenced: FontFaceStatus[] };
  } catch {
    return { pending: [], unreferenced: [] }; // no FontFaceSet (or an evaluate fault) never blocks the walk
  }
}

/** Navigate with `waitUntil:"load"` then wait for a bounded window of network quiet, so
 *  validation NEVER hard-fails on media that trickles requests. `waitUntil:"networkidle"`
 *  is a hard timeout: an autoplaying long video (even chunked via 206) keeps issuing bounded
 *  range fetches, so a strict networkidle can miss its 500ms-idle window and throw at 45s,
 *  leaving validation reportless. Instead we (1) `goto load` (fires on DOM+subresources, not
 *  on ongoing media), then (2) poll for `maxQuietMs` of 500ms network silence up to a
 *  `settleCapMs` ceiling, then proceed regardless. Normal pages reach quiet in well under a
 *  second, so total time stays comparable; only trickle-media pages spend the extra budget and
 *  then continue (the video is frame-0-normalized before the screenshot, so determinism holds).
 *  Returns the goto response (for httpStatus). */
export async function gotoAndSettle(
  page: import("playwright").Page,
  url: string,
  opts?: { gotoTimeout?: number; settleCapMs?: number; quietMs?: number; pollMs?: number },
): Promise<import("playwright").Response | null> {
  const gotoTimeout = opts?.gotoTimeout ?? 45000;
  const settleCapMs = opts?.settleCapMs ?? 10000;
  const quietMs = opts?.quietMs ?? 500;
  const pollMs = opts?.pollMs ?? 500;
  const resp = await page.goto(url, { waitUntil: "load", timeout: gotoTimeout });
  // Count in-flight requests so we can detect network quiet without relying on the
  // strict networkidle heuristic (which throws on trickle-media).
  let inflight = 0;
  const onReq = (): void => { inflight++; };
  const onDone = (): void => { inflight = Math.max(0, inflight - 1); };
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    const deadline = Date.now() + settleCapMs;
    let quietSince = inflight === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (inflight === 0) {
        if (quietSince === 0) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) break; // sustained quiet reached
      } else {
        quietSince = 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    page.off("request", onReq);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
  return resp;
}

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
      const fontWarnings: string[] = [];
      const failedResources = new Set<string>();
      let httpStatus = 0;
      try {
        const page = await ctx.newPage();
        await page.addInitScript(ESBUILD_SHIM);
        page.on("pageerror", (e) => runtimeErrors.push(String(e)));
        page.on("response", (r) => { if (r.status() >= 400) failedResources.add(`${r.status()} ${r.url()}`); });
        page.on("requestfailed", (r) => failedResources.add(`failed ${r.url()}`));
        const resp = await gotoAndSettle(page, opts.url);
        if (resp) httpStatus = resp.status();
        // Webfonts must be APPLIED before the DOM walk and the screenshot: a rendered snapshot taken
        // while the app's @font-face faces are still "unloaded" measures every text box in the
        // fallback face (systematically narrower/wider glyphs → a bogus size delta attributed to the
        // clone). Await document.fonts.ready AND poll (bounded, state-based) until every declared face
        // is terminal, so this holds for both the walk below and the screenshot further down.
        const { pending: pendingFonts, unreferenced: unrefFaces } = await awaitFontsLoaded(page);
        if (pendingFonts.length) {
          const msg = `font-wait: ${pendingFonts.length} @font-face families still loading after wait bound at ${vw}px: ${pendingFonts.join(", ")}`;
          fontWarnings.push(msg);
          console.warn(`[render] ${msg}`);
        }
        // Declared-but-unreferenced faces (no rendered text resolves to them) are benign — the
        // browser never fetched them by design. Report them per-face (family+weight+style) as an
        // informational log only; they are NOT a fidelity warning and never enter fontWarnings.
        if (unrefFaces.length) {
          const detail = unrefFaces.map((f) => `${f.family} ${f.weight} ${f.style}`).join(", ");
          console.log(`[render] font-info: ${unrefFaces.length} declared-but-unreferenced faces at ${vw}px: ${detail}`);
        }
        // Scroll to settle any lazy effects, then back to top.
        await page.evaluate(async () => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const max = document.documentElement.scrollHeight;
          for (let y = 0; y < max; y += 800) { window.scrollTo(0, y); await sleep(30); }
          window.scrollTo(0, 0); await sleep(120);
        });
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
        // Screenshot via CDP (captureBeyondViewport, no scroll-stitch) to match the SOURCE
        // channel exactly — both sides must measure the same at-rest state. Fall back to
        // Playwright's fullPage stitch if CDP fails. The clone is static so scroll-stitch
        // matters less here, but symmetric capture is the requirement.
        try {
          const shotPath = join(opts.renderedDir, "screenshots", `${vw}.png`);
          // Pin every clone-side <video> to frame 0 (paused) before the shot — the SOURCE channel is
          // now normalized to frame 0 at every viewport too, so both sides show the same frame and a
          // video's playback time can't manufacture a perceptual diff. (The static clone rarely plays,
          // but a replayed/autoplaying video would otherwise drift; symmetric normalization is the rule.)
          await normalizeVideoTime(page);
          try {
            await captureFullPageViaCDP(page, shotPath);
          } catch {
            await page.screenshot({ path: shotPath, fullPage: true, timeout: 90_000, animations: "disabled" });
          }
        } catch { /* ignore */ }
        return { viewport: vw, snapshot, runtimeErrors, fontWarnings, failedResources: [...failedResources], httpStatus };
      } finally {
        await ctx.close();
      }
    });
    const runtimeErrors = results.flatMap((r) => r.runtimeErrors);
    const fontWarnings = results.flatMap((r) => r.fontWarnings);
    const failedResources = new Set(results.flatMap((r) => r.failedResources));
    for (const r of results) snapshots[r.viewport] = r.snapshot;
    const non200 = results.find((r) => r.httpStatus && r.httpStatus !== 200);
    const httpStatus = non200?.httpStatus ?? results.find((r) => r.httpStatus)?.httpStatus ?? 0;
    ensureDir(join(opts.renderedDir, "computed"));
    return { snapshots, runtimeErrors, httpStatus, failedResources: [...failedResources], fontWarnings };
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
        await gotoAndSettle(page, opts.url);
        // This probe walks the DOM and measures text boxes, so — exactly as renderApp does — webfonts
        // must be applied first, else the probe reads fallback-font widths at the off-band widths.
        await awaitFontsLoaded(page);
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
