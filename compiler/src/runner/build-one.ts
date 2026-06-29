/** Build one deliverable into the shared harness and copy its static export to /tmp/<site>-site. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, rmSync } from "node:fs";
import { buildApp } from "../validate/render.js";

const HARNESS = resolve(fileURLToPath(new URL("../../.harness", import.meta.url)));
const site = process.argv[2];
if (!site) { console.error("usage: build-one <site>"); process.exit(1); }
const appDir = resolve(fileURLToPath(new URL(`../../output/${site}/app`, import.meta.url)));
const t0 = Date.now();
const b = buildApp(appDir, HARNESS);
if (!b.ok || !b.outDir) { console.error("BUILD FAILED\n" + b.stderr.slice(-2000)); process.exit(1); }
const dest = `/tmp/${site}-site`;
rmSync(dest, { recursive: true, force: true });
cpSync(b.outDir, dest, { recursive: true });
console.log(`built ${site} in ${Date.now() - t0}ms → ${dest}`);
