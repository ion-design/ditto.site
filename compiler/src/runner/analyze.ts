import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { readJSON } from "../util/fsx.js";
import type { Report } from "../validate/report.js";

/**
 * Aggregates the latest per-site validation reports under a runs dir into a
 * prioritized view: which gates fail across sites, which computed-style
 * properties dominate failures, and a per-site one-liner. Used to decide what to
 * fix next without paging through individual reports.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function latestReport(siteDir: string): Report | null {
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const rp = join(siteDir, runs[i]!, "validation", "report.json");
    if (existsSync(rp)) return readJSON<Report>(rp);
  }
  return null;
}

function main(): void {
  const runsArg = process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1];
  const runsDir = runsArg ? resolve(runsArg) : resolve(HERE, "..", "..", "..", "runs");
  if (!existsSync(runsDir)) { console.error("no runs dir:", runsDir); process.exit(1); }

  const siteDirs = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d)) && !d.startsWith("benchmark") && !d.endsWith(".json"));
  const reports: Array<{ site: string; r: Report }> = [];
  for (const d of siteDirs) {
    const r = latestReport(join(runsDir, d));
    if (r) reports.push({ site: d, r });
  }
  reports.sort((a, b) => a.site.localeCompare(b.site));

  const gateFailCounts: Record<string, number> = {};
  const stylePropFails: Record<string, number> = {};
  const layoutReasons: Record<string, number> = {};
  let pass = 0;

  console.log(`\n=== ${reports.length} sites ===\n`);
  console.log("site".padEnd(26), "score", "g0-6", "failing");
  for (const { site, r } of reports) {
    if (r.gates0to6Pass) pass++;
    const failing = Object.entries(r.gates).filter(([, g]) => !g.pass).map(([k]) => k);
    for (const g of failing) gateFailCounts[g] = (gateFailCounts[g] ?? 0) + 1;
    const sp = (r.gates.style?.metrics?.topFailingProps ?? {}) as Record<string, number>;
    if (!r.gates.style?.pass) for (const [p, c] of Object.entries(sp)) stylePropFails[p] = (stylePropFails[p] ?? 0) + c;
    if (r.gates.layout && !r.gates.layout.pass) for (const iss of r.gates.layout.issues) {
      const key = iss.replace(/vp\d+ /, "").replace(/[\d.]+/g, "N");
      layoutReasons[key] = (layoutReasons[key] ?? 0) + 1;
    }
    console.log(site.padEnd(26), String(r.scorecard.total).padStart(5), r.gates0to6Pass ? " Y  " : " N  ", failing.join(",") || "PASS");
  }

  console.log(`\n=== Gates 0-6 passing: ${pass}/${reports.length} ===`);
  console.log("gate fail counts:", JSON.stringify(sortObj(gateFailCounts)));
  console.log("style prop fails (sum):", JSON.stringify(sortObj(stylePropFails)));
  console.log("layout reasons:", JSON.stringify(sortObj(layoutReasons)));
  const avg = reports.reduce((s, x) => s + x.r.scorecard.total, 0) / (reports.length || 1);
  console.log("avg score:", Math.round(avg * 10) / 10);
}

function sortObj(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

main();
