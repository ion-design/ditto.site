# Stage 2 — results (capture-state correctness)

**22/25 pass gates 0-6; 19/25 pass the stricter stage-2 bar** (gates 0-6 + non-degenerate capture + perceptually-close render), average 99.1.
Stage 2 = popup/video/animation pages where the captured frame must be the settled, unobstructed state. Stage-2 gates: **pollution** (degenerate/wall/blocking-modal) and **perceptual** (tier-thresholded screenshot diff).

| id | site | score | gates0-6 | stage2 | failing |
|----|------|------:|:--------:|:------:|---------|
| stage2-001 | figma.com | 99.5 | PASS | PASS |  |
| stage2-002 | duolingo.com | 99.9 | PASS | PASS |  |
| stage2-003 | monday.com | 99.7 | PASS | PASS |  |
| stage2-004 | intercom.com | 99.6 | PASS | PASS |  |
| stage2-005 | grammarly.com | 100 | PASS | PASS |  |
| stage2-006 | allbirds.com | 99.8 | PASS | PASS |  |
| stage2-007 | glossier.com | 99.2 | PASS | PASS |  |
| stage2-008 | warbyparker.com | 98.5 | PASS | FAIL | perceptual |
| stage2-009 | casper.com | 99.6 | PASS | PASS |  |
| stage2-010 | brooklinen.com | 98.6 | PASS | FAIL | perceptual |
| stage2-011 | ruggable.com | 96.9 | FAIL | FAIL | layout,perceptual |
| stage2-012 | bombas.com | 99.3 | PASS | PASS |  |
| stage2-013 | webflow.com | 99.7 | PASS | PASS |  |
| stage2-014 | squarespace.com | 99 | PASS | FAIL | perceptual |
| stage2-015 | wix.com | 93.1 | FAIL | FAIL | layout,perceptual |
| stage2-016 | descript.com | 99.8 | PASS | PASS |  |
| stage2-017 | clay.com | 99.4 | PASS | PASS |  |
| stage2-018 | runwayml.com | 99.2 | PASS | PASS |  |
| stage2-019 | framer.com | 99.6 | PASS | PASS |  |
| stage2-020 | vercel.com | 99.8 | PASS | PASS |  |
| stage2-021 | mailchimp.com | 99.6 | PASS | PASS |  |
| stage2-022 | resend.com | 99.1 | FAIL | FAIL | layout |
| stage2-023 | linear.app | 99.9 | PASS | PASS |  |
| stage2-024 | everlane.com | 99.9 | PASS | PASS |  |
| stage2-025 | posthog.com | 99.9 | PASS | PASS |  |

Documented residuals (limitations, not defects): wix (heavy-JS site-builder — custom-element carousel positioned by script we don't run); warbyparker/squarespace (dynamic/autoplay hero — perceptual-only, frame-to-frame non-deterministic).
