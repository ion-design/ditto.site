// Generate examples/<tier>/RESULTS.md from the latest run per site.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const RUNS = join(ROOT, "runs");
const tier = process.argv[2] || "stage2";
const sites = JSON.parse(readFileSync(join(ROOT, "compiler", "benchmarks", `${tier}.json`), "utf8"));

function siteId(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (host + (path ? "-" + path : "")).replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 80);
}
function latest(host) {
  const dir = join(RUNS, host);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((d) => /^\d/.test(d)).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (existsSync(join(dir, runs[i], "validation", "report.json"))) return join(dir, runs[i]);
  }
  return null;
}

let g06 = 0, s2 = 0, sum = 0, n = 0;
const rows = [];
for (const s of sites) {
  const run = latest(siteId(s.url));
  if (!run) { rows.push(`| ${s.id} | ${s.url} | — | — | no run |`); continue; }
  const r = JSON.parse(readFileSync(join(run, "validation", "report.json"), "utf8"));
  n++; sum += r.scorecard.total; if (r.gates0to6Pass) g06++; if (r.stage2Pass) s2++;
  const fails = Object.entries(r.gates).filter(([, gg]) => !gg.pass).map(([k]) => k).join(",");
  const host = new URL(s.url).hostname.replace(/^www\./, "") + new URL(s.url).pathname.replace(/\/$/, "");
  rows.push(`| ${s.id} | ${host} | ${r.scorecard.total} | ${r.gates0to6Pass ? "PASS" : "FAIL"} | ${r.stage2Pass ? "PASS" : "FAIL"} | ${fails || ""} |`);
}
const avg = Math.round((sum / n) * 10) / 10;
const md = `# Stage 2 — results (capture-state correctness)

**${g06}/${n} pass gates 0-6; ${s2}/${n} pass the stricter stage-2 bar** (gates 0-6 + non-degenerate capture + perceptually-close render), average ${avg}.
Stage 2 = popup/video/animation pages where the captured frame must be the settled, unobstructed state. Stage-2 gates: **pollution** (degenerate/wall/blocking-modal) and **perceptual** (tier-thresholded screenshot diff).

| id | site | score | gates0-6 | stage2 | failing |
|----|------|------:|:--------:|:------:|---------|
${rows.join("\n")}

Documented residuals (limitations, not defects): wix (heavy-JS site-builder — custom-element carousel positioned by script we don't run); warbyparker/squarespace (dynamic/autoplay hero — perceptual-only, frame-to-frame non-deterministic).
`;
writeFileSync(join(ROOT, "examples", tier, "RESULTS.md"), md);
console.log(`wrote examples/${tier}/RESULTS.md — gates0-6 ${g06}/${n}, stage2 ${s2}/${n}, avg ${avg}`);
