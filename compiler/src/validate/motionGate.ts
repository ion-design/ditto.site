import { chromium } from "playwright";
import type { IR, IRNode } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { MotionCapture } from "../capture/motion.js";
import type { GateResult } from "./gates.js";

/**
 * Stage 5 motion gate — the deterministic motion-diff. Drives the BUILT clone and
 * verifies the captured motion is faithfully reproduced, under the same reproduce-or-
 * freeze contract as the interaction gate:
 *   - declarative CSS @keyframes animations: the clone must emit the same animation-name
 *     on the node, register the referenced @keyframes, and (decisively for infinite
 *     loops) actually be running it (`document.getAnimations()`); a keyframes set we
 *     could not capture (cross-origin sheet) is counted "frozen" — honestly left static.
 *   - WAAPI animations + rotating text (from motion.json): the clone's DittoMotion
 *     controller must instantiate the same running animation / cycle the same texts.
 * No wall-clock: the check reads the declared spec (names/timing/keyframe registration)
 * and a single getAnimations() snapshot, both deterministic. N/A auto-pass when nothing
 * was captured, so static pages are unaffected.
 */

const VIEWPORT_HEIGHTS: Record<number, number> = { 375: 812, 768: 1024, 1280: 800, 1920: 1080 };

type ExpectedCss = { cid: string; names: string[]; infinite: boolean };

