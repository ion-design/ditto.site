---
name: clone-staging
description: The four-stage taxonomy for the clone pipeline (Foundation, CSS & Static Interactivity, JS Animation, WebGL/3D), with gate thresholds. In staged-mode runs, gates are hard — sections must pass each stage before progressing. In default-mode runs, the staging is descriptive: it tells the generate agent which features go in early vs late and what's deferrable. Load this before starting any cloning work — the orchestrator, generate, and validate agents all reference these definitions.
user-invocable: false
---

# Clone Staging

The clone pipeline organizes work into four ordered stages by capability. The same taxonomy serves two roles depending on orchestrator mode:

- **Staged-mode (`--staged`):** gates are hard. A section never enters stage N until stage N-1 has passed for that section. Prevents burning tokens on WebGL translation when the layout is still broken. Used for sites where surgical iteration matters.
- **Default-mode:** stages are descriptive guidance for the generate agent — what goes in foundation, what's deferred to animation, what's webgl-only. The orchestrator does NOT enforce gates between stages; it generates everything in parallel batches per section, then iterates on visible failures. Used for marketing/landing pages where the manifest signals are usually enough to carry fidelity through one generation pass.

Either way, the stage classifications below are the source of truth for what work belongs where.

## Stage 0 — Capture (always, once)

Not a generation stage. The capture agent runs once and produces the bundle under `<workspace>/capture/`. Generation only begins after capture is complete and the manifest is written.

## Stage 1 — Foundation

**Scope:**

- Design tokens in `tailwind.config.ts` + `globals.css` (colors, typography, spacing, shadows, radii, breakpoints)
- Asset pipeline: all images, videos, fonts, SVGs, lottie JSONs downloaded to `/public/assets/cloned/`
- Font loading via `next/font/local` (self-hosted `@font-face`)
- Layout primitives: `Container`, `Section`, base typography in `globals.css`
- Static page structure — DOM skeleton per section, no interactivity

**Gate:**

- Per-section diff at 1280px viewport with `prefers-reduced-motion` forced: `diff_pct < 5%`
- All viewports (375 / 768 / 1280 / 1920) render without cumulative layout shift
- No 404s in the network log for local assets

## Stage 2 — CSS & Static Interactivity

**Scope:**

- Gradients, filters, `backdrop-filter`, masks, clip-paths
- SVGs inlined or imported as components
- CSS animations: `@keyframes`, `transition`
- Hover, focus, focus-visible states
- `prefers-color-scheme: dark` styles if detected in capture

**Gate:**

- Per-section diff at rest: `diff_pct < 3%`
- Hover/focus state screenshots match the captured variants (delta `< 4%`)

## Stage 3 — JS Animation (only if Stage 2 passes)

**Scope:**

- Scroll-linked animations — Framer Motion `useScroll` / `useTransform` if simple, keep GSAP ScrollTrigger if timeline is complex
- Framer Motion variants for entrance / exit / `whileInView`
- Lottie animations via `lottie-react`
- IntersectionObserver-driven reveals → Framer `whileInView`

**Gate:**

- Per-section diff averaged across 5 sampled scroll positions (0%, 25%, 50%, 75%, 100%): `diff_pct < 8%`

## Stage 4 — WebGL / 3D (only if Stage 3 passes)

**Scope:**

- Three.js scenes reconstructed from the captured scene graph via `@react-three/fiber`
- Custom shaders reinstated from extracted GLSL
- Custom `<canvas>` 2D animation if detected

**Gate:**

- Best-effort. `diff_pct < 15%` on sampled frames is a pass.
- Two reconstruction attempts; if both fail, fall back to the captured MP4 embedded as `<video autoplay loop muted playsinline>` with matching dimensions. Fallback is a valid pass — flag in report.

## Tie-breakers

**A section straddles stages.** Classify by the _highest_ stage required for any element in it.

Example: a hero section is mostly static CSS but has one Lottie icon → `max_stage_required: 3`. The generate agent still builds the static part in Stage 1, adds CSS flourishes in Stage 2, and only wires up the Lottie in Stage 3. The Stage 1 gate is applied with the Lottie slot rendered as a placeholder of matching dimensions.

**Placeholder rule during earlier stages.** For elements whose implementation is deferred to a later stage, render a positioned placeholder `<div style={{ width, height }}>` so layout diffs at the earlier-stage gate are not polluted. Replace in the later stage.

**Conservative staging.** When in doubt about whether a section needs Stage 3 (e.g. subtle fade-in), mark it Stage 2. If Stage 2 validation fails because the animation is material to layout, promote at that point. Cheap to promote upward; expensive to demote.

## Non-goals (skip, do not attempt)

When any of these is detected, do not try to clone. Replace with a sized placeholder and comment:

- DRM'd video/audio (Widevine, FairPlay, PlayReady)
- Third-party widgets: Intercom, Drift, Typeform, Calendly, HubSpot forms, chat widgets, cookie consent banners
- Authenticated or personalized content behind login
- Obfuscated WASM modules
- Real-time data feeds (stock tickers, live chat)
- Analytics pixels / tag managers (no value to clone; actively harmful)

Pattern:

```tsx
<div style={{ width: W, height: H }}>{/* CLONE: skipped third-party widget — <vendor> */}</div>
```

The captured bounding box supplies W/H so layout does not shift.

## Iteration caps

- **Staged mode:** 3 iterations per section per stage. After three failed attempts at the same section at the same stage, log to `logs/manual-review.md` with the current component code, diff images, and most recent issues list; move on. A partial clone is better than a stuck clone.
- **Default mode:** 2 targeted-fix iterations per section AFTER the initial parallel-batch generation. Same logging rule on exhaustion.

## Default-mode "advisory" gates

When the orchestrator does the visual-review pass in default mode, the gate thresholds above are useful guidance but not enforced. A section showing 12% pixel diff dominated by font-rendering or video-frame timing is fine. A section showing 12% pixel diff with a visibly missing element is not. The orchestrator's judgment call — informed by reading the screenshots — is what triggers a targeted-fix call.
