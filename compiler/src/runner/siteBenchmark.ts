#!/usr/bin/env -S npx tsx
/**
 * Site benchmark runner (Stage 3). Runs clone-site over benchmarks/sites.json,
 * grading each generated multi-route app with the site validator, then aggregates
 * a scorecard: per-site routes passing, link integrity, site determinism.
 *
 *   npm run bench-site                 # full: crawl + capture + generate + validate
 *   npm run bench-site -- --reuse      # re-validate the latest run per site (no capture)
 *   npm run bench-site -- --only=site-brew,site-overreacted
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runCloneSite, regenerateSite } from "../site/cloneSite.js";
import { validateSite, type SiteReport } from "../site/validateSite.js";
import { siteIdFromUrl } from "../cli.js";
import { readJSON, writeJSON, writeText } from "../util/fsx.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, "..", "..", ".harness");

type BenchSite = { id: string; url: string; maxRoutes?: number; maxDepth?: number; maxCollectionInstances?: number; notes?: string };

type SiteOutcome = {
  id: string;
  url: string;
  status: "pass" | "partial" | "fail" | "error";
  routesTotal: number;
  routesGates0to6: number;
  routesStage2: number;
  avgScore: number;
  linkIntegrity: boolean;
  siteDeterminism: boolean;
  collections: number;
  runDir: string | null;
  error?: string;
};

function ensureHarness(): void {
  if (!existsSync(join(HARNESS, "node_modules", ".bin", "next"))) {
    const r = spawnSync("npm", ["install"], { cwd: HARNESS, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) throw new Error("harness npm install failed");
  }
}

function latestRunDir(runsDir: string, url: string): string | null {
  const siteDir = join(runsDir, "site-" + siteIdFromUrl(url));
  if (!existsSync(siteDir)) return null;
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (existsSync(join(siteDir, runs[i]!, "site-manifest.json"))) return join(siteDir, runs[i]!);
  }
  return null;
}

function outcomeOf(site: BenchSite, report: SiteReport, runDir: string): SiteOutcome {
  const avg = report.routes.length ? report.routes.reduce((s, r) => s + r.report.scorecard.total, 0) / report.routes.length : 0;
  const allPass = report.routesGates0to6 === report.routesTotal && report.routesTotal > 0 && report.linkIntegrity.pass && report.siteDeterminism.pass;
  const status: SiteOutcome["status"] = allPass ? "pass" : report.routesGates0to6 > 0 ? "partial" : "fail";
  return {
    id: site.id, url: site.url, status,
    routesTotal: report.routesTotal, routesGates0to6: report.routesGates0to6, routesStage2: report.routesStage2,
    avgScore: Math.round(avg * 10) / 10, linkIntegrity: report.linkIntegrity.pass, siteDeterminism: report.siteDeterminism.pass,
    collections: report.routes.length ? (readJSON<{ collections?: unknown[] }>(join(runDir, "site-manifest.json")).collections?.length ?? 0) : 0,
    runDir,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const reuse = args.includes("--reuse");
  const regen = args.includes("--regen"); // re-generate from existing captures, then validate
  const runsArg = args.find((a) => a.startsWith("--runs="))?.split("=")[1];
  const runsDir = runsArg ? resolve(runsArg) : resolve(HERE, "..", "..", "..", "runs");
  const benchFile = resolve(HERE, "..", "..", "benchmarks", "sites.json");
  let sites: BenchSite[] = readJSON<BenchSite[]>(benchFile);
  if (only) sites = sites.filter((s) => only.includes(s.id) || only.includes(s.url));

  ensureHarness();
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  const outcomes: SiteOutcome[] = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    const t0 = Date.now();
    log({ event: "site_bench_start", i: i + 1, total: sites.length, id: site.id, url: site.url, reuse });
    try {
      let runDir: string | null;
      let report: SiteReport;
      if (regen) {
        runDir = latestRunDir(runsDir, site.url);
        if (!runDir) throw new Error("no existing run to regenerate");
        report = (await regenerateSite(runDir, { validate: true, tier: "stage2", log })).siteReport!;
      } else if (reuse) {
        runDir = latestRunDir(runsDir, site.url);
        if (!runDir) throw new Error("no existing run to reuse");
        report = await validateSite(runDir, { harnessDir: HARNESS, tier: "stage2", log });
      } else {
        const res = await runCloneSite({ url: site.url, runsDir, maxRoutes: site.maxRoutes, maxDepth: site.maxDepth, maxCollectionInstances: site.maxCollectionInstances, validate: true, tier: "stage2", log });
        runDir = res.runDir;
        report = res.siteReport!;
      }
      const outcome = outcomeOf(site, report, runDir);
      outcomes.push(outcome);
      log({ event: "site_bench_done", id: site.id, status: outcome.status, routes: `${outcome.routesGates0to6}/${outcome.routesTotal}`, avg: outcome.avgScore, links: outcome.linkIntegrity, det: outcome.siteDeterminism, sec: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      outcomes.push({ id: site.id, url: site.url, status: "error", routesTotal: 0, routesGates0to6: 0, routesStage2: 0, avgScore: 0, linkIntegrity: false, siteDeterminism: false, collections: 0, runDir: null, error: String(e).slice(0, 300) });
      log({ event: "site_bench_error", id: site.id, error: String(e).slice(0, 200) });
    }
  }

  const summary = {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    sitesTotal: outcomes.length,
    sitesPass: outcomes.filter((o) => o.status === "pass").length,
    routesTotal: outcomes.reduce((s, o) => s + o.routesTotal, 0),
    routesGates0to6: outcomes.reduce((s, o) => s + o.routesGates0to6, 0),
    outcomes: outcomes.sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeJSON(join(runsDir, "site-benchmark-summary.json"), summary);
  writeText(join(runsDir, "site-benchmark-summary.md"), summaryMd(summary, outcomes));
  log({ event: "site_bench_complete", sitesPass: summary.sitesPass, sitesTotal: summary.sitesTotal, routes: `${summary.routesGates0to6}/${summary.routesTotal}` });
}

function summaryMd(summary: Record<string, unknown>, outcomes: SiteOutcome[]): string {
  const lines: string[] = [
    `# Site benchmark summary`,
    ``,
    `- Sites fully passing: **${summary.sitesPass} / ${summary.sitesTotal}**`,
    `- Routes passing Gates 0–6: **${summary.routesGates0to6} / ${summary.routesTotal}**`,
    ``,
    `| Site | Status | Routes G0–6 | Stage2 | Avg | Links | Determinism | Collections |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const o of outcomes) {
    lines.push(`| ${o.id} | ${o.status} | ${o.routesGates0to6}/${o.routesTotal} | ${o.routesStage2}/${o.routesTotal} | ${o.avgScore} | ${o.linkIntegrity ? "✅" : "❌"} | ${o.siteDeterminism ? "✅" : "❌"} | ${o.collections} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
