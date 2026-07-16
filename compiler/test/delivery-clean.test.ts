import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { stripDeliveryDataCids } from "../src/export/deliveryClean.js";

// ---- Fixture: a miniature generated app exercising every delivery-clean rewrite ----
// data-cid string attrs (kept→data-ditto-id / removed), extracted-component
// `_cids.ts` → `ditto-meta.ts` meta anchors (incl. the anchorless component whose
// bare `data-ditto-id={}` expression was the historical RSC crash class), CSS
// `[data-cid=…]` selectors, the DittoMotion runtime query rewrite, and SVG `cid`
// props with the unused-`dittoId` prune.

const CIDS_TS = `// Per-instance node ids, kept out of content.ts so the content stays semantic.

export const LogoCard_cids: string[][] = [
    ["n1", "n2"],
    ["n3", ""]
];
export const Plain_cids: string[][] = [
    ["n7", "n8"]
];
`;

const PAGE_TSX = `import HeroSection from "./sections/HeroSection";
import LogoCard from "./components/LogoCard";
import Plain from "./components/Plain";
import DittoMotion from "./components/DittoMotion";
import { LogoCard_data, Plain_data } from "./content";
import { LogoCard_cids, Plain_cids } from "./_cids";

export default function Page() {
  return (
    <main>
      <HeroSection />
      {LogoCard_data.map((d, i) => <LogoCard key={i} d={d} cids={LogoCard_cids[i]} />)}
      {Plain_data.map((d, i) => <Plain key={i} d={d} cids={Plain_cids[i]} />)}
      <DittoMotion d={[{ "cid": "n9", "kind": "fade" }]} />
    </main>
  );
}
`;

const HERO_TSX = `import Logo from "../svgs/Logo";

export default function HeroSection() {
  return (
    <section id="hero" data-cid="s2">
      <div id="fader" data-cid="n9" />
      <Logo cid={"n5"} />
      <p data-cid="s3">Hello</p>
    </section>
  );
}
`;

const LOGO_CARD_TSX = `import type { LogoCardData } from "../content";

export default function LogoCard({ d, cids }: { d: LogoCardData; cids: string[] }) {
  return (
    <div data-cid={cids[0]}>
      <img data-cid={cids[1]} alt={d.alt} src={d.src} />
    </div>
  );
}
`;

const PLAIN_TSX = `import type { PlainData } from "../content";

export default function Plain({ d, cids }: { d: PlainData; cids: string[] }) {
  return <span data-cid={cids[0]}>{d.text}</span>;
}
`;

const DITTO_MOTION_TSX = `"use client";
type MotionSpec = { cid: string; kind: string };
const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');
export default function DittoMotion({ d }: { d: MotionSpec[] }) {
  for (const spec of d) byCid(spec.cid);
  return null;
}
`;

const SVG_LOGO_TSX = `export default function Logo({ cid }: { cid?: string }) {
  return <svg viewBox="0 0 10 10" data-cid={cid} />;
}
`;

const DITTO_CSS = `[data-cid="n1"]:hover { opacity: 0.5; }
[data-cid="s2"] { color: red; }
`;

const INDEX_HTML = `<!doctype html>
<html><body data-cid="s2"><div data-cid="zz9">x</div></body></html>
`;

function makeFixtureApp(appDir: string): void {
  mkdirSync(join(appDir, "src", "app", "components"), { recursive: true });
  mkdirSync(join(appDir, "src", "app", "sections"), { recursive: true });
  mkdirSync(join(appDir, "src", "app", "svgs"), { recursive: true });
  writeFileSync(join(appDir, "src", "app", "_cids.ts"), CIDS_TS);
  writeFileSync(join(appDir, "src", "app", "page.tsx"), PAGE_TSX);
  writeFileSync(join(appDir, "src", "app", "ditto.css"), DITTO_CSS);
  writeFileSync(join(appDir, "src", "app", "sections", "HeroSection.tsx"), HERO_TSX);
  writeFileSync(join(appDir, "src", "app", "components", "LogoCard.tsx"), LOGO_CARD_TSX);
  writeFileSync(join(appDir, "src", "app", "components", "Plain.tsx"), PLAIN_TSX);
  writeFileSync(join(appDir, "src", "app", "components", "DittoMotion.tsx"), DITTO_MOTION_TSX);
  writeFileSync(join(appDir, "src", "app", "svgs", "Logo.tsx"), SVG_LOGO_TSX);
  writeFileSync(join(appDir, "index.html"), INDEX_HTML);
}

