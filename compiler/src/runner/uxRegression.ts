/**
 * UX regression tests (deterministic, fixture-driven). These guard the "clone behaves
 * like the source" fixes the gates 0–6 don't catch (they grade the settled frame at the
 * exact captured viewports, so they miss off-band fluidity and link targets):
 *
 *   - FULL-WIDTH: a full-bleed block (body + width:100% sections) must keep filling the
 *     window at an OFF-band width (1500px), not lock to the captured 1280px.
 *   - LINKS: a clone is self-contained — same-origin links become app-relative (/pricing),
 *     never the absolute source origin; external links + in-page anchors are preserved.
 *
 * Each fixture is served locally, cloned, then checked statically (generated page.tsx)
 * and behaviorally (built + rendered with Playwright). Exit code is nonzero on any failure
 * so this runs in CI. Add cases to CASES as more UX fixes land.
 *
 *   npx tsx src/runner/uxRegression.ts [--keep] [--only=<id>]
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { runClone } from "../cli.js";
import { buildApp, serveStatic } from "../validate/render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "fixtures");
const HARNESS = resolve(HERE, "..", "..", ".harness");

type Check = { name: string; pass: boolean; detail?: string };
type RenderProbe = (page: import("playwright").Page) => Promise<Check[]>;
type Case = {
  id: string;
  file: string; // fixture filename under fixtures/
  interactions?: boolean; // capture hover/focus + patterns (Stage 4)
  staticChecks: (pageTsx: string, cloneCss: string) => Check[];
  renderWidth?: number;
  renderChecks?: RenderProbe;
};

const CASES: Case[] = [
  {
    id: "layout-links",
    file: "layout-links.html",
    staticChecks: (pageTsx) => {
      const checks: Check[] = [];
      // Match both the JSX-attribute form (href="…", the current generator output) and the
      // legacy object-property form (href: "…") so the check tracks the emitter format.
      const hrefs = [...pageTsx.matchAll(/href[=:]\s*"([^"]*)"/g)].map((m) => m[1]!);
      checks.push({ name: "same-origin link → app-relative (/pricing)", pass: hrefs.includes("/pricing") && hrefs.includes("/enterprise"), detail: `hrefs=${JSON.stringify(hrefs)}` });
      checks.push({ name: "no link points back to the source origin (127.0.0.1)", pass: !hrefs.some((h) => h.includes("127.0.0.1")), detail: `hrefs=${JSON.stringify(hrefs)}` });
      checks.push({ name: "external link kept absolute", pass: hrefs.includes("https://example.com/external") });
      checks.push({ name: "in-page anchor preserved (#features)", pass: hrefs.includes("#features") });
      return checks;
    },
    renderWidth: 1500, // an OFF-band width (between the 1280 and 1920 bands)
    renderChecks: async (page) => {
      const r = await page.evaluate(() => {
        const inner = window.innerWidth;
        const bleeds = [...document.querySelectorAll("*")].filter((el) => {
          const cs = getComputedStyle(el);
          return cs.backgroundColor === "rgb(238, 242, 253)" || cs.backgroundColor === "rgb(246, 246, 246)";
        });
        const bleedFills = bleeds.length > 0 && bleeds.every((el) => Math.abs((el as HTMLElement).getBoundingClientRect().width - inner) <= 2);
        const fixed = [...document.querySelectorAll("*")].find((el) => (el as HTMLElement).textContent?.trim() === "fixed 220px") as HTMLElement | undefined;
        const bar = [...document.querySelectorAll("*")].find((el) => getComputedStyle(el).backgroundColor === "rgb(20, 24, 40)") as HTMLElement | undefined;
        const svg = document.querySelector("svg") as SVGElement | null;
        return {
          inner,
          bodyWidth: document.body.getBoundingClientRect().width,
          bleedCount: bleeds.length,
          bleedFills,
          fixedWidth: fixed ? fixed.getBoundingClientRect().width : -1,
          barWidth: bar ? bar.getBoundingClientRect().width : -1,
          svgWidth: svg ? svg.getBoundingClientRect().width : -1,
          docOverflow: document.documentElement.scrollWidth - inner,
        };
      });
      return [
        { name: `body fills the off-band window (${r.bodyWidth}px ≈ ${r.inner}px)`, pass: Math.abs(r.bodyWidth - r.inner) <= 2, detail: JSON.stringify(r) },
        { name: `full-bleed bands reach both edges (${r.bleedCount} bands)`, pass: r.bleedFills, detail: JSON.stringify(r) },
        { name: `absolute pinned bar (left:0;right:0) fills the window (${r.barWidth}px ≈ ${r.inner}px)`, pass: Math.abs(r.barWidth - r.inner) <= 2, detail: JSON.stringify(r) },
        { name: `fixed-width box stays 220px (${r.fixedWidth})`, pass: Math.abs(r.fixedWidth - 220) <= 1, detail: JSON.stringify(r) },
        { name: `full-bleed <svg> not collapsed to intrinsic width (${r.svgWidth}px, wide not ~100)`, pass: r.svgWidth >= 1000, detail: JSON.stringify(r) },
        { name: `no clone-only horizontal overflow (${r.docOverflow}px)`, pass: r.docOverflow <= 2, detail: JSON.stringify(r) },
      ];
    },
  },
  {
    id: "hover-transition",
    file: "hover-transition.html",
    interactions: true,
    staticChecks: (_pageTsx, cloneCss) => {
      const hoverRules = (cloneCss.match(/:hover\{/g) || []).length;
      const transRules = (cloneCss.match(/\{transition:/g) || []).length;
      const easedBtn = /\{transition:[^}]*background-color[^}]*0?\.25s|\{transition:[^}]*0?\.25s[^}]*background-color|\{transition:[^}]*0?\.2s[^}]*\}/.test(cloneCss);
      return [
        { name: `hover states captured (${hoverRules} :hover rules)`, pass: hoverRules >= 2, detail: cloneCss.split("\n").filter((l) => l.includes(":hover")).slice(0, 3).join(" ") },
        { name: "eased button gets its captured transition (so hover animates, not snaps)", pass: easedBtn && transRules >= 1, detail: cloneCss.split("\n").filter((l) => l.includes("transition:")).join(" ") },
        { name: `no-transition link does NOT gain a transition (exactly 1 transition rule)`, pass: transRules === 1, detail: `transitionRules=${transRules}` },
      ];
    },
  },
  {
    id: "menu-mount",
    file: "menu-mount.html",
    interactions: true,
    staticChecks: (pageTsx) => [
      { name: "mount-on-open menu reproduced (DropdownMenu emitted)", pass: pageTsx.includes("DropdownMenu") && pageTsx.includes("menus={"), detail: pageTsx.split("\n").filter((l) => l.includes("DropdownMenu")).join(" ").slice(0, 160) },
      { name: "panel links rewritten app-relative in the captured fragment", pass: /href=\\?"\/docs\\?"/.test(pageTsx) && !/href=\\?"https?:\/\/127\.0\.0\.1/.test(pageTsx), detail: (pageTsx.match(/DropdownMenu[\s\S]{0,400}/) || [""])[0].slice(0, 200) },
    ],
    renderWidth: 1280,
    renderChecks: async (page) => {
      const before = await page.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.textContent?.trim() === "Documentation"));
      await page.evaluate(() => { const t = [...document.querySelectorAll("button, [data-cid]")].find((e) => e.textContent?.trim() === "Product") as HTMLElement | undefined; t?.click(); });
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => {
        const links = [...document.querySelectorAll("a")] as HTMLAnchorElement[];
        const doc = links.find((a) => a.textContent?.trim() === "Documentation");
        return { shown: !!doc && doc.getBoundingClientRect().width > 1 && doc.getBoundingClientRect().height > 1, href: doc?.getAttribute("href") ?? null, count: links.length };
      });
      return [
        { name: "menu is CLOSED at base render (panel not server-rendered → gates 0–6 untouched)", pass: !before, detail: `panelLinkPresentBeforeClick=${before}` },
        { name: "clicking the trigger opens the captured panel", pass: after.shown, detail: JSON.stringify(after) },
        { name: "opened panel's links are app-relative (/docs)", pass: after.href === "/docs", detail: JSON.stringify(after) },
      ];
    },
  },
];

async function runCase(c: Case, runsDir: string): Promise<Check[]> {
  const fixtures = await serveStatic(FIXTURES);
  let checks: Check[] = [];
  try {
    const res = await runClone({ url: `${fixtures.url}/${c.file}`, runsDir, interactions: c.interactions });
    const appDir = res.appDir;
    const pageTsx = readFileSync(join(appDir, "src", "app", "page.tsx"), "utf8");
    const cloneCss = readFileSync(join(appDir, "src", "app", "ditto.css"), "utf8");
    checks = c.staticChecks(pageTsx, cloneCss);

    if (c.renderChecks && c.renderWidth) {
      const build = buildApp(appDir, HARNESS);
      if (!build.ok) {
        checks.push({ name: "clone builds", pass: false, detail: build.stderr.split("\n").filter(Boolean).slice(-4).join(" | ") });
      } else {
        const served = await serveStatic(build.outDir!);
        const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
        try {
          const ctx = await browser.newContext({ viewport: { width: c.renderWidth, height: 900 }, deviceScaleFactor: 1 });
          const page = await ctx.newPage();
          await page.goto(served.url + "/", { waitUntil: "networkidle", timeout: 45000 });
          checks.push(...(await c.renderChecks(page)));
        } finally {
          await browser.close();
          await served.close();
        }
      }
    }
  } finally {
    await fixtures.close();
  }
  return checks;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
  const keep = args.includes("--keep");
  const runsDir = mkdtempSync(join(tmpdir(), "ux-regression-"));
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  let failed = 0;
  try {
    for (const c of cases) {
      console.log(`\n=== ${c.id} (${c.file}) ===`);
      const checks = await runCase(c, runsDir);
      for (const ch of checks) {
        console.log(`  ${ch.pass ? "PASS" : "FAIL"}  ${ch.name}`);
        if (!ch.pass && ch.detail) console.log(`        ${ch.detail}`);
        if (!ch.pass) failed++;
      }
    }
  } finally {
    if (!keep && existsSync(runsDir)) rmSync(runsDir, { recursive: true, force: true });
  }
  console.log(`\n${failed === 0 ? "ALL UX CHECKS PASSED" : `${failed} UX CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
