import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { jobs, clones, cache, apiKeys, signupTokens, type Job, type NewJob, type Clone, type NewClone, type CacheRow, type ApiKey, type SignupToken } from "./schema.js";

// ---- jobs ----

export async function createJob(db: Db, input: Omit<NewJob, "id" | "createdAt">): Promise<Job> {
  const [row] = await db.insert(jobs).values(input).returning();
  return row!;
}

export async function getJob(db: Db, id: string): Promise<Job | undefined> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

export async function markRunning(db: Db, id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "running", startedAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
    .where(eq(jobs.id, id));
}

export async function markSucceeded(db: Db, id: string, fields: { compilerVersion: string; timings: unknown }): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", finishedAt: new Date(), compilerVersion: fields.compilerVersion, timings: fields.timings })
    .where(eq(jobs.id, id));
}

export async function updateJobTimings(db: Db, id: string, timings: unknown): Promise<void> {
  await db.update(jobs).set({ timings }).where(eq(jobs.id, id));
}

export async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db.update(jobs).set({ status: "failed", finishedAt: new Date(), error: error.slice(0, 2000) }).where(eq(jobs.id, id));
}

export async function listJobs(db: Db, limit = 50): Promise<Job[]> {
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
}

export async function deleteJob(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id });
  return rows.length > 0;
}

// ---- clones ----

export async function upsertClone(db: Db, input: NewClone): Promise<void> {
  await db
    .insert(clones)
    .values(input)
    .onConflictDoUpdate({ target: clones.jobId, set: { fileManifest: input.fileManifest, verify: input.verify, captureMeta: input.captureMeta, bundleS3Key: input.bundleS3Key, routeCount: input.routeCount } });
}

export async function getClone(db: Db, jobId: string): Promise<Clone | undefined> {
  const [row] = await db.select().from(clones).where(eq(clones.jobId, jobId)).limit(1);
  return row;
}

export async function updateCloneVerify(db: Db, jobId: string, verify: unknown): Promise<void> {
  await db.update(clones).set({ verify: verify as Record<string, unknown> | null }).where(eq(clones.jobId, jobId));
}

// ---- cache ----

/** A *fresh* cache hit: same compilerVersion and not yet expired. */
export async function cacheGetFresh(db: Db, cacheKey: string, compilerVersion: string): Promise<CacheRow | undefined> {
  const [row] = await db
    .select()
    .from(cache)
    .where(and(eq(cache.cacheKey, cacheKey), eq(cache.compilerVersion, compilerVersion), gt(cache.expiresAt, new Date())))
    .limit(1);
  return row;
}

export async function cachePut(db: Db, input: { cacheKey: string; jobId: string; url: string; optionsHash: string; compilerVersion: string; expiresAt: Date }): Promise<void> {
  await db
    .insert(cache)
    .values(input)
    .onConflictDoUpdate({ target: cache.cacheKey, set: { jobId: input.jobId, expiresAt: input.expiresAt, compilerVersion: input.compilerVersion, createdAt: new Date() } });
}

// ---- api keys (M6) ----

export async function getApiKeyByHash(db: Db, keyHash: string): Promise<ApiKey | undefined> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return row;
}

export async function createApiKey(db: Db, input: { keyHash: string; label?: string; rateLimit?: number }): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values(input).returning();
  return row!;
}

// ---- signup tokens ----

export async function createSignupToken(db: Db, input: { email: string; tokenHash: string; expiresAt: Date }): Promise<SignupToken> {
  const [row] = await db.insert(signupTokens).values(input).returning();
  return row!;
}

/** Atomically consume a still-fresh signup token. Returns undefined for missing,
 * expired, or already-used tokens. */
export async function consumeSignupToken(db: Db, tokenHash: string): Promise<SignupToken | undefined> {
  const [row] = await db
    .update(signupTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(signupTokens.tokenHash, tokenHash), gt(signupTokens.expiresAt, new Date()), isNull(signupTokens.consumedAt)))
    .returning();
  return row;
}
