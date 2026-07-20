/** Pure capture-failure classifiers shared by browser capture and validation. */

/** Broad text fingerprints retained for navigation-error classification and the
 * `wallTextDetected` diagnostic. The actual page verdict is made by
 * `diagnoseBotWall`, which combines bounded text with structural context. */
export const WALL_RE =
  /blocked by egress|access denied|access to this page has been denied|are you a (human|robot)|verify you are human|your connection needs to be verified|incorrect device time|performing security verification|enable javascript(?: and cookies)? to|please enable javascript|checking your browser|just a moment|attention required|request blocked|why have i been blocked|captcha|cf-browser-verification|ddos protection by/i;

export function isWallText(text: string): boolean {
  return WALL_RE.test(text);
}

/** Small-page threshold used only for text-led verdicts. Strong structural
 * challenge markers do not depend on this threshold. */
export const WALL_MAX_NODES = 220;

export type WallProbe = {
  title?: string;
  bodyText?: string;
  finalUrl?: string;
  nodeCount?: number;
  identifiers?: string[];
  resourceUrls?: string[];
  responseStatus?: number | null;
  /** Compatibility aliases for older callers. */
  text?: string;
  nodes?: number;
};

export type WallProvider = "cloudflare" | "unknown";

export type WallDiagnosis = {
  isWall: boolean;
  provider: WallProvider;
  matchedSignals: string[];
  title: string;
  finalUrl: string;
  nodeCount: number;
  responseStatus?: number;
};

type TextSignal = { code: string; re: RegExp; highConfidence?: boolean };

const BODY_SIGNALS: TextSignal[] = [
  { code: "text.connection-verification", re: /your connection needs to be verified/i, highConfidence: true },
  { code: "text.incorrect-device-time", re: /incorrect device time/i, highConfidence: true },
  { code: "text.security-verification", re: /performing security verification/i, highConfidence: true },
  { code: "text.checking-browser", re: /checking your browser/i, highConfidence: true },
  { code: "text.verify-human", re: /(?:verify you are human|are you a (?:human|robot))/i, highConfidence: true },
  { code: "text.enable-js-cookies", re: /(?:please )?enable javascript(?: and cookies)? to (?:continue|proceed)/i, highConfidence: true },
  { code: "text.access-denied", re: /(?:access denied|access to this page has been denied|blocked by egress)/i, highConfidence: true },
  { code: "text.request-blocked", re: /(?:request blocked|why have i been blocked)/i, highConfidence: true },
  { code: "text.ddos-protection", re: /ddos protection by/i, highConfidence: true },
  { code: "text.just-a-moment", re: /just a moment/i, highConfidence: true },
  { code: "text.captcha", re: /captcha/i },
];

const CHALLENGE_TITLE_RE =
  /just a moment|attention required|checking your browser|security verification|verify you are human|access denied/i;

function bounded(value: string | undefined, max: number): string {
  return (value ?? "").slice(0, max);
}

/** Diagnose a browser/document probe without retaining raw HTML. Decision rules:
 * one strong structural marker; a challenge title plus supporting wall text; or
 * high-confidence/multiple wall text signals on a small document. */