/** Read every file under dir into a { posixRelPath: content } snapshot. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("stripDeliveryDataCids (delivery cleanup pass)", () => {
  it("golden: strips probe attrs, anchors runtime/CSS refs, converts _cids to ditto-meta", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clean-"));
    try {
      makeFixtureApp(root);
      stripDeliveryDataCids(root);
      const files = snapshot(root);

      // _cids.ts is gone; ditto-meta.ts holds only components that kept an anchor.
      assert.equal(files["src/app/_cids.ts"], undefined, "_cids.ts removed");
      assert.equal(
        files["src/app/ditto-meta.ts"],
        `// Per-instance Ditto metadata. Validation-only node ids stay in .clone/generated.
export type DittoNodeMeta = { anchor?: string };
export type DittoNodeMetaMap = Record<number, DittoNodeMeta | undefined>;

export const LogoCard_meta: DittoNodeMetaMap[] = [
    { 0: { anchor: "style-1" } },
    {  }
];
`,
      );

      // Page: import rewritten to ditto-meta and pruned to anchored components;
      // anchorless meta props dropped; DittoMotion cid → semantic anchor.
      assert.equal(
        files["src/app/page.tsx"],
        `import HeroSection from "./sections/HeroSection";
import LogoCard from "./components/LogoCard";
import Plain from "./components/Plain";
import DittoMotion from "./components/DittoMotion";
import { LogoCard_data, Plain_data } from "./content";
import { LogoCard_meta } from "./ditto-meta";

export default function Page() {
  return (
    <main>
      <HeroSection />
      {LogoCard_data.map((d, i) => <LogoCard key={i} d={d} meta={LogoCard_meta[i]} />)}
      {Plain_data.map((d, i) => <Plain key={i} d={d} />)}
      <DittoMotion d={[{ "anchor": "motion-fader", "kind": "fade" }]} />
    </main>
  );
}
`,
      );

      // Section: anchored string attrs become data-ditto-id, anchorless are removed,
      // the SVG cid prop for an anchorless probe id is dropped.
      assert.equal(
        files["src/app/sections/HeroSection.tsx"],
        `import Logo from "../svgs/Logo";

export default function HeroSection() {
  return (
    <section id="hero" data-ditto-id="style-hero">
      <div id="fader" data-ditto-id="motion-fader" />
      <Logo />
      <p>Hello</p>
    </section>
  );
}
`,
      );

      // Anchored component: cids → typed meta with optional chaining; only the
      // anchored index keeps its attr; DittoNodeMetaMap import injected.
      assert.equal(
        files["src/app/components/LogoCard.tsx"],
        `import type { DittoNodeMetaMap } from "../ditto-meta";
import type { LogoCardData } from "../content";

export default function LogoCard({ d, meta }: { d: LogoCardData; meta: DittoNodeMetaMap }) {
  return (
    <div data-ditto-id={meta[0]?.anchor}>
      <img alt={d.alt} src={d.src} />
    </div>
  );
}
`,
      );

      // Anchorless component — the data-ditto-id={} RSC crash class: every meta
      // attr AND the meta param are stripped, leaving no empty JSX expressions.
      assert.equal(
        files["src/app/components/Plain.tsx"],
        `import type { PlainData } from "../content";

export default function Plain({ d }: { d: PlainData }) {
  return <span>{d.text}</span>;
}
`,
      );
      for (const [path, content] of Object.entries(files)) {
        assert.ok(!content.includes("data-ditto-id={}"), `${path}: no empty data-ditto-id expression`);
        assert.ok(!content.includes("data-cid"), `${path}: no raw data-cid left`);
        assert.ok(!/\b_?cids\b/.test(content), `${path}: no cids identifiers left`);
      }

      // Runtime file: byCid/data-cid query rewritten to data-ditto-id anchors.
      assert.equal(
        files["src/app/components/DittoMotion.tsx"],
        `"use client";
type MotionSpec = { anchor: string; kind: string };
const byDittoId = (id: string): HTMLElement | null => document.querySelector('[data-ditto-id="' + id + '"]');
export default function DittoMotion({ d }: { d: MotionSpec[] }) {
  for (const spec of d) byDittoId(spec.anchor);
  return null;
}
`,
      );

      // SVG component: no dittoId users remain, so the prop plumbing is pruned.
      assert.equal(
        files["src/app/svgs/Logo.tsx"],
        `export default function Logo() {
  return <svg viewBox="0 0 10 10" />;
}
`,
      );

      // CSS selectors rewritten to the semantic anchors.
      assert.equal(
        files["src/app/ditto.css"],
        `[data-ditto-id="style-1"]:hover { opacity: 0.5; }
[data-ditto-id="style-hero"] { color: red; }
`,
      );

      // Root HTML: anchored attr rewritten, anchorless removed.
      assert.equal(
        files["index.html"],
        `<!doctype html>
<html><body data-ditto-id="style-hero"><div>x</div></body></html>
`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites the DittoLottie runtime path (cid specs + byCid query → semantic anchors)", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clean-lottie-"));
    try {
      mkdirSync(join(root, "src", "app", "components"), { recursive: true });
      mkdirSync(join(root, "src", "app", "sections"), { recursive: true });
      writeFileSync(join(root, "src", "app", "page.tsx"), `import HeroSection from "./sections/HeroSection";
import DittoLottie from "./components/DittoLottie";

export default function Page() {
  return (
    <main>
      <HeroSection />
      <DittoLottie d={[{ "cid": "n4", "src": "/anim.json" }]} />
    </main>
  );
}
`);
      writeFileSync(join(root, "src", "app", "sections", "HeroSection.tsx"), `export default function HeroSection() {
  return <section><div id="player" data-cid="n4" /></section>;
}
`);
      writeFileSync(join(root, "src", "app", "components", "DittoLottie.tsx"), `"use client";
type LottieSpec = { cid: string; src: string };
const byCid = (cid: string): HTMLElement | null => document.querySelector('[data-cid="' + cid + '"]');
export default function DittoLottie({ d }: { d: LottieSpec[] }) {
  for (const spec of d) byCid(spec.cid);
  return null;
}
`);

      stripDeliveryDataCids(root);
      const files = snapshot(root);

      // Spec cids become semantic lottie-* anchors; the anchored element keeps a
      // data-ditto-id so the runtime can still find it.
      assert.equal(
        files["src/app/page.tsx"],
        `import HeroSection from "./sections/HeroSection";
import DittoLottie from "./components/DittoLottie";

export default function Page() {
  return (
    <main>
      <HeroSection />
      <DittoLottie d={[{ "anchor": "lottie-player", "src": "/anim.json" }]} />
    </main>
  );
}
`,
      );
      assert.equal(
        files["src/app/sections/HeroSection.tsx"],
        `export default function HeroSection() {
  return <section><div id="player" data-ditto-id="lottie-player" /></section>;
}
`,
      );

      // Runtime file: byCid/data-cid query + cid fields rewritten to anchors.
      assert.equal(
        files["src/app/components/DittoLottie.tsx"],
        `"use client";
type LottieSpec = { anchor: string; src: string };
const byDittoId = (id: string): HTMLElement | null => document.querySelector('[data-ditto-id="' + id + '"]');
export default function DittoLottie({ d }: { d: LottieSpec[] }) {
  for (const spec of d) byDittoId(spec.anchor);
  return null;
}
`,
      );
      for (const [path, content] of Object.entries(files)) {
        assert.ok(!content.includes("data-cid"), `${path}: no raw data-cid left`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: cleaning an already-cleaned app is a byte-identical no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clean-idem-"));
    try {
      makeFixtureApp(root);
      stripDeliveryDataCids(root);
      const once = snapshot(root);
      assert.ok(existsSync(join(root, "src", "app", "ditto-meta.ts")), "precondition: kept anchors exist");

      const second = stripDeliveryDataCids(root);
      const twice = snapshot(root);
      assert.deepEqual(twice, once, "second run changes no file");
      assert.deepEqual(second, { removed: 0, kept: 0 }, "second run matches nothing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for an app without extracted components", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clean-nocomp-"));
    try {
      mkdirSync(join(root, "src", "app", "sections"), { recursive: true });
      writeFileSync(join(root, "src", "app", "sections", "HeroSection.tsx"), `export default function HeroSection() {
  return <section id="hero" data-cid="s2"><p data-cid="s3">Hello</p></section>;
}
`);
      writeFileSync(join(root, "src", "app", "ditto.css"), `[data-cid="s2"] { color: red; }\n`);

      stripDeliveryDataCids(root);
      const once = snapshot(root);
      assert.ok(once["src/app/sections/HeroSection.tsx"]!.includes(`data-ditto-id="style-hero"`));
      assert.ok(!once["src/app/sections/HeroSection.tsx"]!.includes("data-cid"));

      stripDeliveryDataCids(root);
      assert.deepEqual(snapshot(root), once, "second run changes no file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
