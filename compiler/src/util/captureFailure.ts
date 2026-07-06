/** Capture-side fast-fail helpers (Item 3).
 *
 *  Two concerns share this module because both are pure, testable predicates the
 *  capture flow keys off:
 *
 *   1. Wall-text detection — the SAME signature set the validator's pollution gate
 *      uses (validate/gates.ts imports WALL_RE from here). Extracted so the two
 *      judgments — capture-side abort and validator-side grade — can never drift.
 *      The pollution gate remains the AUTHORITY on whether a shipped capture is
 *      polluted; this module only lets capture bail early on an obvious wall
 *      instead of burning the full multi-viewport pass on garbage.
 *
 *   2. Nav-failure classification — decides whether a navigation/session error is
 *      worth ONE fresh-context retry (transient: the browser/page died, a socket
 *      reset, a nav timeout) versus terminal (a wall, a hard DNS/cert failure that
 *      a retry cannot fix). Pure string classification so it unit-tests without a
 *      browser.
 */

/** Bot/egress/auth-wall text signatures. One regex, shared with the pollution gate
 *  (validate/gates.ts) so capture-abort and validator-grade use identical fingerprints. */
export const WALL_RE =
  /blocked by egress|access denied|access to this page has been denied|are you a (human|robot)|verify you are human|enable javascript to|please enable javascript|checking your browser|just a moment|attention required|request blocked|why have i been blocked|captcha|cf-browser-verification|ddos protection by/i;

export function isWallText(text: string): boolean {
  return WALL_RE.test(text);
}

/** Node-count ceiling under which wall text is treated as a genuine interstitial
 *  rather than an incidental mention on a real page. Matches the pollution gate's
 *  `wall && nodeCount < 220` threshold so the two agree on the same boundary. */
export const WALL_MAX_NODES = 220;

export type WallProbe = { text: string; nodes: number };

/** Capture-side wall verdict: the page is a bot/auth wall worth aborting on iff it
 *  is BOTH small (few nodes) AND carries wall text — identical to the gate's rule.
 *  A large page that merely mentions "captcha" in body copy is NOT a wall. */
export function isBotWall(probe: WallProbe | null | undefined): boolean {
  if (!probe) return false;
  return probe.nodes < WALL_MAX_NODES && isWallText(probe.text);
}

export type NavFailureClass = "retryable" | "wall" | "terminal";

/** Classify a navigation/session failure by its error text.
 *
 *  - "wall"      → a bot/auth interstitial; a retry with a fresh context won't help
 *                  and the caller should surface it as a pollution-style abort.
 *  - "retryable" → the browser/page/context died, a transient socket/timeout/reset;
 *                  ONE fresh-context retry is worthwhile.
 *  - "terminal"  → a hard failure a retry cannot change (DNS, cert, refused, unknown).
 *
 *  Ordering matters: a wall signature wins over a transient one (a wall served over
 *  a reset connection is still a wall). */
export function classifyNavFailure(error: unknown): NavFailureClass {
  const msg = String((error as { message?: string })?.message ?? error ?? "");
  if (WALL_RE.test(msg)) return "wall";
  // Session death / crash / transient network — a fresh context can recover these.
  if (
    /Target (page, context or browser|closed)|context or browser has been closed|page(?:,)? .*has been closed|browser has been closed|page closed|has crashed|Navigation .*interrupted|net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|ABORTED|EMPTY_RESPONSE|NETWORK_CHANGED|SOCKET_NOT_CONNECTED)|Timeout .*exceeded|Navigation timeout/i.test(
      msg,
    )
  ) {
    return "retryable";
  }
  return "terminal";
}

/** Whether a classified failure earns the single fresh-context retry. */
export function isRetryableNavFailure(error: unknown): boolean {
  return classifyNavFailure(error) === "retryable";
}
