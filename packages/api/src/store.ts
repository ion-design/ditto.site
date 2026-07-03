import { rmSync } from "node:fs";
import type { CloneJobResult, CloneOptions } from "@cloner/core";

/** A completed (or failed) clone held in memory for the M1 sync API. The `base` is
 *  the temp dir holding the run's files (kept alive so /files/* can stream them);
 *  it is removed on eviction. M2/M4 replace this with DB rows + S3 objects. */
export type JobRecord = {
  id: string;
  status: "running" | "succeeded" | "failed";
  url: string;
  kind: "clone" | "clone_site";
  options: CloneOptions;
  createdAt: number;
  result?: CloneJobResult;
  base?: string;
  error?: string;
  /** pipeline progress events (compiler log stream + service phases), poll via /events */
  events?: Array<Record<string, unknown>>;
};

/** In-memory result store with TTL eviction. Swapped for a DB-backed store in M2. */
export class InMemoryStore {
  private jobs = new Map<string, JobRecord>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private ttlMs: number) {}

  put(rec: JobRecord): void {
    this.jobs.set(rec.id, rec);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    if (rec.base) {
      try {
        rmSync(rec.base, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return this.jobs.delete(id);
  }

  sweep(): void {
    const now = Date.now();
    for (const rec of [...this.jobs.values()]) {
      if (now - rec.createdAt > this.ttlMs) this.remove(rec.id);
    }
  }

  /** Start a periodic sweep (unref'd so it never holds the process open). */
  startSweeper(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stopSweeper(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Evict everything (used by tests / shutdown). */
  clear(): void {
    for (const id of [...this.jobs.keys()]) this.remove(id);
  }
}
