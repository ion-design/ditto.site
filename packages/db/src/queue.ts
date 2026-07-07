import PgBoss from "pg-boss";

export const CLONE_QUEUE = "clone-jobs";
export type ClonePayload = { jobId: string };

/** Start a pg-boss instance on the same Postgres (no Redis). pg-boss manages its
 *  own schema/tables and gives us retries, heartbeats, and visibility timeouts. */
export async function createBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString });
  boss.on("error", (e) => console.error(JSON.stringify({ event: "pgboss_error", error: String(e).slice(0, 300) })));
  await boss.start();
  // pg-boss v10 requires queues to be created before send/work (idempotent).
  const anyBoss = boss as unknown as { createQueue?: (name: string) => Promise<void> };
  if (typeof anyBoss.createQueue === "function") {
    try {
      await anyBoss.createQueue(CLONE_QUEUE);
    } catch {
      /* already exists */
    }
  }
  return boss;
}

/** Enqueue a clone job. Returns the pg-boss job id (or null if deduped). */
export async function enqueueClone(boss: PgBoss, jobId: string): Promise<string | null> {
  return boss.send(CLONE_QUEUE, { jobId } satisfies ClonePayload, {
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
  });
}

/** Register the worker handler. Normalizes pg-boss v9 (single job) vs v10 (array)
 *  callback shapes so the consumer just gets a jobId.
 *
 *  `concurrency` registers that many independent pollers on the queue, so up to
 *  N jobs run at once in this process with no head-of-line blocking (each poller
 *  fetches its next job as soon as its current one finishes). */
export async function workClone(boss: PgBoss, handler: (jobId: string) => Promise<void>, concurrency = 1): Promise<string[]> {
  const pollers: string[] = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) {
    pollers.push(
      await boss.work(CLONE_QUEUE, async (job: unknown) => {
        const arr = Array.isArray(job) ? job : [job];
        for (const j of arr) {
          const data = (j as { data?: ClonePayload }).data;
          if (data?.jobId) await handler(data.jobId);
        }
      }),
    );
  }
  return pollers;
}
