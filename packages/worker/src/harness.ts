import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The canonical build harness shipped with the compiler (has package.json + lock). */
export function baseHarnessDir(): string {
  // packages/worker/src → ../../../compiler/.harness
  return join(HERE, "..", "..", "..", "compiler", ".harness");
}

function hasBuildDeps(dir: string): boolean {
  return existsSync(join(dir, "node_modules", ".bin", "next"))
    && existsSync(join(dir, "node_modules", ".bin", "vite"));
}

/**
 * Ensure `targetDir` is a ready-to-build app harness with deps installed — the
 * isolation seam for `verify` (each worker uses its OWN harness so concurrent
 * framework builds never collide). Reuses the base harness's deps when present
 * (fast copy), otherwise runs `npm install` from its package.json. Idempotent.
 */
export function provisionHarness(targetDir: string, baseDir = baseHarnessDir()): string {
  if (hasBuildDeps(targetDir)) return targetDir;
  mkdirSync(targetDir, { recursive: true });
  if (baseDir !== targetDir) {
    for (const f of ["package.json", "package-lock.json"]) {
      if (existsSync(join(baseDir, f))) cpSync(join(baseDir, f), join(targetDir, f));
    }
  }
  if (hasBuildDeps(baseDir) && baseDir !== targetDir) {
    cpSync(join(baseDir, "node_modules"), join(targetDir, "node_modules"), { recursive: true });
  } else if (!hasBuildDeps(targetDir)) {
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: targetDir, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) throw new Error("harness npm install failed in " + targetDir);
  }
  return targetDir;
}

/** A memoized provisioner: provisions once, then returns the same dir. */
export function makeHarnessProvider(targetDir: string): () => Promise<string> {
  let ready: string | null = null;
  let inflight: Promise<string> | null = null;
  return async () => {
    if (ready) return ready;
    if (!inflight) inflight = Promise.resolve().then(() => provisionHarness(targetDir)).then((d) => (ready = d));
    return inflight;
  };
}
