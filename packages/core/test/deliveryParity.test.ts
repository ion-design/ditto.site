import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { runClone, exportApp } from "clone-static";
import { collectDeliveryFileMap } from "../src/collectFileMap.js";
import { serveDir, FIXTURES_DIR, hasChromium } from "@cloner/test-utils";

/** Walk a dir into { posixRelPath: sha256 }. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join("/")] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function mapHashes(map: Record<string, { sha256: string }>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.sha256]));
}

// Parity contract: a service-collected delivery is byte-identical to a CLI --out
// export of the same run dir (both go through the shared exportApp pass), and the
// run dir's generated/app stays RAW for the asyncVerify re-read.
describe("delivery parity (service file map === CLI export)", () => {
  it("hermetic: synthetic run dir with extracted-component plumbing", () => {
    const root = mkdtempSync(join(tmpdir(), "parity-"));
    try {
      const app = join(root, "run", "generated", "app");
      mkdirSync(join(app, "src", "app", "components"), { recursive: true });
      writeFileSync(join(app, "package.json"), '{"name":"x"}\n');
      writeFileSync(join(app, "src", "app", "_cids.ts"), `// c\n\nexport const Card_cids: string[][] = [\n    ["n1", "n2"]\n];\n`);
      writeFileSync(join(app, "src", "app", "ditto.css"), `[data-cid="n1"] { color: red; }\n`);
      writeFileSync(join(app, "src", "app", "components", "Card.tsx"), `export default function Card({ d, cids }: { d: CardData; cids: string[] }) {\n  return <div data-cid={cids[0]}><span data-cid={cids[1]}>{d.t}</span></div>;\n}\n`);
      writeFileSync(join(app, "src", "app", "page.tsx"), `import Card from "./components/Card";\nimport { Card_cids } from "./_cids";\n\nexport default function Page() {\n  return <main data-cid="s1">{[{ t: "a" }].map((d, i) => <Card key={i} d={d} cids={Card_cids[i]} />)}</main>;\n}\n`);

      const cliOut = join(root, "cli-export", "app");
      exportApp(app, cliOut);
      const files = collectDeliveryFileMap(join(root, "run"));

      assert.deepEqual(mapHashes(files), hashTree(cliOut), "service map is byte-identical to the CLI export");

      // The delivery is actually cleaned…
      assert.equal(files["src/app/_cids.ts"], undefined, "_cids.ts not shipped");
      assert.ok(files["src/app/ditto-meta.ts"], "ditto-meta.ts shipped (anchored component)");
      for (const [path, f] of Object.entries(files)) {
        assert.ok(!(f.content ?? "").includes("data-cid"), `${path}: no raw probe attrs in delivery`);
      }
      // …while generated/app stays raw for the (async) verify re-read.
      assert.ok(readFileSync(join(app, "src", "app", "page.tsx"), "utf8").includes(`data-cid="s1"`), "generated/app untouched");
      assert.ok(readFileSync(join(app, "src", "app", "_cids.ts"), "utf8").includes("Card_cids"), "generated _cids.ts untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("real clone run (served fixture)", { skip: hasChromium() ? false : "no Chromium installed" }, () => {
    let server: { url: string; close: () => Promise<void> };
    before(async () => {
      server = await serveDir(FIXTURES_DIR);
    });
    after(async () => {
      await server.close();
    });

    it("CLI export and service collection of one run dir are byte-identical", async () => {
      const base = mkdtempSync(join(tmpdir(), "parity-run-"));
      try {
        const res = await runClone({
          url: server.url + "/components.html",
          runsDir: base,
          interactions: false,
          components: true,
          motion: false,
        });

        const cliOut = join(base, "cli-export", "app");
        exportApp(join(res.runDir, "generated", "app"), cliOut);
        const files = collectDeliveryFileMap(res.runDir);

        assert.deepEqual(mapHashes(files), hashTree(cliOut), "byte-identical file sets");

        // Sanity on the cleaned delivery itself.
        assert.ok(files["src/app/page.tsx"], "page shipped");
        assert.equal(files["src/app/_cids.ts"], undefined, "_cids.ts not shipped");
        for (const [path, f] of Object.entries(files)) {
          if (f.kind !== "text" || path.startsWith("public/")) continue;
          assert.ok(!(f.content ?? "").includes(" data-cid="), `${path}: no raw probe attrs in delivery`);
        }
        // Run dir stays raw (asyncVerify contract).
        const rawPage = readFileSync(join(res.runDir, "generated", "app", "src", "app", "page.tsx"), "utf8");
        const rawSections = readdirSync(join(res.runDir, "generated", "app", "src", "app"), { recursive: true }) as string[];
        const anyRaw = [rawPage, ...rawSections
          .filter((f) => f.endsWith(".tsx"))
          .map((f) => readFileSync(join(res.runDir, "generated", "app", "src", "app", f), "utf8"))]
          .some((t) => t.includes("data-cid"));
        assert.ok(anyRaw, "generated/app still carries data-cid probes for verification");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