export function diagnoseBotWall(probe: WallProbe | null | undefined): WallDiagnosis {
  const title = bounded(probe?.title, 500);
  const bodyText = bounded(probe?.bodyText ?? probe?.text, 20_000);
  const finalUrl = bounded(probe?.finalUrl, 2_000);
  const nodeCount = Math.max(0, probe?.nodeCount ?? probe?.nodes ?? 0);
  const responseStatus = typeof probe?.responseStatus === "number" ? probe.responseStatus : undefined;
  const identifiers = (probe?.identifiers ?? []).slice(0, 250).map((v) => bounded(v, 500));
  const resourceUrls = (probe?.resourceUrls ?? []).slice(0, 250).map((v) => bounded(v, 2_000));

  const matchedSignals: string[] = [];
  const add = (signal: string): void => { if (!matchedSignals.includes(signal)) matchedSignals.push(signal); };
  const structuralSignals: string[] = [];
  const addStructural = (signal: string): void => { add(signal); structuralSignals.push(signal); };

  if (resourceUrls.some((v) => /\/cdn-cgi\/challenge-platform\//i.test(v))) {
    addStructural("cloudflare.challenge-platform-url");
  }
  if (identifiers.some((v) => /(?:^|[^a-z0-9])cf[-_]chl(?:[-_a-z0-9]|$)/i.test(v))) {
    addStructural("cloudflare.cf-chl-identifier");
  }
  if (identifiers.some((v) => /_cf_chl_opt/i.test(v))) {
    addStructural("cloudflare._cf_chl_opt");
  }
  if (identifiers.some((v) => /(?:^|[^a-z0-9])challenge-form(?:[^a-z0-9]|$)/i.test(v))) {
    addStructural("cloudflare.challenge-form");
  }

  const bodyMatches = BODY_SIGNALS.filter((signal) => signal.re.test(bodyText));
  for (const signal of bodyMatches) add(signal.code);
  const titleChallenge = CHALLENGE_TITLE_RE.test(title);
  if (titleChallenge) add("title.challenge");

  // Turnstile is commonly embedded in ordinary forms. It becomes a strong marker
  // only when the surrounding document also looks like a challenge.
  const hasTurnstile = [...identifiers, ...resourceUrls].some((v) => /turnstile/i.test(v));
  if (hasTurnstile && (titleChallenge || bodyMatches.some((s) => s.highConfidence) || structuralSignals.length > 0)) {
    addStructural("cloudflare.turnstile-challenge");
  }

  const smallDocument = nodeCount < WALL_MAX_NODES;
  const highConfidenceText = bodyMatches.some((signal) => signal.highConfidence);
  const titleWithSupport = titleChallenge && bodyMatches.length > 0;
  const multipleTextSignals = bodyMatches.length >= 2;
  const isWall = structuralSignals.length > 0 || titleWithSupport || (smallDocument && (highConfidenceText || multipleTextSignals));
  const cloudflareContext = structuralSignals.some((s) => s.startsWith("cloudflare.")) ||
    /cloudflare/i.test(`${title} ${bodyText}`);

  return {
    isWall,
    provider: isWall && cloudflareContext ? "cloudflare" : "unknown",
    matchedSignals,
    title,
    finalUrl,
    nodeCount,
    ...(responseStatus !== undefined ? { responseStatus } : {}),
  };
}

export function isBotWall(probe: WallProbe | null | undefined): boolean {
  return diagnoseBotWall(probe).isWall;
}

export const CAPTURE_REJECTED_CODE = "ANTI_BOT_CHALLENGE" as const;

/** Typed rejection propagated by the normal clone failure path. */
export class CaptureRejectedError extends Error {
  readonly code = CAPTURE_REJECTED_CODE;
  constructor(readonly diagnosis: WallDiagnosis) {
    const provider = diagnosis.provider === "unknown" ? "anti-bot" : diagnosis.provider;
    const location = diagnosis.finalUrl || "the requested page";
    const signals = diagnosis.matchedSignals.slice(0, 6).join(", ") || "challenge signals";
    super(`[${CAPTURE_REJECTED_CODE}] ${provider} challenge detected at ${location} (${diagnosis.nodeCount} nodes; ${signals})`);
    this.name = "CaptureRejectedError";
  }
}

export function isCaptureRejectedError(error: unknown): error is CaptureRejectedError {
  return error instanceof CaptureRejectedError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === CAPTURE_REJECTED_CODE);
}

export type NavFailureClass = "retryable" | "wall" | "terminal";

export function classifyNavFailure(error: unknown): NavFailureClass {
  const msg = String((error as { message?: string })?.message ?? error ?? "");
  if (WALL_RE.test(msg)) return "wall";
  if (
    /Target (page, context or browser|closed)|context or browser has been closed|page(?:,)? .*has been closed|browser has been closed|page closed|has crashed|Navigation .*interrupted|net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|ABORTED|EMPTY_RESPONSE|NETWORK_CHANGED|SOCKET_NOT_CONNECTED)|Timeout .*exceeded|Navigation timeout/i.test(
      msg,
    )
  ) {
    return "retryable";
  }
  return "terminal";
}

export function isRetryableNavFailure(error: unknown): boolean {
  return classifyNavFailure(error) === "retryable";
}
