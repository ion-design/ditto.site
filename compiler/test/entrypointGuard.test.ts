import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Entry modules gate their CLI `main()` on "was I invoked directly?". The
// tempting spelling is `import.meta.url === \`file://${process.argv[1]}\``,
// which silently breaks on Windows: argv[1] is `I:\a\b.ts`, so the comparison
// builds `file://I:\a\b.ts` and never matches the real `file:///I:/a/b.ts`.
// The failure is invisible — main() just never runs and the CLI exits 0 having
// done nothing. pathToFileURL() converts correctly on every platform.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BROKEN_GUARD = "`file://${process.argv[1]}`";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("entry-module guard", () => {
  it("builds a file URL that matches import.meta.url on this platform", () => {
    // The property every guard relies on, asserted against the real runtime.
    assert.equal(pathToFileURL(fileURLToPath(import.meta.url)).href, import.meta.url);
  });

  it("never string-concatenates `file://` with process.argv[1]", () => {
    const offenders = tsFiles(SRC).filter((f) => readFileSync(f, "utf8").includes(BROKEN_GUARD));
    assert.deepEqual(
      offenders.map((f) => f.slice(SRC.length + 1).split("\\").join("/")),
      [],
      "use pathToFileURL(process.argv[1]).href — `file://` + argv[1] never matches on Windows",
    );
  });
});
