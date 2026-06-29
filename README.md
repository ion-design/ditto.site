# ditto.site

[![CI](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml/badge.svg)](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

ditto.site is a deterministic website compiler. Given a public URL, it compiles the
observed rendered site into a modern TypeScript app, defaulting to Next.js App
Router with an option for Vite React, using
browser-captured evidence: DOM, computed styles, layout boxes, CSS rules, fonts,
assets, source metadata, screenshots, interaction states, and motion specs where
they can be reproduced safely.

The compiler is not an LLM page author. The normal clone path is a pure
generation pipeline over a frozen capture, so the same capture produces
byte-stable output. The generated app uses `ditto` naming for clone-specific
runtime helpers and documentation.

## What It Produces

A generated app is a self-contained project under `generated/app/` during
validation and under `<out>/<site>/app` for delivery. The default framework is
Next.js App Router:

- `src/app/layout.tsx`: root layout, captured language, Next metadata, viewport,
  JSON-LD, and shared multi-route shell.
- `src/app/page.tsx` and route pages: JSX reconstructed from the captured render
  tree.
- `src/app/globals.css`: reset, font faces, design tokens, Tailwind setup when
  enabled.
- `src/app/ditto.css`: clone-specific CSS that still needs stylesheet emission,
  including pseudo-elements, keyframes, raw CSS fallbacks, and non-Tailwind
  fidelity rules.
- `src/app/content.ts` or `content.tsx`: semantic editable data when repeated
  regions are promoted into components or sections.
- `src/app/components/`, `src/app/sections/`, `src/app/svgs/`: generated modules
  split from repeated components, page sections, and inline SVGs.
- `src/app/ditto/`: small generated runtime helpers for recognized interactions,
  accordions, dropdown menus, and reproducible motion.
- `src/app/robots.ts`, `src/app/sitemap.ts`, `src/app/llms.txt/route.ts`, and
  sometimes `src/app/llms-full.txt/route.ts`.
- App Router file-based icons such as `src/app/favicon.ico`, `src/app/icon.png`,
  and `src/app/apple-icon.png` when the source exposes them.
- `public/assets/cloned/`: materialized images, fonts, manifest files, manifest
  icons/screenshots, and other source assets needed by the clone.
- `AGENTS.md` and `ARCHITECTURE.md`: generated documentation for the delivered
  app, derived from clone metadata.

With `--framework=vite` or API option `framework: "vite"`, the generated app is
a Vite React project. Single-page output uses `index.html`, `src/main.tsx`,
`src/page.tsx`, `src/globals.css`, and `src/ditto.css`. Multi-route Vite output
is a Vite multi-page app with one HTML entry per cloned route and route modules
under `src/routes/<routeKey>/`.

Validation builds keep internal `data-cid` attributes so gates can align source
and clone nodes exactly. The exported app strips validation-only ids and only
keeps deterministic `data-ditto-id` anchors where generated CSS or runtime
recipes still need a stable target.

## Quickstart

```bash
npm ci
npx playwright install chromium

# Single-page clone, Tailwind output by default.
npm run clone -- https://example.com/

# Explicit product choices.
npm run clone -- https://example.com/ --mode=single --styling=tailwind
npm run clone -- https://example.com/ --mode=single --styling=css
npm run clone -- https://example.com/ --mode=multi --styling=tailwind
npm run clone -- https://example.com/ --mode=multi --styling=css
npm run clone -- https://example.com/ --mode=single --framework=vite
npm run clone -- https://example.com/ --mode=multi --framework=vite

# Deliver into a clean app directory.
npm run clone -- https://example.com/ --out=./output

# Benchmark and validation helpers.
npm run bench -- --tier=easy
npm run bench -- --tier=stage2 --reuse
npm run bench-site
npm run validate-site -- runs/site-example.com/<timestamp>

# Faster multi-page runs on larger sites. Validation is opt-in.
npm run clone -- https://example.com/ --mode=multi --concurrency=5
npm run clone -- https://example.com/ --mode=multi --validate --validate-concurrency=3 --viewport-concurrency=2
npm run validate-site -- runs/site-example.com/<timestamp> --validate-concurrency=3 --viewport-concurrency=2
```

The root scripts forward into the `compiler` workspace. Running the same commands
from `compiler/` also works.

The repository is MIT-licensed open source. The npm workspaces are intentionally
marked `private` for now because the source package boundaries are available for
contributors, but the packages are not yet prepared for public npm publishing.

Multi-page generation defaults to the fast no-validation path. For production
delivery, keep first response and QA as separate phases: run single-page first,
expand to multi-page with default CLI behavior or service `verify:false`, then
run strict validation separately. Use service `asyncVerify:true` when a DB worker
should persist the clone first and attach the verify report afterward. Capture
route parallelism is controlled by `--concurrency`; validation route and viewport
parallelism are controlled by `--validate-concurrency` and
`--viewport-concurrency`.

## Architecture

```
URL
  -> capture
  -> normalize render IR
  -> infer assets, fonts, sections, recipes, SEO, metadata
  -> generate app (Next by default, Vite optional)
  -> materialize assets
  -> build and validate
  -> export delivery app
```

### 1. Capture

Capture is Playwright-based. A page is loaded once and resized through the target
viewports, normally `375`, `768`, `1280`, and `1920`, so responsive snapshots are
aligned to the same page state instead of four unrelated reloads.

The in-page walker records:

- DOM tree shape and text.
- Curated computed styles.
- Document-coordinate bounding boxes.
- Per-viewport visibility, scroll dimensions, and page backgrounds.
- Pseudo-element content and styles.
- Inline SVG markup.
- Source attributes that are safe and meaningful, including accessibility
  attributes.
- Head metadata, link tags, JSON-LD, icons, manifest links, alternates, and SEO
  discovery resources.
- CSS, fonts, images, SVGs, videos, manifests, and other linked assets.

Capture also handles common state problems before the snapshot:

- Cookie, consent, newsletter, and modal overlays are dismissed when a safe
  deterministic rule recognizes them.
- Scroll-locked and iframe-backed overlays are removed only when they match the
  blocker patterns.
- Poster-less videos get a representative still when possible.
- Lazy background images and responsive assets are backfilled from CSS, DOM, and
  manifest evidence.
- Interaction capture stamps temporary `data-cid-cap` ids in the browser,
  explores recognized controls, and records state deltas.
- Motion capture extracts declarative CSS keyframes, WAAPI effects, rotating text,
  scroll reveals, and marquee-like tracks when they can be replayed deterministically.

### 2. Normalize

The normalizer merges viewport snapshots into one render IR. Each node receives a
stable pre-order id and carries per-viewport style, box, and visibility data.
Temporary capture ids are kept only as needed for interaction and motion mapping.

The IR is intentionally close to rendered browser facts. Higher-level intent is
inferred later so fidelity gates can always fall back to measured evidence when a
semantic guess is uncertain.

### 3. Infer

Inference is deterministic and local to the capture:

- Sections are detected from rendered structure and visible hierarchy.
- Design tokens are extracted from repeated color, spacing, and type values.
- Semantic color roles are assigned where source evidence and usage make them
  stable enough.
- Primitive roles identify headings, links, buttons, images, icons, nav, badges,
  forms, and related UI pieces.
- Asset and font graphs classify linked files, download them content-addressably,
  rewrite references, and preserve fallbacks.
- Recipe inference recognizes repeated card grids, feature grids, product grids,
  logo clouds, galleries, navs, and other common section patterns.
- Interaction recipes map captured deltas to small runtime helpers rather than
  replaying arbitrary site JavaScript.
- Motion recipes emit reproducible templates for the safe declarative families
  and freeze unsupported motion honestly.
- SEO inventory records source title, description, keywords, canonical URL,
  robots/referrer/theme-color/color-scheme, Open Graph, Twitter cards, icons,
  manifest links and assets, alternates/hreflang, JSON-LD, robots/sitemap links,
  and `llms.txt` or `llms-full.txt` when discoverable.
- Code quality inventory records module organization, generated component split,
  content-model extraction, metadata, and markup hygiene.

### 4. Generate

The generator emits a Next.js App Router app by default, or a Vite React app when
`framework` is `vite`. Tailwind v4 is the default styling mode; plain CSS remains
available.

In Tailwind mode, most exact geometry, typography, display, and spacing becomes
utility classes. Values that do not belong in class names, pseudo-elements,
keyframes, and recipe/runtime selectors stay in `ditto.css`. In CSS mode, shared
semantic classes and per-rule stylesheet emission preserve the same computed
style contract.

The generator also:

- Splits clean page regions into `sections/`.
- Extracts repeated DOM skeletons into `components/`.
- Keeps editable semantic data in `content.ts`, while validation ids and
  per-instance class overrides stay in generated plumbing modules.
- Hoists inline SVGs into `svgs/` where that improves readability.
- Emits `ditto` runtime utilities only for recognized recipes that need them.
- Rewrites same-origin internal links for generated routes.
- Emits framework-appropriate metadata, JSON-LD, robots, sitemap, `llms.txt`,
  icons, web manifests, and manifest assets from the SEO inventory.
- Emits generated `AGENTS.md` and `ARCHITECTURE.md` for the delivered app.

### 5. Multi-Route Cloning

Multi-route mode starts at one entry URL, crawls same-origin links, groups routes
by deterministic URL templates, and applies a CMS/template boundary:

- Singletons are reproduced.
- Pairs are reproduced because there is not enough evidence to collapse them.
- Larger collections are represented by the listing and one representative route.
- The full instance list is recorded as a handoff boundary rather than cloning
  every CMS item.

Each selected route is captured separately. The site generator then emits one app
with shared assets, shared tokens, link rewriting, optional shared header/footer
chrome, and route-level pages. A multi-route job can reuse a prior single-page
entry capture to return the first page quickly and expand later.

### 6. Validate

Validation builds and serves the generated app, captures it with the same walker,
and grades deterministic gates:

- Build and static export success.
- Capture sanity: the source was not an empty shell, bot wall, or polluted overlay
  state.
- Asset and font materialization.
- DOM shape and valid retags.
- Computed-style fidelity.
- Layout boxes, section positions, page dimensions, and responsive behavior.
- Byte determinism from regenerating the same frozen capture.
- Perceptual screenshot similarity.
- Interaction recipe behavior for menus, tabs, accordions, carousels, modals,
  hover, and focus states that were captured.
- Motion reproduction for supported declarative families.
- Site-level link integrity and site determinism for multi-route output.
- Output quality, including componentization, naming, content extraction,
  styling organization, and metadata hygiene.

The gates are intended to be deterministic grading functions. Failures should
produce a reproducible artifact and a narrow compiler improvement, not a manual
one-off patch to an output app.

## SEO And Documentation Layer

ditto.site treats source metadata as part of the clone contract. The current
generator preserves source-provided metadata in the generated framework shell
where possible, materializes linked icons and manifest assets, preserves JSON-LD
with safe script emission, and generates or preserves `llms.txt`.

If a source exposes `llms.txt` or `llms-full.txt`, those files are preserved as
static routes. If not, the generator creates a concise `llms.txt` from captured
route titles, descriptions, and visible content summaries. The generated app also
receives root `AGENTS.md` and `ARCHITECTURE.md` files that explain the app
structure, safe edit zones, `src/app/ditto`, `content.ts`, components, sections,
SVG modules, `ditto.css`, and `ditto-meta.ts`.

SEO inventory metrics are written beside generated artifacts as `seo.json` and
`seo.md` so coverage can be inspected without changing output behavior.

## Service Layer

The hosted service wraps the compiler without changing clone semantics:

```
compiler/            # capture, IR, inference, generation, validation
packages/core/       # compiler adapter and file-map collection
packages/db/         # Drizzle schema, migrations, repository, queue wrapper
packages/storage/    # local and S3/R2 artifact storage
packages/api/        # Hono REST API and MCP server
packages/worker/     # queued clone runner and optional verify harness
packages/test-utils/ # fixture server and integration-test helpers
```

REST accepts a URL and clone options, then returns either an inline result or an
async job id depending on whether a database queue is configured. The MCP server
uses a list-then-read model: agents get job metadata and file manifests first,
then request only the files they need.

See [docs/SERVICE.md](docs/SERVICE.md) and [docs/DEPLOY.md](docs/DEPLOY.md) for
the operational API and deployment details.

## Repository Map

| Path | Purpose |
| --- | --- |
| `compiler/` | deterministic clone compiler |
| `compiler/src/capture/` | Playwright capture, walker, assets, SEO resources, interactions, motion |
| `compiler/src/normalize/` | render IR construction |
| `compiler/src/infer/` | sections, tokens, assets, fonts, recipes, primitives |
| `compiler/src/generate/` | app generation, SEO/docs layer, code quality reports |
| `compiler/src/site/` | multi-route crawl/generate/validate flow |
| `compiler/src/validate/` | fidelity, perceptual, interaction, motion, and determinism gates |
| `compiler/benchmarks/` | benchmark URL lists |
| `packages/` | REST, MCP, queue, storage, and service adapters |
| `docs/SERVICE.md` | service architecture and API reference |
| `docs/DEPLOY.md` | Railway, Neon, and R2 deployment guide |
| `examples/` | benchmark result summaries, composites, motion evidence, and small runnable outputs |

## Deferred Work

ditto.site intentionally does not attempt arbitrary JavaScript replay. It does not
recreate full third-party applications, live personalization, auth, payments,
analytics behavior, or remote iframe internals. It can preserve static scaffolding
around those regions and may emit placeholders when that is the more faithful
self-contained representation.

Video-like animation replay, scroll-scrubbed canvases, WebGL, and finished
entrance animations remain outside the deterministic contract unless a safe,
observable recipe exists. Unsupported motion is frozen rather than shipped as a
broken imitation.

## Responsible Use

Use ditto.site only where you have the right to inspect, copy, transform, and
operate on the target content. Do not use it for phishing, impersonation,
credential capture, bypassing access controls, or high-volume third-party
capture without permission.

See [docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md) for the project policy.

## Contributing

Use `npm run typecheck` and `npm test` before opening a PR. Browser tests require
Chromium; Postgres-backed tests use `TEST_DATABASE_URL` or the local compose
stack. Changes that alter compiler output should include focused fixture or
benchmark evidence.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). For questions and support expectations,
see [SUPPORT.md](SUPPORT.md).

## License

[MIT](LICENSE) © ion-design and contributors.
