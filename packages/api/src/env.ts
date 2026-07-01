import { join } from "node:path";

/** Service configuration from the environment. */
export type ApiEnv = {
  port: number;
  /** in-memory mode only: retention before sweeping completed clones. */
  cloneTtlMs: number;
  /** when set, the API runs in async DB+queue mode; otherwise sync in-memory. */
  databaseUrl?: string;
  /** local blob root (until S3 in M4). */
  artifactsDir: string;
  /** in-memory mode: persistent entry-capture cache for the single→multi reuse path
   *  ("" disables). */
  captureCacheDir: string;
  /** absolute base URL for MCP-returned references (binary/bundle URLs). */
  publicBaseUrl?: string;
  /** accepted API keys (raw, from API_KEYS=comma,separated). Empty = open. */
  apiKeys: string[];
  /** per-minute request cap on /v1/* and /mcp (0 = unlimited). */
  rateLimitPerMinute: number;
  /** allow public API-key minting at POST /v1/signup. Requires DATABASE_URL. */
  signupEnabled: boolean;
  /** requests per hour per IP for POST /v1/signup (0 = unlimited). */
  signupRateLimitPerHour: number;
  /** per-key requests/minute stored on keys minted through signup. */
  defaultSignupKeyRateLimit: number;
  /** keep the legacy direct POST /v1/signup key minting route enabled. */
  signupDirectEnabled: boolean;
  /** Resend API key for email verification signup. */
  resendApiKey?: string;
  /** verified sender address, e.g. "Ditto <hello@ditto.site>". */
  signupFromEmail?: string;
  /** landing-page URL that receives ?token=... for verification. */
  signupVerifyUrl?: string;
  /** verification token lifetime in minutes. */
  signupTokenTtlMinutes: number;
  /** browser origins allowed to call public signup routes. */
  signupCorsOrigins: string[];
  /** SSRF guard (default on). */
  ssrfEnabled: boolean;
  /** allow loopback targets through SSRF (local dev cloning of localhost). */
  ssrfAllowLoopback: boolean;
};

export function loadEnv(): ApiEnv {
  return {
    port: parseInt(process.env.PORT ?? "8787", 10),
    cloneTtlMs: parseInt(process.env.CLONE_TTL_MS ?? String(30 * 60 * 1000), 10),
    databaseUrl: process.env.DATABASE_URL,
    artifactsDir: process.env.ARTIFACTS_DIR ?? join(process.cwd(), "local-data", "artifacts"),
    captureCacheDir: process.env.CAPTURE_CACHE_DIR ?? join(process.cwd(), "local-data", "capture-cache"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    apiKeys: (process.env.API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "0", 10),
    signupEnabled: process.env.SIGNUP_ENABLED === "true",
    signupRateLimitPerHour: parseInt(process.env.SIGNUP_RATE_LIMIT_PER_HOUR ?? "3", 10),
    defaultSignupKeyRateLimit: parseInt(process.env.DEFAULT_SIGNUP_KEY_RATE_LIMIT ?? "30", 10),
    signupDirectEnabled: process.env.SIGNUP_DIRECT_ENABLED !== "false",
    resendApiKey: process.env.RESEND_API_KEY,
    signupFromEmail: process.env.SIGNUP_FROM_EMAIL,
    signupVerifyUrl: process.env.SIGNUP_VERIFY_URL,
    signupTokenTtlMinutes: parseInt(process.env.SIGNUP_TOKEN_TTL_MINUTES ?? "30", 10),
    signupCorsOrigins: (process.env.SIGNUP_CORS_ORIGINS ?? "https://ditto.site,https://www.ditto.site").split(",").map((s) => s.trim()).filter(Boolean),
    ssrfEnabled: process.env.SSRF_DISABLE !== "true",
    ssrfAllowLoopback: process.env.SSRF_ALLOW_LOOPBACK === "true",
  };
}
