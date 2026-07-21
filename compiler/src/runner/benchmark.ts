import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runClone, siteIdFromUrl } from "../cli.js";
import { validateRun } from "../validate/validate.js";
import { readJSON, writeJSON, writeText } from "../util/fsx.js";
import { COMPILER_VERSION } from "../generate/manifest.js";
import type { Report } from "../validate/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, "..", "..", ".harness");

type BenchSite = { id: string; url: string; tier: string; notes?: string };

type SiteOutcome = {
  id: string;
  url: string;
  tier: string;
  status: "pass" | "partial" | "fail" | "error";
  score: number;
  gates0to6Pass: boolean;
  stage2Pass: boolean;
  motionPass: boolean;
  motion?: string; // short motion-gate metric summary
  failingGates: string[];
  runDir: string | null;
  error?: string;
};

function ensureHarness(): void {
  if (!existsSync(join(HARNESS, "node_modules", ".bin", "next"))) {
    console.log(JSON.stringify({ event: "harness_install" }));
    const r = spawnSync("npm", ["install"], { cwd: HARNESS, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) throw new Error("harness npm install failed");
  }
}

function gitSha(): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: resolve(HERE, "..", "..", ".."), encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "nogit";
  } catch { return "nogit"; }
}

function latestSourceDir(runsDir: string, url: string): string | null {
  const siteDir = join(runsDir, siteIdFromUrl(url));
  if (!existsSync(siteDir)) return null;
  const runs = readdirSync(siteDir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const src = join(siteDir, runs[i]!, "source");
    if (existsSync(join(src, "capture", "capture-result.json"))) return src;
  }
  return null;
}

