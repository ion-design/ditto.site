export type RetryDecision = {
  retry: boolean;
  reason?: string;
};

const NON_RETRYABLE_CAPTURE_FAILURES: Array<{ reason: string; re: RegExp }> = [
  { reason: "dom_walk_timeout", re: /\bcollectPage timeout(?:\s+vp\d+)?\b/i },
  { reason: "bot_wall", re: /\b(?:auth\/bot wall detected|bot wall detected|egress wall detected)\b/i },
];

function errorMessage(error: unknown): string {
  return String((error as { message?: string } | null | undefined)?.message ?? error ?? "");
}

export function classifyCloneJobRetry(error: unknown): RetryDecision {
  const message = errorMessage(error);
  for (const failure of NON_RETRYABLE_CAPTURE_FAILURES) {
    if (failure.re.test(message)) return { retry: false, reason: failure.reason };
  }
  return { retry: true };
}

