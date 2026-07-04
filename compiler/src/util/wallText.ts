/** Bot/egress/auth-wall text signatures, shared by the pollution gate (post-capture
 *  grading) and the capture fast-fail (abort a wall capture before burning the full
 *  multi-viewport pass). One regex so the two judgments can never drift. */
export const WALL_RE = /blocked by egress|access denied|access to this page has been denied|are you a (human|robot)|verify you are human|enable javascript to|please enable javascript|checking your browser|just a moment|attention required|request blocked|why have i been blocked|captcha|cf-browser-verification|ddos protection by/i;

export function isWallText(text: string): boolean {
  return WALL_RE.test(text);
}
