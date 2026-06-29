---
name: validation-loop
description: How the validate agent runs the two diff channels — screenshot pixel-diff AND structural DOM diff — against captured originals, ranks issues, and feeds them back to the generate agent. Defines thresholds, tool usage, diff report format, and the 3-iteration hard cap per section per stage. Load this in the validate agent every run.
user-invocable: false
---

# Validation Loop

The validate agent closes the loop: render → screenshot + DOM dump → diff against captured originals → decide pass/fail → return a report the generate agent can act on.

## Two diff channels

Both run on every fail. Combine the signals.

### 1. Pixel diff — `screenshot-diff`

Wraps `scripts/diff.py` (pixelmatch + scipy connected components).

Inputs: `before` (captured PNG), `after` (rendered PNG), `threshold` (default 0.1).
Outputs: `diff_pct`, `diff_image_path`, `worst_regions[]`.

Prefer per-section pre-cropped captures when available:

- `capture/section-shots/<viewport>/section-<idx>.png` — if the analyze agent matched this section to a candidate index.
- Otherwise the closest scroll-step PNG from `capture/screenshots/<viewport>/step-NN.png`.

### 2. Structural diff — `dom-diff`

Wraps `scripts/dom-diff.py`. Compares two DOM JSON files produced by `__CLONE_DUMP_COMPUTED__` (the rich walker the capture script and `dump-rendered` both use). Returns concrete property-level mismatches the generate agent can fix without eyeballing pixels.

Inputs:

- `captured` — `manifest.sections[id].dom_path` from the source capture.
- `rendered` — JSON from `dump-rendered` against `localhost:3000`.
- `root_selector` — `#id` or `.class` to scope to the section. Use the manifest's `section_anchor` field; fall back to `#<section_id>`.

Outputs:

```json
{
  "matched": 76,
  "counts": { "matched": 76, "missing": 2, "extra": 1, "tag_mismatch": 0, "style": 5, "size": 3 },
  "issues": [
    "section.hero > div[1]: missing in rendered (expected <img> #data-overlay, ~620x340)",
    "section.hero > h1[0]: fontSize is 48px, should be 56px",
    "section.hero: size 1280x634, should be 1280x792 (Δ22.4%)"
  ],
  "structured_issues": [...]
}
```

The `issues` array is already ranked and human-readable. Use it verbatim in the validate report.

## Capturing the rendered clone

For pixel: see `agent-browser-shot`. For structural:

```
dumpRendered({
  url: "http://localhost:3000/",
  output: "<workspace>/rendered-dom/<section_id>-<vp>.json",
  viewport: <width>,
  scroll_y: <bbox.y - 80>,
  reduce_motion: <stage===1>
})
```

The walker captures the same property set as the source, so the comparison is apples-to-apples.

## Gate thresholds

From `clone-staging`:

| Stage | Pixel                                                            | Structural extra check                           |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1     | `diff_pct < 5%` at 1280px, reduced motion. Layout shift = 0.     | counts.missing == 0 AND counts.tag_mismatch == 0 |
| 2     | `diff_pct < 3%` at rest. Hover/focus delta < 4%.                 | counts.style + counts.size < 5                   |
| 3     | mean `diff_pct < 8%` across 5 scroll samples.                    | (animations dominate; structural less reliable)  |
| 4     | `diff_pct < 15%` on sampled frames. Fallback to MP4 also passes. | n/a                                              |

A pass requires BOTH pixel and structural to pass at Stages 1 and 2. A pixel pass with `counts.missing > 0` is a fail because the diff distributed across pixels; an early-stage section with a missing 600x400 element will sometimes squeak under a 5% pixel threshold and that is the regression we are guarding against.

## Diff report format

Pass:

```json
{
  "status": "pass",
  "section_id": "hero",
  "stage": 2,
  "viewports": {
    "375": { "diff_pct": 1.8, "structural": { "matched": 60, "missing": 0 } },
    "1280": { "diff_pct": 1.5, "structural": { "matched": 87, "missing": 0 } }
  }
}
```

Fail:

```json
{
  "status": "fail",
  "section_id": "hero",
  "stage": 2,
  "viewport": 1280,
  "diff_pct": 7.4,
  "structural": { "matched": 76, "missing": 2, "tag_mismatch": 0, "style": 5, "size": 3 },
  "worst_regions": [{ "x": 120, "y": 88, "width": 340, "height": 60 }],
  "issues": [
    "section.hero > div[1]: missing in rendered (expected <img> #data-overlay, ~620x340)",
    "section.hero > h1[0]: fontSize is 48px, should be 56px",
    "section.hero: size 1280x634, should be 1280x792 (Δ22.4%) — vh-relative; use min-h-screen"
  ],
  "structured_issues": [...],
  "diff_image_path": "<workspace>/diffs/hero-1280.png"
}
```

The `issues` array is the key payload. 3-6 items, most-impactful first. Each item is a single concrete change.

## Issue ranking

`dom-diff` already ranks: missing > tag_mismatch > size_mismatch > style_mismatch > extra. Style mismatches further weight `backgroundImage`, `fontSize`, `color`, `backgroundColor`, `fontFamily` higher than other properties.

Only override the order if pixel-diff caught something structural missed (color gradients, image content shift, blur/filter changes that don't show in computed styles).

## Special cases

### Section flagged as vh_relative

If `manifest.sections[id].vh_relative === true`, the captured `bounding_box.height` reflects a viewport-height-derived value at capture time. When the rendered clone is wider/taller than the capture viewport, structural size mismatches on the section itself are expected unless the clone uses `min-h-screen`/`h-screen`. **Report the size mismatch with the hint `"vh-relative; use min-h-screen"` so generate knows the fix shape.**

### Cumulative layout shift

A Stage 1 failure even if `diff_pct` is below threshold. Detect by comparing the rendered viewport at multiple scroll positions — if elements jump > 4px between initial paint and post-network-idle paint, fail with `issues: ["Layout shift detected: hero image reflows 120px after load"]`.

### Font swap flicker

If captured shows the web font and the clone's first paint shows fallback, `next/font/local` is mis-wired. Report — usually fix is `display: "swap"` + correct `preload`.

### Dark mode

If the manifest records dark-mode styles, diff both modes. Run with `document.documentElement.classList.add("dark")` (or the captured toggle mechanism) and diff both screenshots and DOMs.

### Hover / focus states

At Stage 2, hover interactive elements flagged in capture, wait 200ms, screenshot, diff. Structural diff isn't useful here — pixel only.

## Iteration cap

**3 iterations per section per stage.** Orchestrator-enforced. Each call is one-shot: snapshot + diff + report.

After third failure, orchestrator writes a `manual-review.md` entry with: section id, stage, final component file, final diff image, last issues list. Continue to next section.

## Do not

- Do not edit component files. Report, do not fix.
- Do not restart the dev server mid-validation — flushes state.
- Do not widen `threshold` to make a diff pass.
- Do not report "no issues found" with a failing `diff_pct` — if the gate fails, list issues. If structural matched cleanly but pixel still failed: that's a non-DOM divergence (canvas content, video frame, font rendering); say so explicitly: `["Pixel diff fails despite clean structural match — likely canvas/video/font-rendering divergence; consider re-rendering at higher DPR"]`.
