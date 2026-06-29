import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export { startEphemeralPostgres, canRunEphemeralPostgres, type EphemeralPg } from "./postgres.js";
import { startEphemeralPostgres, canRunEphemeralPostgres, type EphemeralPg } from "./postgres.js";

/** A Postgres available to tests: TEST_DATABASE_URL if set (e.g. a CI service),
 *  else a throwaway local instance when we can run one. Sync check for skip. */
export function hasTestPostgres(): boolean {
  return !!process.env.TEST_DATABASE_URL || canRunEphemeralPostgres();
}

/** Acquire a test Postgres (env URL or ephemeral). Returns null if none available. */
export async function acquireTestPostgres(): Promise<EphemeralPg | null> {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  if (canRunEphemeralPostgres()) return startEphemeralPostgres();
  return null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** repo root = packages/test-utils/src → ../../.. */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const FIXTURES_DIR = join(REPO_ROOT, "compiler", "fixtures");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Serve a directory of fixtures over loopback (zero external network). */
export function serveDir(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]!);
      if (p === "/") p = "/index.html";
      const file = join(rootDir, normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(500);
      res.end("error");
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

/** Whether a Playwright Chromium browser appears installed (browser tests skip if not). */
export function hasChromium(): boolean {
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
    if (!existsSync(base)) return false;
    return readdirSync(base).some((d) => d.startsWith("chromium"));
  } catch {
    return false;
  }
}
