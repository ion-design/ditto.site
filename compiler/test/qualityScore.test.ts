import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inlineBlobBytes,
  filePayload,
  whitespaceLiterals,
  subpixelArbitraries,
  customPropTokens,
  probeArtifacts,
  uncleanedListeners,
  tagHistogram,
  ariaHiddenFocusables,
  duplicateHelpers,
  svgPathDuplication,
  nearDuplicateComponents,
  componentNames,
  toLetter,
  scoreApp,
  type SrcFile,
} from "../src/runner/qualityScore.js";

const srcFile = (rel: string, text: string): SrcFile => ({
  path: rel, rel, ext: rel.slice(rel.lastIndexOf(".")), text, lines: text.split("\n").length,
});

// ---------------------------------------------------------------------------
// Metric extractors
// ---------------------------------------------------------------------------

describe("inlineBlobBytes", () => {
  it("counts base64 data-URI payload bytes", () => {
    const b64 = "A".repeat(500);
    const text = `const img = "data:image/png;base64,${b64}";`;
    assert.equal(inlineBlobBytes(text), 500);
  });

  it("counts a long markup string handed in as a prop", () => {
    const html = "<div>" + "<span>x</span>".repeat(250) + "</div>";
    const text = `<Frame html={${JSON.stringify(html)}} />`;
    assert.ok(inlineBlobBytes(text) > 1000, "flags HTML-as-string blob");
  });

  it("ignores ordinary short strings", () => {
    assert.equal(inlineBlobBytes(`const s = "hello world";`), 0);
  });
});

describe("filePayload", () => {
  it("reports a giant single line", () => {
    const giant = "x".repeat(200_000);
    const p = filePayload(srcFile("a.tsx", `const a = 1;\nconst b = "${giant}";\n`));
    assert.ok(p.maxLine >= 200_000, "detects the giant line");
    assert.ok(p.bytes >= 200_000, "counts the bytes");
  });

  it("a normal formatted file has a small max line", () => {
    const p = filePayload(srcFile("a.tsx", "const a = 1;\nconst b = 2;\nexport default a;\n"));
    assert.ok(p.maxLine < 40, "small max line");
  });
});

describe("whitespaceLiterals", () => {
  it("counts {\" \"} capture-whitespace literals", () => {
    const text = `<p>Hi{" "}there{" "}world{' '}!</p>`;
    assert.equal(whitespaceLiterals(text), 3);
  });

  it("does not flag meaningful expression literals", () => {
    assert.equal(whitespaceLiterals(`<p>{name}{count}</p>`), 0);
  });
});

describe("subpixelArbitraries", () => {
  it("flags non-integer px/rem arbitraries but not whole ones", () => {
    // 713.938px (frozen) + 12.5rem (=200px, whole) → only the first counts.
    const text = `<div className="w-[713.938px] h-[12.5rem] p-[16px]" />`;
    assert.equal(subpixelArbitraries(text), 1);
  });
});

describe("customPropTokens", () => {
  it("splits opaque --clr-N / hash tokens from named ones", () => {
    const css = `:root{ --clr-7:#fff; --c12:#000; --a1b2c3:#111; --brand-primary:#f00; --space-4:1rem; }`;
    const t = customPropTokens(css);
    assert.equal(t.total, 5);
    assert.equal(t.opaque, 3, "clr-7, c12, hash a1b2c3 are opaque; brand-primary/space-4 are named");
  });
});

describe("probeArtifacts", () => {
  it("flags off-screen capture-probe scaffolding", () => {
    const text = `<span data-probe="1">m</span><i style={{clip: 'rect(0 0 0 0)'}} />`;
    assert.ok(probeArtifacts(text) >= 2);
  });
});

describe("uncleanedListeners", () => {
  it("counts addEventListener with no cleanup", () => {
    const text = `el.addEventListener("scroll", fn);\nwin.addEventListener("resize", fn);`;
    assert.equal(uncleanedListeners(text), 2);
  });

  it("does not flag when a matching removeEventListener / teardown exists", () => {
    const text = `useEffect(() => { el.addEventListener("scroll", fn); return () => el.removeEventListener("scroll", fn); });`;
    assert.equal(uncleanedListeners(text), 0);
  });
});

describe("tagHistogram", () => {
  it("counts opening element tags by name", () => {
    const h = tagHistogram(`<div><div/><span>x</span><button>b</button></div>`);
    assert.equal(h["div"], 2);
    assert.equal(h["span"], 1);
    assert.equal(h["button"], 1);
  });
});

describe("ariaHiddenFocusables", () => {
  it("flags aria-hidden on a focusable element", () => {
    const text = `<button aria-hidden="true">x</button><a aria-hidden={true} href="#">y</a>`;
    assert.equal(ariaHiddenFocusables(text), 2);
  });

  it("ignores aria-hidden on a decorative div", () => {
    assert.equal(ariaHiddenFocusables(`<div aria-hidden="true" />`), 0);
  });
});

