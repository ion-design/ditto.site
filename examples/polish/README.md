# Polish backlog — landed

Four lower-risk fidelity wins from the stage reviews, each gate-verified on real
benchmark sites with no regression on the static set.

## 1. `<video>` first-frame still (no longer blank)

A poster-less `<video>` whose stream aborts at snapshot used to render empty. Capture now
materializes a representative still and points the element's `poster` at it: canvas-draw the
decoded frame where readable, else **screenshot the element** over the DevTools protocol
(composited pixels → works for cross-origin / tainted / late-decode videos canvas can't read).

- `video-descript-3panel.png` — **descript.com** hero-video region, three panels: **[1] source**
  (real site) · **[2] clone before the fix** (blank) · **[3] clone after the fix**. Panel 2 ≠ 1
  (broken); panel 3 ≈ 1 (fixed). The video is cross-origin/canvas-tainted, so it produced **0
  stills** before this change.
- `video-clay-source-vs-clone.png` — **clay.com** video region, **source left / clone right**:
  the captured still matches the source frame (the only diff is an unrelated cookie banner).
- `video-descript-captured-still.jpg` — the raw frame the fallback captured for descript.

**Consistency** — re-validated across four hero-video benchmark sites; the fallback fires only
where there's no real poster, and never regresses gates 0–6:

| site | videos | stills materialized | score | gates 0–6 |
|------|-------:|--------------------:|------:|:---------:|
| descript.com | 1 | 1 (canvas-tainted → element shot) | 99.9 | ✅ |
| clay.com | 2 | 2 | 99.6 | ✅ |
| squarespace.com | 9 | 9 | 99.1 | ✅ (perceptual-only miss — its documented dynamic-hero near-miss, now with stills not blank) |
| webflow.com | 7 | 0 (all had real posters) | 99.7 | ✅ |

## 2. `<iframe>` placeholder (no longer dropped)

Iframes were dropped as noise, collapsing the layout the embed occupied. They're now kept as a
**sized placeholder box** (captured geometry, document-loading attrs stripped → self-contained,
no remote ref). Invisible tracking/chat iframes are still pruned.

- `iframe-loom-source-vs-clone.png` — **loom.com** (source **left**, clone **right**): the
  "This is Loom" video iframe (previously dropped) is preserved as a placeholder holding the
  player's box. DOM match 100%, page-height delta 0.85%, gates 0–6 green (98.4).
- `fixture-iframe-and-headings.png` — served fixture (source **left**, clone **right**): a
  YouTube embed + a map embed both render as clean placeholders; no remote URL leaks into the
  clone.

## 3. Route cap for very large directories

A directory listing of a huge collection (11ty's **882-instance `/authors` index**) is one page
too heavy to capture/grade in budget. New opt-in `maxCollectionInstances` (CLI `--max-collection`)
leaves an oversized collection's *listing* as a CMS-handoff (links to it absolutize to origin)
while still reproducing the representative detail page.

    npx tsx src/site/cloneSite.ts https://www.11ty.dev/ --max-routes=12 --max-collection=500

now **completes** (previously intractable): **11/12 routes pass gates 0–6**, link-integrity +
site-determinism green; `/authors` is cleanly absent and the lone miss is `/speedlify` (a JS
dashboard — dynamic, out of the static contract, as before).

## 4. Inline-block multi-line heading — root-caused

The third image (`fixture-iframe-and-headings.png`) also carries three heading variants — plain,
per-word `inline-block`, and words + zero-width spacers. At system fonts all three reproduce to
**≤0.01px**, so the inline-formatting reconstruction is already exact — *not* the "deeper
inline-layout model" gap it was thought to be. The residual few-px drift on real sites is
**font-metric** wrapping that accumulates on very dense pages (linear and deel pass gates 0–6;
notion's `/product` misses gate5 by an +8% page-height accumulation — the documented dense-page
limit, unchanged by this work). Left as a known, now correctly-attributed limit.
