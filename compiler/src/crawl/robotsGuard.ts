import { isAllowed, parseRobotsDisallow } from "./crawl.js";

export async function assertEntryAllowedByRobots(url: string): Promise<void> {
  const entry = new URL(url);
  const origin = entry.origin;
  const pathname = entry.pathname || "/";

  let robotsText: string;
  try {
    const resp = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return;
    robotsText = await resp.text();
  } catch {
    return;
  }

  const disallow = parseRobotsDisallow(robotsText);
  if (!isAllowed(pathname, disallow)) {
    throw new Error(`robots.txt at ${origin} disallows crawling ${pathname} — this site opts out of automated access, refusing to clone it`);
  }
}
