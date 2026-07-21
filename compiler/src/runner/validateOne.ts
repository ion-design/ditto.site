import { resolve } from "node:path";
import { validateRun } from "../validate/validate.js";
import { pathToFileURL } from "node:url";

/** One-off single-run validator: `validate-one <runDir> [--tier=easy]`.
 *  Used during development to gate-check a specific generated run without the
 *  full benchmark loop (e.g. verifying Stage-4 interaction output). */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  if (!runDir) { console.error("usage: validate-one <runDir> [--tier=easy]"); process.exit(1); }
  const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "easy";
  const report = await validateRun(resolve(runDir), { tier, log: (e) => console.log(JSON.stringify(e)) });
  const failing = Object.entries(report.gates).filter(([, g]) => !g.pass).map(([k]) => k);
  const interaction = report.gates.interaction;
  const motion = report.gates.motion;
  console.log(JSON.stringify({ event: "validate_done", status: report.status, score: report.scorecard.total, gates0to6: report.gates0to6Pass, stage2: report.stage2Pass, failing,
    interaction: interaction ? { pass: interaction.pass, metrics: interaction.metrics } : undefined,
    motion: motion ? { pass: motion.pass, metrics: motion.metrics } : undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
