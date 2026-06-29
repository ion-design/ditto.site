/**
 * Breakpoint discovery using the browser as the layout oracle.
 *
 * We capture at a few fixed widths and force the responsive bands onto Tailwind's default
 * breakpoints — which is wrong for any site whose real cut points differ, and can spawn extra bands
 * when our sample widths happen to straddle a breakpoint that isn't really there. Instead, ASK the
 * page: sweep the viewport width and find the exact widths where the layout actually changes.
 *
 * Media queries cause DISCRETE jumps in structural properties (display, flex-direction, flex-wrap,
 * grid track count, position, float, text-align, visibility) — those flip only at a breakpoint,
 * whereas widths/heights scale smoothly. So we hash that discrete signature across a coarse width
 * scan, then binary-search each interval where the hash changed down to 1px. The result is the
 * site's REAL breakpoint set, to drive both the capture sample widths and the emitted band edges.
 */
import type { Page } from "playwright";

/** In-page: a hash of every element's discrete (media-query-toggled) layout properties. Pure
 *  structural — excludes widths/heights/font-size, which vary continuously and would mask the steps. */
const DISCRETE_SIGNATURE = (): string => {
  let s = "";
  const walk = (el: Element): void => {
    const cs = getComputedStyle(el);
    const cols = (cs.gridTemplateColumns || "none") === "none" ? 0 : cs.gridTemplateColumns.split(" ").filter(Boolean).length;
    const painted = (el as HTMLElement).offsetParent !== null || cs.position === "fixed" ? 1 : 0;
    s += `${cs.display}|${cs.flexDirection}|${cs.flexWrap}|${cols}|${cs.position}|${cs.float}|${cs.textAlign}|${cs.visibility}|${painted};`;
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]!);
  };
  walk(document.body);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

export async function discoverBreakpoints(
  page: Page,
  opts?: { min?: number; max?: number; coarseStep?: number; height?: number },
): Promise<number[]> {
  const min = opts?.min ?? 320;
  const max = opts?.max ?? 1920;
  const step = opts?.coarseStep ?? 16;
  const height = opts?.height ?? 1200;
  const sig = async (w: number): Promise<string> => {
    await page.setViewportSize({ width: w, height });
    return page.evaluate(DISCRETE_SIGNATURE);
  };

  // Coarse scan: record where the signature changes between adjacent samples.
  const coarse: { w: number; sig: string }[] = [];
  for (let w = min; w <= max; w += step) coarse.push({ w, sig: await sig(w) });

  // Binary-search each changed interval down to 1px — the edge where the NEW layout begins.
  const edges: number[] = [];
  for (let i = 1; i < coarse.length; i++) {
    if (coarse[i]!.sig === coarse[i - 1]!.sig) continue;
    let lo = coarse[i - 1]!.w, hi = coarse[i]!.w; const loSig = coarse[i - 1]!.sig;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((await sig(mid)) === loSig) lo = mid; else hi = mid;
    }
    edges.push(hi);
  }
  return edges;
}