/** @keyframes names the generator had available to emit (from the captured blocks). */
function capturedKeyframeNames(ir: IR): Set<string> {
  const s = new Set<string>();
  for (const block of ir.doc.keyframes ?? []) {
    const m = /@(?:-webkit-)?keyframes\s+("[^"]+"|'[^']+'|[^\s{]+)/i.exec(block);
    if (m) s.add(m[1]!.replace(/^['"]|['"]$/g, ""));
  }
  return s;
}

/** Map every IR node's capture-id (data-cid-cap) → its cid, so cap-keyed motion specs
 *  (WAAPI / rotators) resolve to the cids the clone renders. */
function capToCid(ir: IR): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (n: IRNode): void => {
    const cap = n.attrs["data-cid-cap"];
    if (cap !== undefined) m.set(cap, n.id);
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return m;
}

/** CSS-animated nodes expected from the IR (computed animation-name ≠ none). */
function collectExpectedCss(ir: IR): ExpectedCss[] {
  const vp = ir.doc.canonicalViewport;
  const out: ExpectedCss[] = [];
  const walk = (n: IRNode): void => {
    const cs = n.computedByVp[vp];
    const an = cs?.animationName;
    if (an && an !== "none") {
      const names = an.split(",").map((x) => x.trim()).filter((x) => x && x !== "none");
      if (names.length) out.push({ cid: n.id, names, infinite: /infinite/.test(cs!.animationIterationCount ?? "") });
    }
    for (const c of n.children) if (!isTextChild(c)) walk(c);
  };
  walk(ir.root);
  return out;
}

type Probe = {
  kf: string[];                       // @keyframes names registered in the clone's stylesheets
  animName: Record<string, string>;   // cid → computed animation-name
  runningCids: string[];              // cids that currently have a running animation
  textByCid: Record<string, string>;  // cid → trimmed textContent (for rotator verification)
};

/** Cheap pre-check: is there any motion to grade? Avoids launching a browser for the
 *  motion gate on the (many) static pages. */
export function motionExpected(ir: IR, motion: MotionCapture | undefined): boolean {
  if (motion && (motion.waapi.length > 0 || motion.rotators.length > 0 || (motion.reveals?.length ?? 0) > 0 || (motion.marquees?.length ?? 0) > 0)) return true;
  return collectExpectedCss(ir).length > 0;
}

export async function driveMotionGate(opts: {
  url: string;
  viewports: number[];
  ir: IR;
  motion: MotionCapture | undefined;
}): Promise<GateResult> {
  const { url, ir, motion } = opts;
  const expectedCss = collectExpectedCss(ir);
  // Map cap-keyed WAAPI/rotator specs onto the cids the clone renders; drop any whose
  // element didn't survive into the IR (pruned), like the interaction gate.
  const c2c = capToCid(ir);
  const waapi = (motion?.waapi ?? []).map((w) => ({ ...w, cid: c2c.get(w.cap) })).filter((w): w is typeof w & { cid: string } => !!w.cid);
  const rotators = (motion?.rotators ?? []).map((r) => ({ ...r, cid: c2c.get(r.cap) })).filter((r): r is typeof r & { cid: string } => !!r.cid);
  const reveals = (motion?.reveals ?? []).map((r) => ({ ...r, cid: c2c.get(r.cap) })).filter((r): r is typeof r & { cid: string } => !!r.cid);
  const marquees = (motion?.marquees ?? []).map((m) => ({ ...m, cid: c2c.get(m.cap) })).filter((m): m is typeof m & { cid: string } => !!m.cid);
  if (!expectedCss.length && !waapi.length && !rotators.length && !reveals.length && !marquees.length) {
    return { gate: "motion", pass: true, metrics: { animations: 0, na: true }, issues: [] };
  }
  const capturedKf = capturedKeyframeNames(ir);
  const vp = opts.viewports.includes(1280) ? 1280 : (opts.viewports[Math.floor(opts.viewports.length / 2)] ?? 1280);
  const vh = VIEWPORT_HEIGHTS[vp] ?? Math.round(vp * 0.66);

  const issues: string[] = [];
  let cssReproduced = 0, cssFrozen = 0, cssRunning = 0;
  let waapiReproduced = 0, rotatorsReproduced = 0, revealsReproduced = 0, marqueesReproduced = 0;
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: vp, height: vh }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Wait until the motion runtime has actually mounted before snapshotting getAnimations().
    // DittoMotion installs window.__dittoMotionStop in its useEffect, so its presence means
    // the WAAPI/marquee animations have been instantiated; a CSS-only page resolves on the
    // first running animation. A fixed 200ms misses this once the page is heavy (e.g. large
    // captured menu HTML slows hydration), so wait on the signal with a bounded fallback.
    await page.waitForFunction(
      () => (window as unknown as { __dittoMotionStop?: unknown }).__dittoMotionStop !== undefined || (document.getAnimations ? document.getAnimations().length > 0 : false),
      { timeout: 4000 },
    ).catch(() => {});
    await page.waitForTimeout(150); // let the just-instantiated animations register in getAnimations()

    const probe: Probe = await page.evaluate(() => {
      const kf = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        try { for (const r of Array.from(sheet.cssRules)) { if (r.constructor.name === "CSSKeyframesRule") kf.add((r as CSSKeyframesRule).name); } } catch { /* cross-origin */ }
      }
      const animName: Record<string, string> = {};
      const textByCid: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-cid]"))) {
        const cid = el.getAttribute("data-cid")!;
        const an = getComputedStyle(el).animationName;
        if (an && an !== "none") animName[cid] = an;
        textByCid[cid] = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
      }
      const runningCids: string[] = [];
      try {
        for (const a of (document.getAnimations ? document.getAnimations() : [])) {
          const t = (a as unknown as { effect?: { target?: Element } }).effect?.target;
          const cid = t?.getAttribute?.("data-cid");
          if (cid) runningCids.push(cid);
        }
      } catch { /* ignore */ }
      return { kf: Array.from(kf), animName, runningCids, textByCid };
    });

    const presentKf = new Set(probe.kf);
    const runningSet = new Set(probe.runningCids);

    // ---- declarative CSS @keyframes ----
    for (const e of expectedCss) {
      const reproducible = e.names.filter((n) => capturedKf.has(n));
      if (reproducible.length === 0) { cssFrozen++; continue; } // keyframes not captured → frozen (honest)
      const cloneAn = probe.animName[e.cid] ?? "";
      const namesEmitted = reproducible.every((n) => cloneAn.includes(n));
      const kfRegistered = reproducible.every((n) => presentKf.has(n));
      const isRunning = runningSet.has(e.cid);
      // Decisive: names emitted + keyframes registered, and (for infinite loops) actually
      // running. Finite entrances may have already finished, so running is not required.
      const ok = namesEmitted && kfRegistered && (!e.infinite || isRunning);
      if (ok) { cssReproduced++; if (isRunning) cssRunning++; }
      else issues.push(`css anim cid ${e.cid} [${reproducible.join(",")}] emitted=${namesEmitted} kf=${kfRegistered} running=${isRunning}`);
    }

    // ---- WAAPI (Framer Motion etc.) — DittoMotion must instantiate a running animation ----
    for (const w of waapi) {
      if (runningSet.has(w.cid)) waapiReproduced++;
      else issues.push(`waapi anim cid ${w.cid} not running in clone`);
    }

    // ---- marquees (rAF tickers reconstructed as an infinite WAAPI translateX) — must be running ----
    for (const m of marquees) {
      if (runningSet.has(m.cid)) marqueesReproduced++;
      else issues.push(`marquee cid ${m.cid} not running in clone`);
    }

    // ---- rotating text — DittoMotion must cycle through the captured texts ----
    for (const r of rotators) {
      const seen = new Set<string>();
      for (let i = 0; i < r.texts.length + 2; i++) {
        const t = (probe.textByCid[r.cid] ?? "");
        const cur = await page.evaluate((cid) => {
          const el = document.querySelector(`[data-cid="${cid}"]`);
          return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
        }, r.cid);
        seen.add(cur || t);
        await page.waitForTimeout(Math.max(r.intervalMs, 120));
      }
      const hit = r.texts.filter((tx) => [...seen].some((s) => s.includes(tx))).length;
      if (hit >= Math.min(2, r.texts.length)) rotatorsReproduced++;
      else issues.push(`rotator cid ${r.cid} cycled ${hit}/${r.texts.length} captured texts`);
    }

    // ---- scroll reveals — scrolling each into view must reveal it (opacity → visible) ----
    const opacityOf = (cid: string): Promise<number> =>
      page.evaluate((c) => { const el = document.querySelector(`[data-cid="${c}"]`); return el ? parseFloat(getComputedStyle(el).opacity || "1") : -1; }, cid);
    for (const rv of reveals.slice(0, 16)) {
      try {
        await page.evaluate((c) => document.querySelector(`[data-cid="${c}"]`)?.scrollIntoView({ block: "center" }), rv.cid);
        await page.waitForTimeout(650); // allow the reveal transition to complete
        const after = await opacityOf(rv.cid);
        if (after >= 0.5) revealsReproduced++;
        else issues.push(`reveal cid ${rv.cid} opacity after scroll-into-view ${after}`);
      } catch { issues.push(`reveal cid ${rv.cid} drive error`); }
    }

    await ctx.close();
  } catch (e) {
    issues.push("motion drive error: " + String(e).slice(0, 200));
  } finally {
    await browser.close();
  }

  const cssExpected = expectedCss.length;
  const droveOk = !issues.some((i) => i.startsWith("motion drive error"));
  // Pass: every captured animation is either faithfully reproduced or honestly frozen
  // (keyframes uncapturable), every WAAPI/rotator reproduced, and the driver didn't crash.
  const pass = droveOk
    && cssReproduced + cssFrozen === cssExpected
    && waapiReproduced === waapi.length
    && rotatorsReproduced === rotators.length
    && revealsReproduced === reveals.length
    && marqueesReproduced === marquees.length;
  return {
    gate: "motion",
    pass,
    metrics: {
      animations: cssExpected + waapi.length + rotators.length + reveals.length + marquees.length,
      css: `${cssReproduced}/${cssExpected}`, cssReproduced, cssFrozen, cssRunning,
      waapi: `${waapiReproduced}/${waapi.length}`,
      rotators: `${rotatorsReproduced}/${rotators.length}`,
      reveals: `${revealsReproduced}/${reveals.length}`,
      marquees: `${marqueesReproduced}/${marquees.length}`,
    },
    issues: issues.slice(0, 12),
  };
}
