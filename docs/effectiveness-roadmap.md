# Roadmap: the most effective website cloner

Ranked by leverage, each with the mechanism that makes it work. Grounded in
measured behavior of this repo (2026-07): capture dominates wall-clock (77 s on
cropin vs 1–4 s generate, 6–8 s warm build), easy-tier fidelity is already 99.9,
and the losses concentrate on JS-widget pages and heavy marketing sites.

## 1. Audit-driven repair loop (fidelity ceiling-raiser)

Today the gates *grade* a clone; nothing *repairs* it. The single biggest
effectiveness jump is closing that loop:

gate failure → structured defect (cids + property + viewport, pixel-audit
region mapped to cids via bbox) → targeted regeneration with a changed
strategy (reflow on, carousel flatten, font fallback swap, background still) →
re-validate. Iterate until gates pass or a budget is spent.

The mechanism already exists in miniature: `refineSizing` iterates
render→measure→regen for sizing, and the interaction gate already triggers a
prune-regen. Generalizing that pattern to layout/style/perceptual failures
turns every gate from a report line into a convergence step. This is what
separates a compiler that *scores* 87.9 on onni-class sites from one that
*converges* to 95+.

## 2. Pattern catalog → fix bundles (make detection actionable)

The pattern index (data/pattern-catalog.json) currently *detects*. Each entry
should carry three actionable payloads:

- **capture recipe**: e.g. swiper/slick → freeze the track at slide 0 before
  snapshotting; consent pattern → targeted dismissal selector.
- **generation fix**: carousel → static flattened track (`transform:none`
  scoped to tracks, not marquees); odometer → final value; marquee → CSS
  keyframe loop; `background-attachment: fixed` → `scroll` on mobile.
- **validation expectation**: e.g. autoplay widgets excused from motion gate.

These exact fixes recur across real clones (everlastingcomfort, ooni, cropin).
Keep the catalog frozen + pinned; add a **review queue** where cross-site
observations accumulate as *candidates* that a human (or CI job) promotes into
the catalog — learning without nondeterminism in CI.

## 3. Parallel-viewport capture (the wall-clock lever)

Capture is 90% of fresh-clone time on heavy pages because ONE page serially
resizes through 4 viewports, each paying full settle + scroll + quiescence.
Two or three browser contexts capturing viewports concurrently cut fresh
capture roughly in half on heavy sites (network is shared; CPU settle waits
overlap). Combine with:

- settle budget scaled to page weight (node count / asset count from the first
  paint) instead of fixed waits;
- pattern-hint shortcuts (no motion-library signatures → skip reveal probing;
  `simpleStatic` → skip interaction drive);
- capture-cache revalidation (HEAD/ETag check → reuse the cached capture when
  the origin is unchanged, even past TTL).

## 4. Perceptual repair for marketing sites

Where heavy sites lose points: hero video/parallax backgrounds, font metric
drift, entrance-animation freeze states. Concretely: background-video stills
(already captured) wired into generation; aspect-ratio-locked hero freezing;
font fallback metrics (`size-adjust`, `ascent-override`) when a webfont fails
to materialize; pixel-audit regions mapped back to cids so the repair loop
(item 1) knows *which* section to fix.

## 5. Product surface

- A minimal web UI (this fork has none): URL box, progress from
  `/v1/clones/:id/events` (300 ms poll), tabs for App preview / Screenshot /
  static mirror — the API routes for all three now exist.
- Events for the DB/queue backend (events table or Redis stream) so the UI
  works in production mode, not just in-memory.
- Clone-vs-witness screenshot slider (the witness screenshots are already
  frozen per viewport) — the single most convincing fidelity demo.

## 6. CI (protect the determinism you have)

No workflows exist. The determinism gates make CI cheap and reliable:
`CATALOG_ONLY_HINTS=true` typecheck + tests, plus a fixture bench over 2–3
FROZEN captures (no network) asserting gates 0–6 + byte-identical regen. Add
`assertPinnedCatalog` as an explicit CI step so catalog edits require a
deliberate lock refresh.

## 7. Scale-out for multi-page

The crawl planner already collapses collections; the gaps are shared-chrome
dedup verification across routes, per-route preview serving (the preview
route already handles nested paths), and site-level capture concurrency caps
so a 12-route site doesn't 12× the settle cost.

## Anti-goals (things that look attractive but aren't the bottleneck)

- **Precompiled codegen templates**: generate is 1–4 s; capture and build
  dominate. Template short-circuiting adds fidelity risk for ~2 s of savings.
- **Byte-level HTML diffing against the live site at validate time**: breaks
  the frozen-evidence contract and reintroduces network flakiness into gates.
- **A bigger regex pile in place of the catalog**: signatures belong in frozen
  data with a pin, not in code paths that drift per-file.
