/** Parse a duration like "24h", "30m", "500ms", or "0" (= disabled). A bare number
 *  is milliseconds. Falls back to `defMs` on empty/invalid input. */
export function parseDuration(s: string | undefined, defMs: number): number {
  if (s === undefined || s.trim() === "") return defMs;
  const t = s.trim();
  if (t === "0") return 0;
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(t);
  if (!m) return defMs;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? "ms";
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (mult[unit] ?? 1);
}
