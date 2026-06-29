import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, runMigrations, repo, type Db } from "../src/index.js";
import { acquireTestPostgres, hasTestPostgres, type EphemeralPg } from "@cloner/test-utils";

describe("cache freshness (TTL + compilerVersion)", { skip: hasTestPostgres() ? false : "no test Postgres" }, () => {
  let pg: EphemeralPg;
  let db: Db;
  let pool: { end: () => Promise<void> };

  before(async () => {
    pg = (await acquireTestPostgres())!;
    await runMigrations(pg.url);
    const h = createDb(pg.url);
    db = h.db;
    pool = h.pool;
  });
  after(async () => {
    await pool?.end().catch(() => {});
    await pg?.stop().catch(() => {});
  });

  it("returns a hit only when not expired AND compilerVersion matches", async () => {
    const job = await repo.createJob(db, { kind: "clone", url: "https://x/", options: {}, status: "succeeded", cacheKey: "k1", compilerVersion: "0.1.0" });

    // Fresh row.
    await repo.cachePut(db, { cacheKey: "k1", jobId: job.id, url: "https://x/", optionsHash: "{}", compilerVersion: "0.1.0", expiresAt: new Date(Date.now() + 60_000) });
    assert.ok(await repo.cacheGetFresh(db, "k1", "0.1.0"), "fresh + matching version → hit");
    assert.equal(await repo.cacheGetFresh(db, "k1", "0.2.0"), undefined, "version bump → miss");

    // Expire it (upsert past expiry).
    await repo.cachePut(db, { cacheKey: "k1", jobId: job.id, url: "https://x/", optionsHash: "{}", compilerVersion: "0.1.0", expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await repo.cacheGetFresh(db, "k1", "0.1.0"), undefined, "stale → miss");
  });
});
