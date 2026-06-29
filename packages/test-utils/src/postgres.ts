import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export type EphemeralPg = { url: string; stop: () => Promise<void> };

/** Locate the newest installed PostgreSQL bin dir (e.g. /usr/lib/postgresql/16/bin). */
function findPgBin(): string | null {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, "initdb"))) return process.env.PG_BIN;
  const root = "/usr/lib/postgresql";
  if (!existsSync(root)) return null;
  const versions = readdirSync(root)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(b) - Number(a));
  for (const v of versions) {
    const bin = join(root, v, "bin");
    if (existsSync(join(bin, "initdb"))) return bin;
  }
  return null;
}

/** Whether we can stand up a throwaway Postgres here: root (to su to a non-root
 *  user, since postgres refuses to run as root) + the binaries present. */
export function canRunEphemeralPostgres(): boolean {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return isRoot && findPgBin() !== null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function sh(cmd: string): { ok: boolean; out: string } {
  const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/**
 * Start a throwaway PostgreSQL instance for tests (no Docker required). initdb's a
 * temp data dir, runs the server as a non-root user (`pgtest`) on a random loopback
 * port with trust auth, and returns a connection URL + a stop()/cleanup. Use only
 * after `canRunEphemeralPostgres()` returns true.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPg> {
  const pgbin = findPgBin();
  if (!pgbin) throw new Error("no postgres binaries found");
  const user = "pgtest";

  // Ensure the non-root runner exists.
  if (!sh(`id ${user}`).ok) {
    const r = sh(`useradd -m -s /bin/bash ${user}`);
    if (!sh(`id ${user}`).ok) throw new Error("could not create pgtest user: " + r.out);
  }

  const data = mkdtempSync(join(tmpdir(), "pgdata-"));
  const sock = mkdtempSync(join(tmpdir(), "pgsock-"));
  // The runner user must own the data + socket dirs.
  chmodSync(data, 0o777);
  chmodSync(sock, 0o777);
  sh(`chown -R ${user} ${data} ${sock}`);

  const init = sh(`su ${user} -c "${pgbin}/initdb -D ${data} -A trust -U postgres --no-sync"`);
  if (!init.ok) {
    rmSync(data, { recursive: true, force: true });
    rmSync(sock, { recursive: true, force: true });
    throw new Error("initdb failed: " + init.out.slice(-500));
  }

  const port = await freePort();
  const start = sh(
    `su ${user} -c "${pgbin}/pg_ctl -D ${data} -o '-p ${port} -k ${sock} -c listen_addresses=127.0.0.1' -w -l ${data}/server.log start"`,
  );
  if (!start.ok) {
    const log = sh(`cat ${data}/server.log`).out;
    rmSync(data, { recursive: true, force: true });
    rmSync(sock, { recursive: true, force: true });
    throw new Error("pg_ctl start failed: " + start.out + "\n" + log.slice(-500));
  }

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const stop = async (): Promise<void> => {
    sh(`su ${user} -c "${pgbin}/pg_ctl -D ${data} -w -m immediate stop"`);
    rmSync(data, { recursive: true, force: true });
    rmSync(sock, { recursive: true, force: true });
  };
  return { url, stop };
}
