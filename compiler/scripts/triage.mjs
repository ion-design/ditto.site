// Triage the latest run per stage-2 site: pass state + the key metric per failure.
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
    const r = join(dir, runs[i], "validation", "report.json");
    if (existsSync(r)) return join(dir, runs[i]);
  }
  return null;
}

let pass = 0, g06 = 0;
const lines = [];
for (const s of sites) {
  const run = latest(siteId(s.url));
  if (!run) { lines.push(`${s.id}  NO RUN`); continue; }
  const r = JSON.parse(readFileSync(join(run, "validation", "report.json"), "utf8"));
  if (r.gates0to6Pass) g06++;
  if (r.stage2Pass) pass++;
  const fails = Object.entries(r.gates).filter(([, g]) => !g.pass).map(([k]) => k);
  let detail = "";
  if (fails.includes("perceptual")) detail += ` perc=${JSON.stringify(r.gates.perceptual.metrics.perViewport)}`;
  if (fails.includes("layout")) { const pv = r.gates.layout.metrics.perViewport; detail += " layout=" + Object.entries(pv).filter(([, m]) => (m.heightDeltaPct > 0.05 || m.leafMedianDelta > 8 || m.sectionsBboxOkPct < 0.9)).map(([vp, m]) => `${vp}:h${m.heightDeltaPct},leaf${m.leafMedianDelta}`).join(","); }
  if (fails.includes("pollution")) detail += " poll=" + JSON.stringify(r.gates.pollution.issues);
  if (fails.includes("style")) detail += " style=" + JSON.stringify(r.gates.style.metrics.topFailingProps);
  if (fails.includes("build")) detail += " build=" + (r.gates.build.metrics.runtimeErrorSample || []).length + "errs";
  lines.push(`${r.stage2Pass ? "✅" : (r.gates0to6Pass ? "🟡" : "❌")} ${s.id} ${r.scorecard.total} [${fails.join(",") || "PASS"}]${detail}`);
}
console.log(lines.join("\n"));
console.log(`\n${tier}: gates0-6 ${g06}/${sites.length}, stage2 ${pass}/${sites.length}`);
