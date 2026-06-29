---
name: dom-to-jsx
description: Rules for converting captured DOM fragments into Next.js App Router JSX components. Covers component naming, when to split, Server vs Client classification, hydration-safe patterns, image handling (next/image vs raw img), and prop extraction for repeated patterns. Load this in every generation run from Stage 1 onward.
user-invocable: false
---

# DOM → JSX

The generate agent receives a DOM fragment per section. Convert it into idiomatic Next.js 14+ App Router JSX.

## Component naming

- PascalCase. Section-scoped: `HeroSection`, `FeatureGrid`, `TestimonialCard`, `PricingTable`, `CTAStrip`.
- File path: `src/components/sections/<Name>.tsx` for top-level sections, `src/components/cards/<Name>.tsx` for repeated card components, `src/components/ui/<Name>.tsx` for primitives (button, badge).
- Default export matches the file name. Named exports are fine for sub-components.

## When to split

Split a component when any of these is true:

- File exceeds 150 lines of JSX
- JSX nesting exceeds 3 levels
- A repeated pattern appears 3+ times within the section

When splitting for a repeat, extract a component with a `data` prop (array of items) or a single-item prop shape matching the manifest's `candidate_component` proposal.

Example — manifest says a `FeatureCard` appears 6 times with `{title, description, icon}`:

```tsx
// src/components/cards/FeatureCard.tsx
type Props = { title: string; description: string; icon: string };
export default function FeatureCard({ title, description, icon }: Props) { ... }

// src/components/sections/Features.tsx
import FeatureCard from "@/components/cards/FeatureCard";
const ITEMS = [{ title: "...", description: "...", icon: "..." }, ...];
export default function Features() {
  return <div className="grid grid-cols-3 gap-8">{ITEMS.map(i => <FeatureCard key={i.title} {...i} />)}</div>;
}
```

Extract `ITEMS` as a local `const` in the section file for Stage 1. If the data is clearly content-managed (12+ items, or visually heterogeneous), move to `src/content/<section>.ts` as a typed export.

## Server vs Client

Default: **Server Component**. Add `"use client"` at the top of a file only if any of these is true:

- Uses `useState`, `useEffect`, `useRef`, or any other hook
- Uses event handlers (`onClick`, `onChange`, etc.) — interactive buttons that do more than `<a href>`-style navigation
- Uses `framer-motion`'s `motion.*` components
- Uses `lottie-react` or any other client-only lib
- Uses browser APIs (`window`, `document`, `localStorage`)

Do not mark parents client unnecessarily. Keep `"use client"` at the leaf — a client leaf can live inside a server parent, not vice versa.

## Hydration safety

- **No** `Date.now()` / `Math.random()` / `new Date()` at render. If needed, generate in `useEffect` and store in state. At render time the first pass must be deterministic.
- **No** reading `window` / `document` at module scope. Wrap in `useEffect` or guard with `typeof window !== "undefined"`.
- `suppressHydrationWarning` is a last resort — only on a single element where the server/client divergence is intentional and minimal (e.g. a `<time>` element).
- Do not pass `new Date()` or live content into a Server Component from within a client wrapper at first paint — you will get a mismatch.

## Image handling

**Default: `next/image`** when all of these hold:

- The image has known dimensions (the manifest captured them)
- The image is a raster (jpg, png, webp, avif)
- The image is content, not purely decorative

Example:

```tsx
import Image from 'next/image';
<Image src="/assets/cloned/images/abc1234-hero.jpg" alt="" width={1920} height={1080} />;
```

**Raw `<img>`** for:

- SVGs (use native `<img src="/assets/cloned/svg/xyz.svg" alt="" />` or inline the SVG as a component if <5KB and decorative)
- Images with unknown dimensions at clone time
- Decorative blur-ups where LCP is not a concern

**Inline SVG** when:

- The SVG is <5KB in the source
- The SVG is used in-flow (not as a background-image)
- Animated parts need to be controlled from JS

Configure `next.config.js` to allow loading from `/assets/cloned` paths — no external loader needed since everything is already local.

## Video

```tsx
<video src="/assets/cloned/videos/<hash>.mp4" autoPlay loop muted playsInline className="..." />
```

Always `playsInline` (iOS won't inline autoplay without it). Always `muted` for autoplay (browsers require it).

## Links

- Internal: `<Link href="/...">` from `next/link`.
- External: `<a href="..." target="_blank" rel="noopener noreferrer">`.
- Anchor in page: plain `<a href="#id">` is fine — `<Link>` with a hash works too.

## Accessibility

Keep what the source had — do not invent. If the source has `aria-label` or `alt=""`, preserve it. If the source is inaccessible, the clone is inaccessible. This is a fidelity tool, not a correction tool.

That said — do not _remove_ accessibility attributes the source had.

## Third-party widgets (skip per `clone-staging`)

When the manifest flags a subtree as a third-party widget, replace with:

```tsx
<div style={{ width: W, height: H }}>{/* CLONE: skipped third-party widget — <vendor> */}</div>
```

Pull `W` and `H` from the manifest's bounding box for the widget's container. This preserves layout so later sections land at the right Y offset.

## Forms

The clone is a static marketing-page mirror. Forms should render visually but the `onSubmit` handler is `(e) => e.preventDefault()` — no backend wiring.

If the source had client-side validation that is material to the layout (error states, spinners), keep it as a visual-only `useState` example. Do not call real APIs.

## Attribute translation

- `class` → `className`
- `for` → `htmlFor`
- `tabindex` → `tabIndex`
- Hyphenated attrs on SVG: most become camelCase (`stroke-width` → `strokeWidth`), but `data-*` and `aria-*` stay hyphenated.
- `style="..."` → `style={{ ... }}` with camelCase keys. Only inline style that is computed / dynamic; static style always goes to Tailwind per `css-to-tailwind`.

## Content

- Copy text verbatim from the DOM fragment. Do not paraphrase. Do not translate. Do not "improve" grammar.
- Preserve whitespace-sensitive content (`<pre>`, `<code>`) exactly.
- Keep HTML entities as-is (`&mdash;`, `&nbsp;`, `&hellip;`) but JSX renders them when placed inside string literals — use `{"—"}` or `{"\u00a0"}` for non-breaking spaces when adjacency matters.
