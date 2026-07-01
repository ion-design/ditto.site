import type { GateResult } from "./gates.js";

export type Scorecard = {
  build: number;
  capture: number;
  assetFont: number;
  dom: number;
  style: number;
  layout: number;
  determinism: number;
  visual: number;
  total: number;
};

export type Report = {
  sourceUrl: string;
  tier: string;
  compilerVersion: string;
  generatedAt: string;
  status: "pass" | "partial" | "fail";
  gates: Record<string, GateResult>;
  gates0to6Pass: boolean;
  // Stage 2 strict bar: structural gates AND a non-degenerate capture AND a
  // perceptually-close render. This is the hard-pass criterion for the stage-2 set.
  stage2Pass: boolean;
  scorecard: Scorecard;
};

const MAX = { build: 10, capture: 10, assetFont: 15, dom: 20, style: 15, layout: 15, determinism: 10, visual: 5 };

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function round1(n: number): number { return Math.round(n * 10) / 10; }

export function scoreGates(gates: Record<string, GateResult>): Scorecard {
  const g = (name: string) => gates[name];
  const m = (name: string, key: string, def = 0): number => {
    const v = g(name)?.metrics[key];
    return typeof v === "number" ? v : def;
  };

  // build
  const build = g("build");
  let buildScore = 0;
  if (build) {
    if (build.metrics.buildOk) buildScore += 6;
    if (build.metrics.http200) buildScore += 2;
    if (build.metrics.noRuntimeErrors) buildScore += 2;
  }

  // capture
  const cap = g("capture");
  const captureScore = cap?.pass ? MAX.capture : clamp(MAX.capture - (cap?.issues.length ?? MAX.capture) * 2, 0, MAX.capture);

  // asset/font
  const a2 = g("asset_font");
  let assetScore = MAX.assetFont;
  if (a2 && !a2.pass) {
    assetScore = clamp(MAX.assetFont - (m("asset_font", "remoteRefs") + m("asset_font", "failed404")) - a2.issues.length, 0, MAX.assetFont - 1);
  }

  // dom
  const domScore = MAX.dom * (0.5 * m("dom", "textPresentPct", 0) + 0.3 * m("dom", "nodeMatchPct", 0) + 0.1 * m("dom", "linkPct", 1) + 0.1 * m("dom", "mediaPct", 1));

  // style
  const styleScore = MAX.style * m("style", "passPct", 0);

  // layout
  const layoutScore = MAX.layout * layoutSubScore(g("layout"));

  // determinism
  const determinismScore = g("determinism")?.pass ? MAX.determinism : 0;

  // visual (perceptual)
  const visualScore = MAX.visual * clamp(1 - m("perceptual", "worstDiffPct", 1), 0, 1);

  const total = buildScore + captureScore + assetScore + domScore + styleScore + layoutScore + determinismScore + visualScore;
  return {
    build: round1(buildScore), capture: round1(captureScore), assetFont: round1(assetScore),
    dom: round1(domScore), style: round1(styleScore), layout: round1(layoutScore),
    determinism: round1(determinismScore), visual: round1(visualScore), total: round1(total),
  };
}

function layoutSubScore(layout: GateResult | undefined): number {
  if (!layout) return 0;
  const perVp = (layout.metrics.perViewport ?? {}) as Record<string, Record<string, number | boolean>>;
  const vps = Object.values(perVp);
  if (vps.length === 0) return 0;
  let sum = 0;
  for (const v of vps) {
    let s = 0;
    if ((v.heightDeltaPct as number) <= 0.05) s += 0.35;
    else s += 0.35 * clamp(1 - (v.heightDeltaPct as number), 0, 1);
    s += 0.3 * (v.sectionsBboxOkPct as number ?? 0);
    if (v.orderOk) s += 0.1;
    const leaf = v.leafMedianDelta as number ?? 999;
    s += 0.25 * clamp(1 - leaf / 32, 0, 1);
    sum += s;
  }
  return sum / vps.length;
}

export function buildReport(args: {
  sourceUrl: string;
  tier: string;
  compilerVersion: string;
  gates: Record<string, GateResult>;
}): Report {
  const { sourceUrl, tier, compilerVersion, gates } = args;
  const scorecard = scoreGates(gates);
  const order = ["build", "capture", "asset_font", "dom", "style", "layout", "determinism"];
  const gates0to6Pass = order.every((k) => gates[k]?.pass);
  const stage2Pass = gates0to6Pass && (gates.pollution?.pass ?? true) && (gates.perceptual?.pass ?? true);
  const status: Report["status"] = gates0to6Pass ? "pass" : (scorecard.total >= 50 ? "partial" : "fail");
  return {
    sourceUrl, tier, compilerVersion,
    generatedAt: new Date().toISOString(),
    status, gates, gates0to6Pass, stage2Pass, scorecard,
  };
}

export function reportToMarkdown(report: Report): string {
  const s = report.scorecard;
  const gateLine = (name: string, label: string): string => {
    const g = report.gates[name];
    if (!g) return `| ${label} | — | — |`;
    const issues = g.issues.length ? g.issues.slice(0, 5).join("; ") : "—";
    return `| ${label} | ${g.pass ? "✅ pass" : "❌ fail"} | ${issues} |`;
  };
  const lines: string[] = [
    `# Clone validation report`,
    ``,
    `- **URL:** ${report.sourceUrl}`,
    `- **Tier:** ${report.tier}`,
    `- **Compiler:** ${report.compilerVersion}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Status:** ${report.status.toUpperCase()}  (Gates 0–6 ${report.gates0to6Pass ? "PASS" : "FAIL"})`,
    `- **Score:** ${s.total} / 100`,
    ``,
    `## Scorecard`,
    ``,
    `| Component | Score | Max |`,
    `| --- | --- | --- |`,
    `| Build/render | ${s.build} | ${MAX.build} |`,
    `| Capture completeness | ${s.capture} | ${MAX.capture} |`,
    `| Asset/font equivalence | ${s.assetFont} | ${MAX.assetFont} |`,
    `| Rendered DOM equivalence | ${s.dom} | ${MAX.dom} |`,
    `| Computed style equivalence | ${s.style} | ${MAX.style} |`,
    `| Layout/section equivalence | ${s.layout} | ${MAX.layout} |`,
    `| Determinism | ${s.determinism} | ${MAX.determinism} |`,
    `| Screenshot/visual | ${s.visual} | ${MAX.visual} |`,
    ``,
    `## Gates`,
    ``,
    `| Gate | Result | Issues |`,
    `| --- | --- | --- |`,
    gateLine("build", "0 Build/render"),
    gateLine("capture", "1 Capture"),
    gateLine("asset_font", "2 Asset/font"),
    gateLine("dom", "3 DOM"),
    gateLine("style", "4 Computed style"),
    gateLine("layout", "5 Layout/section"),
    gateLine("determinism", "6 Determinism"),
    gateLine("pollution", "P Pollution (capture sanity)"),
    gateLine("perceptual", "V Perceptual (screenshot)"),
    gateLine("interaction", "I Interaction (Stage 4)"),
    gateLine("motion", "M Motion (Stage 5)"),
    gateLine("responsive", "R Responsive (non-captured widths)"),
    ``,
    `- **Stage-2 pass:** ${report.stage2Pass ? "✅" : "❌"}`,
    ``,
    `## Gate metrics`,
    ``,
    "```json",
    JSON.stringify(Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.metrics])), null, 2),
    "```",
  ];
  return lines.join("\n") + "\n";
}
