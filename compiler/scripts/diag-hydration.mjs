// Run a generated app in Next DEV mode (unminified React) and print hydration errors.
import { spawn } from "node:child_process";
import { cpSync, rmSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const appDir = process.argv[2];
const harness = new URL("../.harness", import.meta.url).pathname;
const PORT = 3987;

for (const s of ["src", "public", "next.config.mjs", "tsconfig.json", "next-env.d.ts", ".next", "out"]) {
  const p = `${harness}/${s}`;
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
cpSync(`${appDir}/src`, `${harness}/src`, { recursive: true });
if (existsSync(`${appDir}/public`)) cpSync(`${appDir}/public`, `${harness}/public`, { recursive: true });
for (const f of ["next.config.mjs", "tsconfig.json", "next-env.d.ts"]) {
  if (existsSync(`${appDir}/${f}`)) cpSync(`${appDir}/${f}`, `${harness}/${f}`);
}

const dev = spawn("./node_modules/.bin/next", ["dev", "-p", String(PORT)], {
  cwd: harness, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
let ready = false;
dev.stdout.on("data", (d) => { if (/Ready in|Local:|started server/i.test(d.toString())) ready = true; });
dev.stderr.on("data", () => {});

const t0 = Date.now();
while (!ready && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.launch();
const page = await browser.newPage();
const msgs = [];
page.on("console", (m) => { msgs.push(m.text()); });
page.on("pageerror", (e) => msgs.push("PAGEERROR: " + e.message));
try { await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle", timeout: 60000 }); } catch (e) { msgs.push("goto: " + e.message); }
await new Promise((r) => setTimeout(r, 3000));

console.log("=== ALL CONSOLE MESSAGES (" + msgs.length + ") ===");
for (const e of msgs.slice(0, 12)) console.log("\n---\n" + e.slice(0, 1500));
await browser.close();
dev.kill("SIGKILL");
process.exit(0);
