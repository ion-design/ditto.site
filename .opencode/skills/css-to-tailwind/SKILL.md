---
name: css-to-tailwind
description: Rules for converting resolved computed CSS from the capture into Tailwind v3 classes on Next.js components. Decides when to use arbitrary values vs extending tailwind.config.ts, how to handle gradients / shadows / filters / clamp / variable fonts / container queries, and when to bail to globals.css. Load this in every Stage 1 or Stage 2 generation run.
user-invocable: false
---

# CSS → Tailwind

The generate agent receives a DOM fragment with computed styles already resolved per node. Your job is to turn those styles into Tailwind classes on the JSX output — no cascade reasoning required.

## Core decision: utility vs arbitrary vs config vs CSS file

| Situation                                                                                      | Approach                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Value matches a default Tailwind scale step (e.g. `p-4`, `gap-8`)                              | Use the utility                                 |
| Value is used 1-2 times site-wide and does not match scale                                     | Arbitrary: `w-[347px]`                          |
| Value is used 3+ times site-wide                                                               | Extend `tailwind.config.ts`, then use the token |
| Cannot be expressed in Tailwind (complex `filter`, `@property`, `@supports`, dynamic `attr()`) | Write to `globals.css`                          |

The manifest's `design_tokens` object is already deduplicated by frequency — use it as the source of truth for what goes into `tailwind.config.ts`.

## Specific rules

### Heights and widths — use intent over resolved px

The capture's computed styles resolve `vh`/`vw`/`%`/`calc()` to literal pixel values at the capture viewport (1280×720). **Do not blindly transcribe these.** The manifest gives you better signals:

1. **`section.vh_relative === true`**: the section's height is viewport-height-derived. Map `section.vh_value` to Tailwind:
   - `vh_value` ≈ 100 → `min-h-screen` (or `h-screen` if the source had `height` not `min-height`)
   - `vh_value` between 50 and 99 → `min-h-[<vh>vh]` arbitrary, e.g. `min-h-[88vh]`
   - `vh_value` < 50 → still `min-h-[<vh>vh]` but consider whether content alone determines the height (if so, omit the height entirely and let content size it)
2. **`section.full_width === true`**: use `w-full` (or `w-screen` for true full-bleed elements that escape parent padding). Never write `w-[1280px]`.
3. **`capture/css-rules/<vp>.json`** has the source intent verbatim. When in doubt for a specific element, read the rule that matched its selector. Look for `100vh`, `100%`, `calc(...)`, `clamp(...)`, `aspect-ratio` — these are signals to NOT use the literal px value.

Heuristic for elements not in `vh_relative_elements` but suspected vh-relative: if `bounding_box.height` is close to `viewport_height * N` for `N ∈ {0.5, 0.75, 1.0}` and the element is a top-level section with no other content driving height, prefer the vh form. Cheaper to over-flag here than to leave a brittle px height.

### Colors

- Every color in `manifest.design_tokens.colors` gets promoted into `theme.extend.colors` under its semantic name.
- Reference as `bg-primary`, `text-primary`, `border-accent-1`, etc. in class output.
- Unseen one-off colors: arbitrary, e.g. `text-[#3a3a3a]`.

### Typography

- Font families: promote to `theme.extend.fontFamily`. Use `next/font/local` in `layout.tsx` with the downloaded woff2 files and expose via CSS variable, then reference as `['var(--font-display)']` etc.
- Font sizes: promote clusters to `theme.extend.fontSize` as named keys (`display`, `h1`, `body`, `small`). Value is `[fontSize, { lineHeight, letterSpacing, fontWeight }]`.
- One-off sizes: `text-[32px]/[1.2]` arbitrary.

### Spacing

- Infer the scale from `manifest.design_tokens.spacing[]`. Often 4px / 8px / 16px / 24px ... but match what the site actually uses.
- Extend Tailwind's spacing scale only for values not already close to a default step.
- Use `gap-*`, `p-*`, `m-*`, `space-y-*` utilities.

### Gradients

