import { pgTable, text, jsonb, integer, timestamp, uuid } from "drizzle-orm/pg-core";

/** Job lifecycle row. Status mirrors the queue; `cacheKey` ties it to the cache row.
 *  `options`/`timings` are jsonb (the service's typed shapes). */
export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(), // "clone" | "clone_site"
  url: text("url").notNull(),
  options: jsonb("options").notNull().default({}),
  status: text("status").notNull().default("queued"), // queued|running|succeeded|failed|cached
  cacheKey: text("cache_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  compilerVersion: text("compiler_version"),
  timings: jsonb("timings"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** The persisted result, written once on success. `fileManifest` holds the text
 *  files inline + binary metadata (the eager file map sans bytes); binaries live in
 *  blob storage referenced by `bundleS3Key` / per-file keys in the manifest. */
export const clones = pgTable("clones", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  routeCount: integer("route_count").notNull().default(1),
  fileManifest: jsonb("file_manifest").notNull(),
  bundleS3Key: text("bundle_s3_key"),
  verify: jsonb("verify"),
  captureMeta: jsonb("capture_meta").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Freshness-bounded "recently cloned this URL+options" cache. A hit requires
 *  `now < expiresAt` and a matching compilerVersion. */
export const cache = pgTable("cache", {
  cacheKey: text("cache_key").primaryKey(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  optionsHash: text("options_hash").notNull(),
  compilerVersion: text("compiler_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** API keys (M6): only a hash is stored. `rateLimit` is requests/min (nullable = default). */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label"),
  rateLimit: integer("rate_limit"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** One-time email verification tokens for public API-key signup. */
export const signupTokens = pgTable("signup_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Clone = typeof clones.$inferSelect;
export type NewClone = typeof clones.$inferInsert;
export type CacheRow = typeof cache.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type SignupToken = typeof signupTokens.$inferSelect;
export type NewSignupToken = typeof signupTokens.$inferInsert;
