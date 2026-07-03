# Optimization report — pattern index, app preview, capture speed (2026-07-03)

Branch: `fable/pattern-index-preview-speed` (4 commits on top of `f72f8e6`).
All numbers measured on this machine (M-series macOS, Node 22.22.3), single-page
clones at `viewports:[1280]`, `interactions/components/motion:false`.

## Benchmark: URL submit → styled app preview

| Site | Fresh clone (capture+generate) | next build (preview) | Fresh total | Repeat clone (cached capture) total |
| --- | --- | --- | --- | --- |
| michaelcole.me (easy) | 5.1 s | 6.7 s | **11.8 s** | **6.2 s** |
| leerob.io (easy) | 9.0 s | 6.1 s | **15.0 s** | — |
| cropin.com (Elementor, 1145 nodes, 327 files) | 77.1 s | 7.9 s | **85.0 s** | **12.2 s** |

The north-star target — clone + App-preview **< 60 s with a cached capture** —
holds with 5–10× margin, including cropin.com. Fresh easy-tier sites land at
12–15 s. Fresh cropin stays capture-bound (~77 s of live settle/scroll/asset
work); the harness `next build` is 6–8 s everywhere thanks to the preserved
webpack cache.

## Gate pass rates (post-change, easy tier sample, full validation)

3/3 sites pass gates 0–6 AND stage 2 (pollution + perceptual); average score
99.9/100. `patterns.json` is enforced byte-identical by Gate 6. The
`html_witness` / `dom_witness` diagnostics flag on all sites (including
passing ones) — pre-existing, non-blocking; see gaps below.

Tests: 51/51 across workspaces; typecheck clean; both run under
`CATALOG_ONLY_HINTS=true`.

## What shipped

1. **Pattern index** (`compiler/src/knowledge/patternIndex.ts` +
   `compiler/data/pattern-catalog.json`, sha256-pinned by
   `pattern-catalog.lock`): ~50 seeded signatures (carousel libs, marquees,
   counters, scroll-animation libs, Lottie, platform fingerprints for
   Elementor/WordPress/Webflow/Shopify/Squarespace/Framer, consent + chat
   widgets, nav toggles). One deterministic pre-order IR walk over frozen
   `srcClass`/tag/attr evidence → `generated/patterns.json` with per-pattern
   counts, sample cids, aggregate flags, and a `simpleStatic` fast-path
   signal. Verified on cropin.com: `platform_elementor` (675 nodes),
   `carousel_swiper` (73), `anim_animate_css` (55).
2. **App preview** (`packages/core/src/ensureAppPreview.ts`): builds the clone
   in the shared harness, publishes the static export to
   `generated/app/public/app-preview/` (rides the existing file map/storage),
   rewrites root-absolute `/_next/`, `/assets/`, `/static/` refs depth-aware to
   relative. Served by `GET /v1/clones/:id/app-preview[/*]`. On by default for
   single-page clones (`options.preview`, part of the cache key).
3. **Capture-cache reuse for single-page repeat clones**
   (`packages/core/src/runCloneJob.ts`): the URL-keyed capture cache now also
   feeds single-page jobs when fresh AND feature-compatible (viewport
   superset, exact interaction/motion parity, screenshots when validating).
4. **Progress events**: `GET /v1/clones/:id/events` (300 ms polling) exposes
   real phases (`goto`, `capture_reuse`, `ir_built`, `inferred`, `generated`,
   `app_build_start/done`, `clone_done`); in-memory jobs are registered before
   they run so status/events are pollable mid-clone.
5. **Capture hardening**: navigation gets a 60 s TOTAL budget with a clear
   error; auth/bot walls abort the capture right after first settle using the
   pollution gate's shared signature set (`util/wallText.ts`).
6. **Mirror rewrite fix**: delimiter-guarded URL replacement kills the
   `type="text/css"` corruption class of bugs (ooni.com) and
   prefix-of-longer-URL clipping; 5 regression tests.

## Remaining gaps (honest list)

- **Fresh cropin < 60 s**: not reachable without cutting capture fidelity —
  the 77 s is live settle/lazy-load/asset time on a heavy Elementor page. The
  cached-capture path is the product answer (12 s).
- **Precompiled codegen templates**: not built. Measured generate time is a
  small fraction of the pipeline (IR+infer+codegen ≈ 1–4 s even on cropin), so
  template short-circuiting would save little; capture and `next build`
  dominate. Revisit only if generate ever becomes the bottleneck.
- **`html_witness`/`dom_witness` (gates 2b/3b/3c)**: pre-existing diagnostic
  triangle flags on every site, passing or not. Not a regression; needs its
  own calibration pass.
- **Preview hydration edge**: RSC flight-data strings still carry absolute
  `/_next/` refs (attribute/CSS refs are rewritten). Chunks load via relative
  tags; dynamic imports at odd mount depths could 404.
- **Events for the DB/queue backend**: in-memory only; the worker path would
  need an events table or Redis stream.
- **Verify + preview double-build**: `verify:true` builds in the harness, then
  the preview builds again (~6 s warm). Could share one build.
- **Wall fast-fail live repro**: LinkedIn currently serves public profiles
  (no wall), so the abort path is exercised by unit logic + shared regex only.