- Linear: `bg-gradient-to-r from-[#...] via-[#...] to-[#...]` for simple 2-3 stops. For more stops or angled variants, use arbitrary `bg-[linear-gradient(135deg,#a_0%,#b_50%,#c_100%)]`.
- Radial: `bg-[radial-gradient(...)]` arbitrary.
- Conic: `bg-[conic-gradient(...)]` arbitrary.
- Mesh / multi-layer: wrap in `bg-[image:...]` syntax with escaped commas.

### Shadows

- Single-layer shadows that match scale: `shadow-md`, `shadow-xl`.
- Multi-layer shadows: arbitrary with escaped commas: `shadow-[0_1px_2px_rgba(0,0,0,0.05),_0_4px_8px_rgba(0,0,0,0.08)]`.
- Promote 3+ occurrences of the same shadow to `theme.extend.boxShadow`.

### Filters and backdrop-filter

- Built-in: `blur-*`, `brightness-*`, `contrast-*`, `grayscale-*`, `backdrop-blur-*`, `backdrop-saturate-*`.
- Arbitrary: `filter-[blur(16px)_saturate(140%)]`, `backdrop-filter-[blur(20px)_saturate(140%)]`.
- Complex filter chains (4+ functions): promote to a CSS utility class in `globals.css` under `@layer utilities`.

### clamp() / min() / max()

- Preserve verbatim in arbitrary: `text-[clamp(24px,4vw,48px)]`, `w-[min(100%,1200px)]`.
- Do not try to approximate with `md:` breakpoints — the whole point of `clamp()` is continuous scaling.

### Variable fonts

- `font-variation-settings: "wght" 420, "ital" 0` → arbitrary `[font-variation-settings:'wght'_420,'ital'_0]`.
- If the site uses variable weights fluidly (e.g. on hover), pair with `transition-[font-variation-settings]`.

### Container queries

- Use the `@tailwindcss/container-queries` plugin. Add to `tailwind.config.ts` plugins.
- Mark the container: `@container`.
- Query: `@md:grid-cols-2`, `@lg:text-lg`, etc.

### clip-path and mask

- Built-in utilities cover basic cases (`rounded-full`). Anything custom: arbitrary.
- `clip-path: polygon(...)` → `[clip-path:polygon(0_0,100%_0,100%_80%,0_100%)]`.
- `mask-image` → `[mask-image:linear-gradient(...)]` + matching `[-webkit-mask-image:...]` if Safari support needed.

### Transforms

- Scale / rotate / translate cover common cases. Chained transforms: Tailwind's `transform` + individual utilities, or arbitrary `[transform:perspective(800px)_rotateY(12deg)]`.

### Transitions

- Simple: `transition-colors`, `duration-200`, `ease-in-out`.
- Multi-property transitions: arbitrary `[transition:transform_400ms_cubic-bezier(0.22,1,0.36,1),_opacity_300ms]`.

### Keyframes / `@keyframes`

- Always bail to `globals.css` under `@layer utilities` or a named keyframe in `tailwind.config.ts` `theme.extend.keyframes` + `animation`.
- Then reference in JSX: `animate-fade-up`.

## When to bail to `globals.css`

Write rules to `src/app/globals.css` (not to the component) when:

- The rule is `@property` — Tailwind cannot express it.
- The rule is `@supports` — conditional CSS outside Tailwind's reach.
- The rule is `@font-face` — prefer `next/font/local`, but if the font is served from a remote URL that cannot be downloaded, `@font-face` in `globals.css` is acceptable.
- A selector you cannot express as a class (e.g. `:has()`, `:nth-child(odd) > :first-of-type`).
- Complex multi-rule animations (keyframes + state variants + JS hooks).

Keep `globals.css` under 200 lines. If it grows beyond, group related rules into separate files imported from `globals.css`.

## Do not

- Do not re-derive cascade from the source stylesheets. The computed styles on each node already resolve cascade. Copy those.
- Do not use `!important`. If a style is not applying, you have a selector specificity problem — fix it by structuring the JSX, not by nuking the cascade.
- Do not add classes that are not represented in the captured computed styles. If the source does not have `box-shadow`, do not add one "for polish".
- Do not add `@apply` in component files. `@apply` only belongs in `globals.css` when consolidating a repeated utility cluster.
- Do not leave TODO comments in component files — the cloner is meant to be done work, not a scaffold.
