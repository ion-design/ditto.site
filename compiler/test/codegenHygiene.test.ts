import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IR, IRNode, IRChild, StyleMap, BBox } from "../src/normalize/ir.js";
import {
  CN_UTILS_MODULE,
  cnImportLine,
  componentFiles,
  generatePageTsx,
  injectLottieDep,
  PACKAGE_JSON,
  PACKAGE_JSON_TW,
  PACKAGE_JSON_VITE,
  PACKAGE_JSON_VITE_TW,
  propsList,
  type ComponentRegistry,
} from "../src/generate/app.js";
import { DITTO_WIRE_TSX, ACCORDION_TSX } from "../src/generate/interactive.js";
import { DROPDOWN_MENU_TSX } from "../src/generate/menu.js";
import { declToUtil, snapLen } from "../src/generate/tailwind.js";

const VPS = [1280];
const CANONICAL = 1280;

function computed(over: StyleMap = {}): StyleMap {
  return { display: "block", position: "static", visibility: "visible", whiteSpace: "normal", ...over };
}

function node(id: string, tag: string, cs: StyleMap, children: IRChild[] = []): IRNode {
  const computedByVp: Record<number, StyleMap> = {};
  const bboxByVp: Record<number, BBox> = {};
  const visibleByVp: Record<number, boolean> = {};
  for (const vp of VPS) {
    computedByVp[vp] = { ...cs };
    bboxByVp[vp] = { x: 0, y: 0, width: vp, height: 100 };
    visibleByVp[vp] = true;
  }
  return { id, tag, attrs: {}, visibleByVp, bboxByVp, computedByVp, children };
}

function irWith(root: IRNode): IR {
  return {
    doc: {
      sourceUrl: "https://example.test/",
      title: "Fixture",
      lang: "en",
      charset: "UTF-8",
      metaViewport: "width=device-width, initial-scale=1",
      viewports: VPS,
      sampleViewports: VPS,
      canonicalViewport: CANONICAL,
      perViewport: Object.fromEntries(VPS.map((vp) => [vp, { scrollHeight: 800, scrollWidth: vp, htmlBg: "rgb(255, 255, 255)", bodyBg: "rgb(255, 255, 255)", bodyColor: "rgb(0, 0, 0)", bodyFont: "Arial" }])),
      nodeCount: 4,
      keyframes: [],
    },
    root,
  };
}

// ---- Fix 1: emitted runtime components clean up their listeners ----
describe("runtime components abort their listeners on unmount (fix 1)", () => {
  const templates: Array<[string, string]> = [
    ["DittoWire", DITTO_WIRE_TSX],
    ["Accordion", ACCORDION_TSX],
    ["DropdownMenu", DROPDOWN_MENU_TSX],
  ];
  for (const [name, tsx] of templates) {
    it(`${name}: one AbortController, every addEventListener signalled, cleanup returns abort`, () => {
      assert.ok(tsx.includes("new AbortController()"), "creates an AbortController");
      assert.ok(tsx.includes("ac.abort()"), "effect cleanup aborts");
      // Every addEventListener must carry a listener-options object with the signal (either
      // `, { signal })` or `, { passive: true, signal })`). Count-match guarantees none is missed.
      const adds = (tsx.match(/addEventListener\(/g) ?? []).length;
      const signalled = (tsx.match(/, \{ signal \}\)/g) ?? []).length
        + (tsx.match(/, \{ passive: true, signal \}\)/g) ?? []).length;
      assert.ok(adds > 0, "has listeners");
      assert.equal(signalled, adds, "every addEventListener passes the abort signal");
      // The stale re-wire guard is gone; effects are idempotent + cleaned up instead.
      assert.ok(!tsx.includes("wired.current"), "no wired.current guard");
    });
  }

  it("DropdownMenu removes any still-open panels on unmount", () => {
    assert.ok(DROPDOWN_MENU_TSX.includes("openPanels"), "tracks open panels");
    assert.ok(DROPDOWN_MENU_TSX.includes("openPanels.splice(0)) p.remove()"), "removes panels on cleanup");
  });
});

// ---- Fix 2: cn() is a single shared module, imported (not copied per file) ----
describe("cn() is deduplicated into src/lib/utils (fix 2)", () => {
  it("exports a single cn from the shared utils module", () => {
    assert.ok(CN_UTILS_MODULE.includes("export function cn("), "utils module exports cn");
  });

  it("cnImportLine resolves to the shared module at the right depth", () => {
    assert.equal(cnImportLine(1), 'import { cn } from "../lib/utils";');
    assert.equal(cnImportLine(2), 'import { cn } from "../../lib/utils";');
  });

  it("a component module that uses cn() imports it rather than redefining it", () => {
    // componentFiles reads only funcDefs / byName / fieldTypes / dataDecls / styleDecls.
    const reg = {
      byName: new Map([["Card", { runs: 1, instances: 2, cids: ["n1"] }]]),
      funcDefs: new Map([["Card", 'function Card({ styles }: { styles: string }) {\n  return <div className={cn("p-4", styles)} />;\n}']]),
      fieldTypes: new Map(),
      dataDecls: [],
      cidDecls: [],
      styleDecls: [],
    } as unknown as ComponentRegistry;
    const files = componentFiles(reg);
    const card = files.find((f) => f.name === "Card")!.module;
    assert.ok(card.includes('import { cn } from "../../lib/utils";'), "imports shared cn");
    assert.ok(!card.includes("function cn("), "no inline cn definition");
  });
});

