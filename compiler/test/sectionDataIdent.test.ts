import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sectionFiles, type ComponentRegistry, type SectionRegistry } from "../src/generate/app.js";
import type { SectionPlan } from "../src/generate/sectionSplit.js";

// Regression: the data-var → camelCase-prop rewrite in a section module must be
// word-boundary aware. A plain substring replace of `${v}.map(` also matched inside a
// LONGER var that shares a suffix — e.g. `Tile2_data` is a suffix of `MediaTile2_data`, so
// rewriting `Tile2_data.map(` corrupted `MediaTile2_data.map(` into `Mediatile2Data.map(`
// (lowercase 't'), which no longer matched the `MediaTile2_data` declaration/import → the
// generated app failed `next build` with `ReferenceError: Mediatile2Data is not defined`.
//
// The invariant these tests lock: every `X.map(` identifier a section emits has a matching
// declaration/import/param in the SAME module (single canonical derivation, all sites).

function emptyReg(): ComponentRegistry {
  return {
    plan: { clusters: [] } as unknown as ComponentRegistry["plan"],
    nodeByCid: new Map(),
    funcDefs: new Map(),
    skeletonToName: new Map(),
    nameCounts: new Map(),
    dataDecls: [],
    cidDecls: [],
    styleDecls: [],
    dataCounts: new Map(),
    fieldTypes: new Map(),
    styleFieldTypes: new Map(),
    byName: new Map(),
    failed: new Set(),
  };
}

/** Register a shared-skeleton extracted component `name` with one data run, and return the
 *  `{Name_data.map(...)}` call the generator emits inline (mirrors registerComponent). */
function addComponent(reg: ComponentRegistry, name: string): string {
  reg.funcDefs.set(name, `function ${name}({ d, cids, styles }: { d: ${name}Data; cids: string[]; styles: ${name}Styles }) {\n  return (\n    <div />\n  );\n}`);
  const dataVar = `${name}_data`;
  const cidsVar = `${name}_cids`;
  const stylesVar = `${name}_styles`;
  reg.dataDecls.push({ varName: dataVar, compName: name, body: `[\n    { alt: "x" }\n]` });
  reg.cidDecls.push({ varName: cidsVar, body: `[\n    ["a"]\n]` });
  reg.styleDecls.push({ varName: stylesVar, compName: name, body: `[\n    {}\n]` });
  reg.fieldTypes.set(name, [{ name: "alt", type: "string", optional: false }]);
  reg.byName.set(name, { runs: 1, instances: 1, cids: [`${name}-cid`] });
  return `{${dataVar}.map((d, i) => <${name} key={i} d={d} cids={${cidsVar}[i]} styles={${stylesVar}[i]} />)}`;
}

/** Every `<ident>.map(` in a module must resolve to a binding declared in that module —
 *  a `const <ident>`, an `import { <ident> }`, a default import, or a function param. */
function assertMapIdentsResolved(module: string): void {
  const mapIdents = [...module.matchAll(/([A-Za-z_$][\w$]*)\.map\(/g)].map((m) => m[1]!);
  for (const id of mapIdents) {
    const declared =
      new RegExp(`\\bconst\\s+${id}\\b`).test(module) ||
      new RegExp(`\\bimport\\b[^\\n]*\\b${id}\\b`).test(module) ||
      // destructured function param default: `{ ... ${id} = ... }`
      new RegExp(`[{,]\\s*${id}\\s*=`).test(module);
    assert.ok(declared, `map identifier ${id} has no matching declaration/import/param in module:\n${module}`);
  }
}

function buildHeroModule(componentNames: string[]): string {
  const reg = emptyReg();
  const calls = componentNames.map((n) => addComponent(reg, n));
  // A section body that renders each component's `.map(` call, in order.
  const jsx = `    <div>\n${calls.map((c) => `      ${c}`).join("\n")}\n    </div>`;
  const plan: SectionPlan = { roots: new Map([["hero-cid", "HeroSection"]]) };
  const sreg: SectionRegistry = { plan, modules: new Map([["HeroSection", jsx]]), order: ["HeroSection"] };
  const out = sectionFiles(sreg, reg);
  return out.files.find((f) => f.name === "HeroSection")!.module;
}

describe("section data identifier derivation (digit-suffixed multi-word names)", () => {
  it("does not corrupt MediaTile2 when a shorter Tile2 shares its suffix", () => {
    // The exact bug shape: Tile2_data is a suffix of MediaTile2_data.
    const module = buildHeroModule(["Tile", "Tile2", "MediaTile2"]);
    // The map site and the param must agree on ONE identifier for MediaTile2's data.
    assert.match(module, /mediaTile2Data\.map\(/);
    assert.doesNotMatch(module, /Mediatile2Data/); // the corrupted (lowercase-t) form must never appear
    assertMapIdentsResolved(module);
  });

  it("keeps a plain name and a Logo2-style digit name self-consistent", () => {
    const module = buildHeroModule(["Logo", "Logo2"]);
    // Logo2_data has Logo_data-ish neighbors; both map sites must stay resolvable.
    assert.match(module, /logo2Data\.map\(/);
    assert.doesNotMatch(module, /Logo2Data\.map\(/); // no PascalCase corruption of the usage
    assertMapIdentsResolved(module);
  });

  it("every map identifier resolves for a suffix-overlapping cluster", () => {
    const module = buildHeroModule(["Card", "MediaCard", "Card2", "MediaCard2"]);
    assertMapIdentsResolved(module);
    assert.doesNotMatch(module, /Mediacard/); // no lowercase-c corruption
  });
});