export async function runBenchmark(opts: {
  sites: BenchSite[];
  runsDir: string;
  reuseCaptures?: boolean;
  interactions?: boolean;
  components?: boolean;
  motion?: boolean;
  log?: (e: Record<string, unknown>) => void;
}): Promise<void> {
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  ensureHarness();
  const outcomes: SiteOutcome[] = [];

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} (${ms}ms)`)), ms))]);

  for (let i = 0; i < opts.sites.length; i++) {
    const site = opts.sites[i]!;
    const t0 = Date.now();
    log({ event: "site_start", i: i + 1, total: opts.sites.length, id: site.id, url: site.url });
    try {
      const reuseSource = opts.reuseCaptures ? latestSourceDir(opts.runsDir, site.url) ?? undefined : undefined;
      // Per-site wall-clock backstop: even with every in-capture wait bounded, no
      // single site should be able to stall the whole tier.
      const res = await withTimeout(runClone({ url: site.url, runsDir: opts.runsDir, reuseSource, interactions: opts.interactions, components: opts.components, motion: opts.motion }), 8 * 60_000, `${site.id} clone`);
      const report: Report = await withTimeout(validateRun(res.runDir, { tier: site.tier }), 6 * 60_000, `${site.id} validate`);
      const failingGates = Object.entries(report.gates).filter(([, g]) => !g.pass).map(([k]) => k);
      const mg = report.gates.motion;
      const motionStr = mg && !mg.metrics.na ? `css ${mg.metrics.css ?? "-"} waapi ${mg.metrics.waapi ?? "-"} rot ${mg.metrics.rotators ?? "-"} rev ${mg.metrics.reveals ?? "-"}` : undefined;
      outcomes.push({
        id: site.id, url: site.url, tier: site.tier,
        status: report.status, score: report.scorecard.total,
        gates0to6Pass: report.gates0to6Pass, stage2Pass: report.stage2Pass,
        motionPass: mg ? mg.pass : true, motion: motionStr, failingGates, runDir: res.runDir,
      });
      log({ event: "site_done", id: site.id, score: report.scorecard.total, status: report.status, gates0to6: report.gates0to6Pass, stage2: report.stage2Pass, motion: mg ? { pass: mg.pass, m: motionStr } : undefined, failing: failingGates, sec: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      outcomes.push({
        id: site.id, url: site.url, tier: site.tier, status: "error",
        score: 0, gates0to6Pass: false, stage2Pass: false, motionPass: false, failingGates: ["error"], runDir: null, error: String(e).slice(0, 500),
      });
      log({ event: "site_error", id: site.id, error: String(e).slice(0, 300), sec: Math.round((Date.now() - t0) / 1000) });
    }
  }

  // Aggregate
  const byTier: Record<string, { passed: number; stage2: number; total: number; sumScore: number }> = {};
  const failuresByGate: Record<string, number> = {};
  for (const o of outcomes) {
    const t = byTier[o.tier] ?? (byTier[o.tier] = { passed: 0, stage2: 0, total: 0, sumScore: 0 });
    t.total++; t.sumScore += o.score;
    if (o.gates0to6Pass) t.passed++;
    if (o.stage2Pass) t.stage2++;
    for (const g of o.failingGates) failuresByGate[g] = (failuresByGate[g] ?? 0) + 1;
  }
  const tierSummary: Record<string, unknown> = {};
  for (const [tier, v] of Object.entries(byTier)) {
    tierSummary[tier] = { passed: v.passed, stage2Passed: v.stage2, total: v.total, averageScore: Math.round((v.sumScore / v.total) * 10) / 10 };
  }

  const summary = {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    compilerVersion: COMPILER_VERSION,
    gitSha: gitSha(),
    sitesTotal: outcomes.length,
    sitesGates0to6Passed: outcomes.filter((o) => o.gates0to6Pass).length,
    sitesStage2Passed: outcomes.filter((o) => o.stage2Pass).length,
    tiers: tierSummary,
    failuresByGate,
    outcomes: outcomes.sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeJSON(join(opts.runsDir, "benchmark-summary.json"), summary);
  writeText(join(opts.runsDir, "benchmark-summary.md"), summaryMd(summary, outcomes));
  log({ event: "benchmark_done", passed: summary.sitesGates0to6Passed, stage2: summary.sitesStage2Passed, total: summary.sitesTotal, tiers: tierSummary, failuresByGate });
}

function summaryMd(summary: Record<string, unknown>, outcomes: SiteOutcome[]): string {
  const lines: string[] = [
    `# Benchmark summary`,
    ``,
    `- Compiler: ${summary.compilerVersion} (${summary.gitSha})`,
    `- Gates 0–6 passed: **${summary.sitesGates0to6Passed} / ${summary.sitesTotal}**`,
    `- Stage-2 passed (G0–6 + pollution + perceptual): **${summary.sitesStage2Passed} / ${summary.sitesTotal}**`,
    `- Tiers: ${JSON.stringify(summary.tiers)}`,
    `- Failures by gate: ${JSON.stringify(summary.failuresByGate)}`,
    ``,
    `| ID | Status | Score | G0-6 | Stage2 | Motion | Failing gates | URL |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const o of outcomes) {
    lines.push(`| ${o.id} | ${o.status} | ${o.score} | ${o.gates0to6Pass ? "✅" : "❌"} | ${o.stage2Pass ? "✅" : "❌"} | ${o.motionPass ? "✅" : "❌"}${o.motion ? " " + o.motion : ""} | ${o.failingGates.join(", ") || "—"} | ${o.url} |`);
  }
  return lines.join("\n") + "\n";
}

// ---- CLI ----
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "easy";
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const limit = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const runsArg = args.find((a) => a.startsWith("--runs="))?.split("=")[1];
  const reuseCaptures = args.includes("--reuse");
  // Stage 4/4.5/5 features are opt-in for the benchmark runner (the static benchmark
  // measures plain fidelity); enable per-run with flags. The motion tier turns motion on.
  const interactions = args.includes("--interactions");
  const components = args.includes("--components");
  const motion = args.includes("--motion") || tier === "motion";
  const runsDir = runsArg ? resolve(runsArg) : resolve(HERE, "..", "..", "..", "runs");

  const benchFile = resolve(HERE, "..", "..", "benchmarks", `${tier}.json`);
  let sites: BenchSite[] = readJSON<BenchSite[]>(benchFile);
  if (only) sites = sites.filter((s) => only.includes(s.id) || only.includes(s.url));
  if (limit) sites = sites.slice(0, parseInt(limit, 10));

  await runBenchmark({ sites, runsDir, reuseCaptures, interactions, components, motion });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
