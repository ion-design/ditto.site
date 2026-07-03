/**
 * Human-facing success output for the `clone-static` CLI.
 *
 * The CLI streams machine-readable JSON events to stdout; this module renders the
 * copy-paste-friendly summary a person actually reads at the end, plus the optional
 * `--serve` runner that installs deps and starts the dev server for them.
 *
 * Why this exists: a bare `runs/<domain>/<timestamp>/generated/app` path pasted into a
 * terminal wraps mid-word, so `cd` fails and the follow-up `npm run dev` runs in the
 * wrong directory. The preview command here is a single quoted line that survives
 * wrapping.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";

export type DoneSummaryInput = {
  url: string;
  /** The exact generated app directory for this run. */
  appDir: string;
  framework: "next" | "vite";
  /** Stable path (a `runs/<site>/latest` symlink target) preferred as the `cd` target when present. */
  stableAppDir?: string;
};

/** Double-quote a path for a POSIX shell so spaces and wrapping don't break copy-paste. */
export function shellQuote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The success block. The preview command is one quoted line on purpose. */
export function doneSummary(input: DoneSummaryInput): string {
  const root = input.framework === "next" ? "src/app" : "src";
  const cdTarget = input.stableAppDir ?? input.appDir;
  const lines: string[] = [
    "",
    `✓ Done — cloned ${input.url}`,
    "",
    "  Preview it locally (copy-paste this one line):",
    "",
    `    cd ${shellQuote(cdTarget)} && npm install && npm run dev`,
    "",
    "  What's safe to edit — full guide in AGENTS.md inside the app:",
    `    • page copy & content  →  ${root}/content.ts`,
    `    • components           →  ${root}/components/`,
    "",
    "  Or re-run with --serve to install deps and start the dev server for you",
    "  (add --open to launch the browser too).",
  ];
  if (input.stableAppDir && input.stableAppDir !== input.appDir) {
    lines.push("");
    lines.push(`  The path above is a stable pointer to the newest clone. This exact run:`);
    lines.push(`    ${input.appDir}`);
  }
  return lines.join("\n") + "\n";
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // opening a browser is best-effort
    child.unref();
  } catch {
    /* best-effort */
  }
}

function runToCompletion(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: platform() === "win32" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code}`)),
    );
  });
}

/**
 * Run `npm install` then `npm run dev` in the generated app (foreground — `npm run dev`
 * keeps running until the user stops it). With `open`, launches the default browser at
 * the dev URL once the server prints it.
 */
export async function serveApp(appDir: string, opts: { open: boolean }): Promise<void> {
  process.stderr.write(`\n→ Installing dependencies in ${appDir}\n`);
  await runToCompletion("npm", ["install"], appDir);

  process.stderr.write(`→ Starting the dev server (Ctrl-C to stop)\n\n`);
  await new Promise<void>((resolvePromise, reject) => {
    const dev = spawn("npm", ["run", "dev"], {
      cwd: appDir,
      stdio: opts.open ? ["inherit", "pipe", "inherit"] : "inherit",
      shell: platform() === "win32",
    });
    if (opts.open && dev.stdout) {
      let opened = false;
      dev.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        if (opened) return;
        const m = String(chunk).match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\S*/i);
        if (m) {
          opened = true;
          openBrowser(m[0]);
        }
      });
    }
    dev.on("error", reject);
    dev.on("exit", (code) =>
      code === 0 || code === null ? resolvePromise() : reject(new Error(`\`npm run dev\` exited with code ${code}`)),
    );
  });
}
