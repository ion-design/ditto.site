/**
 * Code-quality audit — an honest, human-readable report over one or more generated app
 * trees. Built directly on the dimension scorer in ./qualityScore, so the audit and the
 * shipped `code-quality.md` quality number never disagree.
 *
 *   npm run audit                                  # auto: every runs/<site>/latest/generated/app
 *   npm run audit -- <appDir> [<appDir> ...]       # explicit app trees
 *   npm run audit -- runs/example/latest/generated/app
 *   npm run audit -- <dir> --json                  # machine-readable
 *
 * For each tree it prints:
 *   • the LETTER GRADE + numeric score (and any hard-cap reason),
 *   • a per-DIMENSION table (payload / decomposition / duplication / semantics / hygiene
 *     / runtime) with the visible sub-metrics behind each score,
 *   • the TOP OFFENDERS (file, metric, value) — the worst individual tells.
 * When several trees are passed it also prints a side-by-side grade comparison.
 *
 * Pure static analysis over generated source (.tsx/.jsx/.ts/.astro/.css). No builds, no
 * browser. See qualityScore.ts for the rubric + the (calibration-guide) thresholds.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { scoreApp, type QualityReport } from "./qualityScore.js";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Target resolution — accept an app dir directly, or discover deliverables.
// ---------------------------------------------------------------------------

/** Is `dir` a scannable app tree (has a src/ with code in it, or is itself full of code)? */
function isAppDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, "src"))) return true;
  try { return readdirSync(dir).some((n) => /\.(tsx|jsx|ts|css|astro)$/.test(n)); } catch { return false; }
}

/** Discover every runs/<site>/latest/generated/app deliverable, newest layout first.
 *  Checks both the cwd and its parent, so `npm run audit` works whether invoked from the
 *  repo root or from compiler/ (where runs/ lives one level up). */
function discoverTargets(): string[] {
  const out: string[] = [];
  const roots = ["runs", "output", "../runs", "../output"].map((r) => resolve(r)).filter(existsSync);
  for (const root of roots) {
    let sites: string[];
    try { sites = readdirSync(root); } catch { continue; }
    for (const site of sites) {
      for (const app of [
        join(root, site, "latest", "generated", "app"),
        join(root, site, "app"),
      ]) {
        if (isAppDir(app)) { out.push(app); break; }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A readable column label for a target (its site/run name where possible). */
function labelFor(dir: string): string {
  const parts = resolve(dir).split("/");
  const runsIdx = parts.lastIndexOf("runs");
  const outIdx = parts.lastIndexOf("output");
  const i = runsIdx >= 0 ? runsIdx : outIdx;
  if (i >= 0 && parts[i + 1]) return parts[i + 1]!.slice(0, 22);
  return (parts[parts.length - 2] ?? basename(dir)).slice(0, 22);
}

const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
const padL = (s: string, w: number): string => " ".repeat(Math.max(0, w - s.length)) + s;

function renderReport(label: string, rep: QualityReport): string {
  const L: string[] = [];
  L.push("");
  L.push(`━━━ ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(`  GRADE ${rep.grade}   (${rep.total}/100)`);
  if (rep.caps.length) {
    L.push(`  HARD CAP → grade limited to D-range:`);
    for (const c of rep.caps) L.push(`    • ${c}`);
  }
  L.push("");
  L.push(`  ${pad("dimension", 15)}${padL("score", 9)}   sub-metrics`);
  L.push(`  ${"─".repeat(66)}`);
  for (const [dim, cat] of Object.entries(rep.categories)) {
    const metrics = Object.entries(cat.metrics).map(([k, v]) => `${k}=${v}`).join(" ");
    L.push(`  ${pad(dim, 15)}${padL(`${cat.score}/${cat.max}`, 9)}   ${metrics}`);
  }
  if (rep.offenders.length) {
    L.push("");
    L.push(`  top offenders`);
    L.push(`  ${pad("metric", 34)}${padL("value", 12)}  file`);
    L.push(`  ${"─".repeat(66)}`);
    for (const o of rep.offenders.slice(0, 10)) {
      L.push(`  ${pad(o.metric, 34)}${padL(String(o.value), 12)}  ${o.file}`);
    }
  }
  return L.join("\n");
}

function renderComparison(labels: string[], reps: QualityReport[]): string {
  const L: string[] = [];
  const colW = Math.max(12, ...labels.map((l) => l.length + 2));
  L.push("");
  L.push(`━━━ comparison ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  L.push("  " + pad("dimension", 15) + labels.map((l) => padL(l, colW)).join(""));
  const dims = Object.keys(reps[0]!.categories);
  for (const d of dims) {
    L.push("  " + pad(d, 15) + reps.map((r) => padL(String(r.categories[d]!.score), colW)).join(""));
  }
  L.push("  " + pad("GRADE", 15) + reps.map((r) => padL(`${r.grade} (${r.total})`, colW)).join(""));
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const asJson = process.argv.includes("--json");
  const targets = (args.length ? args.map((a) => resolve(a)) : discoverTargets()).filter(isAppDir);
  if (!targets.length) { console.error("no app trees found — pass app dirs explicitly (e.g. runs/<site>/latest/generated/app)"); process.exit(1); }

  const labels = targets.map(labelFor);
  const reports = targets.map((t) => scoreApp(t));

  if (asJson) {
    console.log(JSON.stringify(reports.map((r, i) => ({ label: labels[i], ...r })), null, 2));
    return;
  }

  for (let i = 0; i < reports.length; i++) console.log(renderReport(labels[i]!, reports[i]!));
  if (reports.length > 1) console.log(renderComparison(labels, reports));
  console.log("\n(scores are out of each dimension's max; grade is the weighted blend, capped to\n D-range if any single file/line/blob is in catastrophic payload territory.)\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