// ---- Fix 3: JSX whitespace is collapsed under white-space: normal ----
describe("JSX whitespace collapses under white-space:normal (fix 3)", () => {
  it("collapses captured \\n\\t indentation and multi-space runs to single spaces", () => {
    const p = node("n1", "p", computed(), [{ text: "\n\t\tSkip to content\n\t\t" }]);
    const root = node("n0", "body", computed(), [p]);
    const tsx = generatePageTsx(irWith(root), new Map(), "https://example.test/");
    assert.ok(!/\{"[^"]*\\n[^"]*"\}/.test(tsx), "no literal \\n frozen in text");
    assert.ok(!/\{"\s{2,}"\}/.test(tsx), "no multi-space whitespace literal");
    assert.ok(tsx.includes("Skip to content"), "content preserved");
  });

  it("preserves whitespace verbatim inside a <pre> (white-space: pre)", () => {
    const pre = node("n1", "pre", computed({ whiteSpace: "pre" }), [{ text: "line1\n\tline2" }]);
    const root = node("n0", "body", computed(), [pre]);
    const tsx = generatePageTsx(irWith(root), new Map(), "https://example.test/");
    assert.ok(tsx.includes("line1\\n\\tline2"), "pre keeps raw newlines/tabs");
  });
});

// ---- Fix 5: sub-pixel arbitrary values snap ----
describe("sub-pixel lengths snap (fix 5)", () => {
  it("snapLen keeps genuine fractions at 1 decimal, snaps near-integer jitter to an integer", () => {
    assert.equal(snapLen("204.797px"), "204.8px");
    assert.equal(snapLen("627.188px"), "627.2px");
    assert.equal(snapLen("100.3px"), "100.3px");
    assert.equal(snapLen("204.98px"), "205px"); // within 0.1px of an integer → snap
    assert.equal(snapLen("2.996px"), "3px"); // rem/px jitter snaps
    assert.equal(snapLen("627px"), "627px"); // already clean
  });

  it("snapLen leaves non-simple values (calc/percent/multi-token) untouched", () => {
    assert.equal(snapLen("calc(100% - 3.333px)"), "calc(100% - 3.333px)");
    assert.equal(snapLen("50.5%"), "50.5%");
    assert.equal(snapLen("0px 2.5px"), "0px 2.5px");
  });

  it("declToUtil snaps a width arbitrary value but keeps border-width exact", () => {
    assert.equal(declToUtil("width", "204.797px"), "w-[204.8px]");
    // Border width sub-pixel precision is load-bearing — left untouched.
    assert.equal(declToUtil("border-width", "0.667px"), "border-[0.667px]");
  });
});

// ---- Fix 7: every emitted runtime import is a declared dependency ----
describe("lottie-web is declared when its import is emitted (fix 7)", () => {
  it("injectLottieDep pins lottie-web into every package.json template", () => {
    for (const pkg of [PACKAGE_JSON, PACKAGE_JSON_TW, PACKAGE_JSON_VITE, PACKAGE_JSON_VITE_TW]) {
      const injected = injectLottieDep(pkg);
      const deps = JSON.parse(injected).dependencies as Record<string, string>;
      assert.equal(deps["lottie-web"], "5.12.2", "lottie-web pinned to the harness version");
    }
  });
});

// ---- FIX 5: javascript: hrefs are sanitized to an inert '#' ----
// React refuses to render a `javascript:*` href verbatim — it rewrites it to a long
// `javascript:throw new Error('React has blocked a javascript: URL…')` string that no longer matches
// the source href in the link gate. Emit an inert `#` instead (the script behaviour isn't reproduced).
describe("javascript: hrefs are emitted as an inert '#' (FIX 5)", () => {
  const hrefOf = (n: IRNode): string | undefined => {
    const p = propsList(n, new Map(), "https://example.test/").find(([k]) => k === "href");
    return p ? JSON.parse(p[1]) : undefined;
  };
  it("rewrites a javascript: href to #", () => {
    const a = node("n1", "a", computed());
    a.attrs = { href: "Javascript:{}" };
    assert.equal(hrefOf(a), "#", "a javascript: href is sanitized to #");
  });
  it("rewrites javascript:void(0) too (case-insensitive, with args)", () => {
    const a = node("n1", "a", computed());
    a.attrs = { href: "javascript:void(0)" };
    assert.equal(hrefOf(a), "#");
  });
  it("leaves a normal in-page anchor href untouched", () => {
    const a = node("n1", "a", computed());
    a.attrs = { href: "#section" };
    assert.equal(hrefOf(a), "#section", "a real fragment link is preserved");
  });
  it("leaves an ordinary external href resolved (not collapsed to #)", () => {
    const a = node("n1", "a", computed());
    a.attrs = { href: "https://example.test/products" };
    assert.equal(hrefOf(a), "https://example.test/products");
  });
});