describe("duplicateHelpers", () => {
  it("counts copy-paste helper bodies (e.g. a repeated cn())", () => {
    const body = `{ return classes.filter(Boolean).join(" ").replace(/\\s+/g, " ").trim(); }`;
    const text = `function cn(...classes) ${body}\nfunction cx(...classes) ${body}\nfunction merge(...classes) ${body}`;
    const d = duplicateHelpers(text);
    assert.equal(d.defs, 3);
    assert.equal(d.dups, 2, "two of the three are identical duplicates");
  });

  it("does not flag distinct helper bodies", () => {
    const text = `function a(x) { return x + 1111111111; }\nfunction b(x) { return x - 2222222222; }`;
    assert.equal(duplicateHelpers(text).dups, 0);
  });
});

describe("svgPathDuplication", () => {
  it("counts repeated inline <path d=...> strings", () => {
    const d = "M10 10 L20 20 L30 30 Z aaaaaaaaaaaaaaaa";
    const text = `<path d="${d}"/><path d="${d}"/><path d="M1 1 L2 2 different pathhhhhhhh"/>`;
    const r = svgPathDuplication(text);
    assert.equal(r.total, 3);
    assert.equal(r.repeats, 1);
  });
});

describe("nearDuplicateComponents", () => {
  it("counts pairs sharing a tag signature", () => {
    assert.equal(nearDuplicateComponents(["div:2,span:1", "div:2,span:1", "nav:1"]), 1);
    assert.equal(nearDuplicateComponents(["a", "a", "a"]), 2);
  });
});

describe("componentNames", () => {
  it("extracts exported + declared component symbols", () => {
    const text = `export default function HeroSection(){}\nexport function Footer(){}\nconst Navbar = () => {};`;
    const names = componentNames(text);
    assert.ok(names.includes("HeroSection"));
    assert.ok(names.includes("Footer"));
    assert.ok(names.includes("Navbar"));
  });
});

describe("toLetter", () => {
  it("maps scores to the expected grade bands", () => {
    assert.equal(toLetter(95), "A");
    assert.equal(toLetter(82), "B-");
    assert.equal(toLetter(75), "C");
    assert.equal(toLetter(67), "D+");
    assert.equal(toLetter(59), "F");
  });
});

// ---------------------------------------------------------------------------
// scoreApp — end-to-end on synthetic app trees (generic fixture content)
// ---------------------------------------------------------------------------

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qs-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

describe("scoreApp — hard cap on catastrophic payload", () => {
  it("caps a tree containing a multi-megabyte source file into D-range", () => {
    const giant = "x".repeat(1_200_000); // >1MB single file
    const root = makeTree({
      "src/app/page.tsx": `export default function Page(){ return <main><h1>Hi</h1><section><p>ok</p></section></main>; }`,
      "src/app/svgs/blob.tsx": `export const blob = "${giant}";`,
    });
    try {
      const rep = scoreApp(root);
      assert.ok(rep.caps.length > 0, "a catastrophe cap is recorded");
      assert.ok(rep.total <= 68, `grade is capped into D-range, got ${rep.total}`);
      assert.ok(["D+", "D", "D-", "F"].includes(rep.grade), `grade ${rep.grade} is D-range or below`);
      assert.ok(rep.categories.payload!.score < rep.categories.payload!.max * 0.5, "payload dimension collapses");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("scoreApp — semantics", () => {
  it("penalizes a page with no h1 vs one with a single h1", () => {
    const withH1 = makeTree({
      "src/app/page.tsx": `export default function Page(){ return <main><h1>Title</h1><section><p>a</p></section><nav><a href="#">x</a></nav></main>; }`,
    });
    const noH1 = makeTree({
      "src/app/page.tsx": `export default function Page(){ return <div><div><div><div><span>a</span></div></div></div></div>; }`,
    });
    try {
      const a = scoreApp(withH1);
      const b = scoreApp(noH1);
      assert.ok(a.categories.semantics!.score > b.categories.semantics!.score, "h1 + semantic tags score higher");
      assert.equal(b.categories.semantics!.metrics.h1, 0);
    } finally {
      rmSync(withH1, { recursive: true, force: true });
      rmSync(noH1, { recursive: true, force: true });
    }
  });
});

describe("scoreApp — decomposition", () => {
  it("rates a decomposed tree above a single-file monolith of the same markup", () => {
    const bodyTags = "<div><p>x</p><a href='#'>l</a></div>".repeat(40);
    const monolith = makeTree({
      "src/app/page.tsx": `export default function Page(){ return <main><h1>H</h1>${bodyTags}</main>; }`,
    });
    const decomposed = makeTree({
      "src/app/page.tsx": `import Hero from "./sections/hero";\nimport Feature from "./sections/feature";\nexport default function Page(){ return <main><h1>H</h1><Hero/><Feature/></main>; }`,
      "src/app/sections/hero.tsx": `export function Hero(){ return <section>${"<div><p>x</p></div>".repeat(20)}</section>; }`,
      "src/app/sections/feature.tsx": `export function Feature(){ return <section>${"<div><a href='#'>l</a></div>".repeat(20)}</section>; }`,
    });
    try {
      const m = scoreApp(monolith);
      const d = scoreApp(decomposed);
      assert.ok(d.categories.decomposition!.score > m.categories.decomposition!.score, "decomposed scores higher on decomposition");
      assert.ok(d.total > m.total, "and grades higher overall");
    } finally {
      rmSync(monolith, { recursive: true, force: true });
      rmSync(decomposed, { recursive: true, force: true });
    }
  });
});
