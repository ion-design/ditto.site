import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Sensibility audit for extracted components: for a generated runDir, print each
 * promoted component with its instance count and a sample of the first instance's
 * data, FLAGGING ones that look like noise (every text field ≤ 2 chars → likely a
 * per-letter text-effect split, not a reusable unit). A dev aid for "do the extracted
 * components make sense?" — not a gate. Usage: `auditComponents <runDir>`.
 */
function main(): void {
  const runDir = process.argv[2];
  if (!runDir) { console.error("usage: auditComponents <runDir>"); process.exit(1); }
  const page = join(runDir, "generated", "app", "src", "app", "page.tsx");
  if (!existsSync(page)) { console.log("no page.tsx"); return; }
  const src = readFileSync(page, "utf8");
  const re = /const (\w+)_data = \[([\s\S]*?)\n\];/g;
  let m: RegExpExecArray | null;
  let flagged = 0;
  const rows: string[] = [];
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const instances = (body.match(/\n {4}\{/g) ?? []).length;
    const first = body.split("\n").find((l) => l.includes("{ "))?.trim() ?? "";
    // text fields = string-literal values that aren't cids (k*) or urls
    const texts = [...first.matchAll(/\b(f\d+): "([^"]*)"/g)].map((x) => x[2]!).filter((t) => !/^https?:|^\//.test(t));
    const allTiny = texts.length > 0 && texts.every((t) => t.trim().length <= 2);
    if (allTiny) flagged++;
    rows.push(`  ${allTiny ? "⚠️ " : "   "}${name}×${instances}  ${first.slice(0, 96)}`);
  }
  console.log(`${runDir.split("/").slice(-2)[0]}: ${rows.length} components${flagged ? `, ${flagged} FLAGGED` : ""}`);
  for (const r of rows) console.log(r);
}

main();
