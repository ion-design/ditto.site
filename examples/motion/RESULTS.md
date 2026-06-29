# Stage 5 — motion / animation results

Stage 5 reproduces the *motion* (not just the settled frame) behind a deterministic
**motion gate**, on by default (`--no-motion`). Declarative allowlist + fixed templates;
freeze anything not confidently reproducible. The clone **replays motion on load**; the
validator cancels animations to grade the settled frame, so Gates 0–6 + perceptual are
untouched (no motion regression). The current architecture overview is in the root
`README.md`.

The motion gate's accuracy contract: **`reproduced + frozen === captured`** — every captured
animation is either reproduced-and-verified (running in the built clone) or honestly frozen
(its keyframes weren't capturable, e.g. a cross-origin sheet). Never ship broken motion.

## Fixtures (deterministic)

| fixture | motion | motion gate | gates 0–6 | score |
|---|---|---|---|---|
| `fixtures/motion.html` | finite entrance + infinite spin + pulse + card stagger (CSS `@keyframes`) | **CSS 7/7 reproduced & running** | ✅ | 100 |
| `fixtures/motion2.html` | WAAPI orbit (∞) + WAAPI fade-in + rotating word | **WAAPI 2/2, rotators 1/1** | ✅ | 99.9 |

## Motion benchmark tier (`benchmarks/motion.json`) — `npm run bench -- --tier=motion`

**6 / 6 pass gates 0–6 + Stage-2 + the motion gate, average 99.8, zero failing gates.**
Real declarative motion is reproduced where present; sites whose only motion is
canvas/finished-entrance are honestly N/A (frozen), with no regression.

| id | site | score | gates 0–6 | motion gate |
|---|---|---:|:--:|---|
| motion-001 | rauno.me | 100 | ✅ | **CSS 7/7 running** (were frozen pre-Stage-5) |
| motion-002 | sive.rs | 100 | ✅ | N/A (static) |
| motion-003 | emilkowal.ski | 100 | ✅ | N/A (entrance WAAPI finishes pre-capture) |
| motion-004 | leerob.io | 99.9 | ✅ | N/A (static) |
| motion-005 | joshwcomeau.com | 99.5 | ✅ | **CSS 9/11 + scroll-reveals 13/13** (2 CSS frozen; hero canvas out of scope) |
| motion-006 | framer.com | 99.6 | ✅ | **CSS 16/16 + WAAPI 2/2** (Framer Motion showcase) |

Four declarative families are reproduced & gate-verified: **CSS `@keyframes`, WAAPI,
rotating text, scroll-triggered reveals**. Visual evidence (timeline filmstrips + webms,
built from the existing clones with `runner/motionFilmstrip.ts`) lives in
[`evidence/`](evidence/): CSS spinner/pulse, WAAPI orbit + rotating word, scroll-reveal
cards fading in, and framer.com.

## No regression (easy tier, motion ON by default)

| site | score | gates 0–6 | motion |
|---|---|---|---|
| michaelcole.me | 100 | ✅ | N/A (static) |
| f.inc | 99.8 | ✅ | CSS 2/2 |
| arkli.io | 100 | ✅ | N/A (static) |
| gist-quiz.com | 100 | ✅ | N/A (static) |

The static set is unaffected: where there's no motion the gate is N/A (and no browser is
launched); where there is, it reproduces — and either way the cancel-before-grade step means
the base gates measure the same settled frame the static clone always did.

## Limitations (by contract)

- **Scroll-scrubbed** motion (frame = f(scrollY)) and **entrance WAAPI that finishes before
  capture** are left frozen (not observable as a stable declarative spec).
- **Canvas/WebGL** is out of scope (frozen, as before).
- Some heavy SaaS marketing sites (**linear.app**) serve a degenerate JS-shell to headless
  capture — a capture/bot-wall limit (like warbyparker in stage 2), orthogonal to motion.

Reproduce: serve `compiler/fixtures/` and `npm run clone -- http://127.0.0.1:PORT/motion.html`,
then `npx tsx src/runner/validateOne.ts <runDir>`; or `npm run bench -- --tier=motion`.
