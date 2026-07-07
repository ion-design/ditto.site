import { serve } from "@hono/node-server";
import { createJsonLogger, errorFields, runCloneJob } from "@cloner/core";
import { createDb, createBoss, repo, type Db } from "@cloner/db";
import { artifactStoreFromEnv } from "@cloner/storage";
import { createApp } from "./app.js";
import { InMemoryStore } from "./store.js";
import { InMemoryBackend } from "./backends/inMemory.js";
import { DbBackend } from "./backends/db.js";
import type { Backend } from "./backend.js";
import { hashApiKey, type AuthConfig } from "./auth.js";
import { assertPublicUrl } from "./ssrf.js";
import { loadEnv, type ApiEnv } from "./env.js";
import { sendSignupEmail } from "./resend.js";

function buildAuth(env: ApiEnv, db?: Db): AuthConfig | undefined {
  const keyHashes = new Set(env.apiKeys.map(hashApiKey));
  // DB-backed keys (apiKeys table) are honored too when a DB is present.
  const lookup = db
    ? async (h: string): Promise<boolean> => {
        const k = await repo.getApiKeyByHash(db, h);
        return !!k && !k.revokedAt;
      }
    : undefined;
  if (keyHashes.size === 0 && !lookup) return undefined;
  return { keyHashes, lookup };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createJsonLogger("api");
  let backend: Backend;
  let db: Db | undefined;

  if (env.databaseUrl) {
    const h = createDb(env.databaseUrl);
    db = h.db;
    const boss = await createBoss(env.databaseUrl);
    const store = artifactStoreFromEnv();
    backend = new DbBackend({ db, boss, store, log });
    log("api_configured", { mode: "db+queue" });
  } else {
    const store = new InMemoryStore(env.cloneTtlMs);
    store.startSweeper();
    backend = new InMemoryBackend({ store, runJob: runCloneJob, captureCacheDir: env.captureCacheDir || undefined, log });
    log("api_configured", { mode: "in-memory", cloneTtlMs: env.cloneTtlMs });
  }

  const auth = buildAuth(env, db);
  const emailSignup =
    db && env.resendApiKey && env.signupFromEmail && env.signupVerifyUrl
      ? {
          createToken: async (input: { email: string; tokenHash: string; expiresAt: Date }) => {
            await repo.createSignupToken(db!, input);
          },
          consumeToken: async (tokenHash: string) => repo.consumeSignupToken(db!, tokenHash),
          sendVerificationEmail: async (input: { email: string; verifyUrl: string; expiresAt: Date }) => {
            await sendSignupEmail({
              apiKey: env.resendApiKey!,
              from: env.signupFromEmail!,
              to: input.email,
              verifyUrl: input.verifyUrl,
              expiresAt: input.expiresAt,
            });
          },
          verifyUrl: env.signupVerifyUrl,
          tokenTtlMs: Math.max(1, env.signupTokenTtlMinutes) * 60 * 1000,
        }
      : undefined;
  const app = createApp({
    backend,
    baseUrl: env.publicBaseUrl,
    auth,
    rateLimitPerMinute: env.rateLimitPerMinute,
    signupCorsOrigins: env.signupCorsOrigins,
    signup:
      env.signupEnabled && db
        ? {
            createApiKey: async (input) => {
              await repo.createApiKey(db!, input);
            },
            defaultRateLimit: env.defaultSignupKeyRateLimit,
            rateLimitPerHour: env.signupRateLimitPerHour,
            directEnabled: env.signupDirectEnabled,
            email: emailSignup,
          }
        : undefined,
    assertUrl: env.ssrfEnabled ? async (url) => void (await assertPublicUrl(url, { allowLoopback: env.ssrfAllowLoopback })) : undefined,
    log,
  });

  serve({ fetch: app.fetch, port: env.port }, (info) => {
    log("api_listening", {
      port: info.port,
      auth: !!auth,
      signup: env.signupEnabled && !!db,
      emailSignup: !!emailSignup,
      rateLimitPerMinute: env.rateLimitPerMinute || null,
      ssrf: env.ssrfEnabled,
    });
  });
}

main().catch((e) => {
  createJsonLogger("api")("api_start_failed", { error: errorFields(e) }, "error");
  process.exit(1);
});
