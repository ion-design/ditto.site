/**
 * Self-converging sizing refinement.
 *
 * The sizing probe is ground truth when it runs against the SOURCE at capture. In this sandbox the
 * egress proxy can't tunnel the browser to the live site, so we fall back to probing the LOCAL clone
 * render — but then there's a compounding effect: each element is probed against the OTHER elements'
 * still-baked widths, so dropping ~120 at once shifts context and the first regen overshoots. The
 * fix is to iterate render→regen until the output stops changing: each cycle re-probes the layout
 * the previous drops produced, so the flags and the render agree at the fixed point.
 *
 * (With a real source-probe this is a one-pass no-op — the source layout never changes, so the very
 * first set of flags is already consistent and the loop exits after one render.)
 */
import { join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { buildApp, serveStatic, renderApp } from "../validate/render.js";
import { generateAll } from "./pipeline.js";
import { readJSON } from "../util/fsx.js";
import type { CaptureResult } from "../capture/capture.js";

/** A COARSE signature: the count of decimal-px dimensions + responsive breakpoints across the
 *  generated app. We converge on this (not an exact content hash) because the clone-probe can leave
 *  a handful of boundary elements oscillating between two near-equivalent layouts forever — the macro
 *  state (how many measurements leaked) is what we're driving to a fixed point. */
function coarseSignature(appDir: string): string {
  let decimals = 0, breakpoints = 0;
  const reDecimal = /-\[[0-9]+\.[0-9]+px\]/g;
  const reBp = /\b(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl):/g;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(p); }
      else if (name.endsWith(".tsx")) {
        const txt = readFileSync(p, "utf8");
        decimals += (txt.match(reDecimal) || []).length;
        breakpoints += (txt.match(reBp) || []).length;
      }
    }
  };
  walk(appDir);
  return `${decimals}/${breakpoints}`;
}

export async function refineSizing(
  runDir: string,
  harnessDir: string,
  opts?: { maxIters?: number; log?: (e: Record<string, unknown>) => void },
): Promise<{ iters: number; converged: boolean }> {
  const maxIters = opts?.maxIters ?? 4;
  const log = opts?.log ?? (() => {});
  const sourceDir = join(runDir, "source");
  const generatedDir = join(runDir, "generated");
  const appDir = join(generatedDir, "app");
  const renderedDir = join(runDir, "rendered");
  const input = readJSON<{ url: string; viewports: number[] }>(join(runDir, "input.json"));
  const capture = readJSON<CaptureResult>(join(sourceDir, "capture", "capture-result.json"));
  const viewports = input.viewports;

  let lastSig = coarseSignature(appDir);
  let iters = 0;
  let converged = false;
  for (let i = 0; i < maxIters; i++) {
    // 1) render the current clone locally → writes rendered/dom/dom-*.json with fresh probe flags
    const build = buildApp(appDir, harnessDir);
    if (!build.ok || !build.outDir) { log({ event: "refine_build_failed", i }); break; }
    const server = await serveStatic(build.outDir);
    try { await renderApp({ url: server.url + "/", viewports, renderedDir }); }
    finally { await server.close(); }
    // 2) regen consuming those flags (buildIR overlays them by cid)
    generateAll({ sourceDir, capture, viewports, sampleViewports: capture.viewports, url: input.url, outDir: generatedDir });
    iters = i + 1;
    const sig = coarseSignature(appDir);
    log({ event: "refine_iter", i, sig, prev: lastSig });
    if (sig === lastSig) { converged = true; break; }   // macro state reproduced ⇒ fixed point
    lastSig = sig;
  }
  return { iters, converged };
}
