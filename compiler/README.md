# ditto.site Compiler

This workspace contains the deterministic compiler used by ditto.site. It captures
a source URL, builds a render IR, infers assets/fonts/tokens/sections/recipes/SEO,
generates a Next.js App Router app by default or a Vite React app on request, and
validates the result with deterministic gates.

The full architecture overview lives in [../README.md](../README.md). This file
keeps only compiler-local commands and notes.

## Commands

```bash
cd compiler
npm install
npx playwright install chromium

npm run clone -- https://example.com/
npm run clone -- https://example.com/ --mode=multi --styling=tailwind
npm run clone -- https://example.com/ --mode=single --framework=vite
npm run clone-site -- https://example.com/
npm run validate-site -- ../runs/site-example.com/<timestamp>
npm run clone -- https://example.com/ --mode=multi --concurrency=5
npm run clone -- https://example.com/ --mode=multi --validate --validate-concurrency=3 --viewport-concurrency=2
npm run validate-site -- ../runs/site-example.com/<timestamp> --validate-concurrency=3 --viewport-concurrency=2
npm run bench -- --tier=easy
npm run bench-site
npm run quality -- ../runs/example.com/<timestamp>
npm run audit -- ../runs/example.com/<timestamp>
npm test
npm run typecheck
```

Root-level scripts forward to these commands, so `npm run clone -- <url>` works
from the repository root too.

Multi-page generation defaults to the fast no-validation path. Use `--validate`
when the clone command itself should run the full build/render/gates QA pass, or
run `validate-site` separately. `--concurrency` controls source route capture;
`--validate-concurrency` controls how many routes validation grades at once; and
`--viewport-concurrency` controls how many clone viewports each route renders at
once.

## Generated App Shape

Default Next generated apps use `src/app/ditto.css` and optional helpers under
`src/app/ditto/`. Vite generated apps use `src/ditto.css` and optional helpers
under `src/ditto/`, with multi-route pages under `src/routes/`. Validation builds
keep `data-cid` attributes for source/clone alignment; delivered apps strip those
validation ids and keep only required `data-ditto-id` anchors.

## Pattern Index (frozen catalog)

`src/knowledge/patternIndex.ts` matches known widget / platform / animation
signatures against the IR's frozen capture evidence (`srcClass`, tags, attrs)
and emits deterministic hints to `generated/patterns.json` on every
`generateAll` run (the artifact is listed in the Gate 6 determinism file set).

- **Catalog**: `data/pattern-catalog.json` — signature-indexed pattern defs
  (`classTokens`, `classPrefixes`, `tags`, `attrNames`, `idPrefixes`), each with
  a `kind` and downstream `flags` (`deferred_interactive`, `motion_lib`,
  `platform_*`, `consent_overlay`, …).
- **Pin**: `data/pattern-catalog.lock` holds the catalog's sha256. After a
  deliberate catalog edit, refresh it with
  `tsx src/knowledge/patternIndex.ts --write-lock`.
- **Strict mode**: `CATALOG_ONLY_HINTS=true` (CI default) turns a lock mismatch
  into a hard error via `assertPinnedCatalog()`. There is no learning layer in
  this fork — hints are catalog-only by construction.
- **Lookup API**: `loadPatternIndex()` compiles the catalog into O(1) maps
  (class token / tag / attr name) plus small prefix lists;
  `resolvePatternHints(ir)` performs one pre-order IR walk and returns
  `{ matches, flags, platforms, simpleStatic }`. `simpleStatic` (no interactive
  or motion-library signatures, small tree) marks pages where callers may skip
  optional capture stages.

## Determinism model

| Layer | Deterministic? | Notes |
| --- | --- | --- |
| Generation from a frozen capture (`generateAll`) | Yes | Same `source/` ⇒ byte-identical output; enforced by Gate 6 over `DETERMINISM_FILES` (incl. `patterns.json`). |
| Pattern hints | Yes | Frozen catalog (sha256-pinned) + frozen IR ⇒ identical `patterns.json`. |
| Live Playwright capture | No | Network, A/B tests, consent walls, bot detection. Bounded: navigation has a 60s total budget and auth/bot walls fail fast with a clear error. |
| Validation | Frozen | Gates re-render the built clone against captured evidence; no live URL is re-fetched. |
| App preview build (service layer) | No | `next build` embeds build ids; the preview lives at `generated/app/public/app-preview/`, outside every determinism surface. |

## Capture determinism & fast-path state recovery

- **Deterministic page env** (default on; `deterministicEnv: false` to disable):
  an init script seeds `Math.random` (mulberry32) and pins the wall-clock start
  to a fixed epoch BEFORE any page JS runs — shuffled carousels, random ids, and
  "posted N minutes ago" render identically across captures. Relative time still
  advances, so elapsed-time logic (animations, lazy-load timers) behaves.
- **Fast-path hover/focus recovery**: when Stage 4 interaction capture is OFF,
  self-targeting `:hover`/`:focus` rules are recovered from the source
  stylesheets (cross-origin sheets via their intercepted raw text), matched
  against the live DOM, and emitted as `[data-cid]:hover` rules in `ditto.css`
  (`capture.pseudoStates`). Stage 4's live-driven deltas supersede this when
  interactions are enabled.
