---
name: animation-translation
description: Library mapping from source-site animation primitives (CSS keyframes, CSS transitions, GSAP tweens/timelines/ScrollTrigger, Framer Motion, Lottie, Three.js, IntersectionObserver reveals) to target primitives in the cloned Next.js project. Rules on when to translate vs keep source library. Load this in Stage 2 (CSS portion) and Stage 3 (JS portion).
user-invocable: false
---

# Animation Translation

Rule of thumb: prefer declarative (Framer Motion, Tailwind transitions) over imperative (GSAP, manual `requestAnimationFrame`) when the translation is clean. Keep imperative when translation loses fidelity — e.g. a GSAP timeline with 15 chained steps.

## Mapping table

| Source                                    | Target                                             | Stage | Notes                                                       |
| ----------------------------------------- | -------------------------------------------------- | ----- | ----------------------------------------------------------- |
| CSS keyframes (`@keyframes`)              | CSS keyframes kept in `globals.css`                | 2     | No reason to translate                                      |
| CSS transition                            | Tailwind `transition-*` / arbitrary                | 2     | `transition-colors duration-200 ease-in-out`                |
| GSAP tween (single property)              | Framer Motion `animate` prop                       | 3     | `<motion.div animate={{ opacity: 1 }} transition={{...}}/>` |
| GSAP timeline (complex, chained)          | Keep GSAP + `@gsap/react` `useGSAP`                | 3     | Do not force bad Framer translation                         |
| GSAP ScrollTrigger (simple)               | Framer `useScroll` + `useTransform`                | 3     | Only when trigger + 1-2 output props                        |
| GSAP ScrollTrigger (complex)              | Keep GSAP + ScrollTrigger                          | 3     | Timeline > 3 steps, pinned, scrub                           |
| Framer Motion (source already)            | Framer Motion direct                               | 3     | Copy `variants`, `transition`, `whileInView` verbatim       |
| Lottie                                    | `lottie-react` + captured `animationData`          | 3     | Component is `"use client"`                                 |
| Three.js                                  | `@react-three/fiber` + `drei`                      | 4     | Handled by `clone-advanced`                                 |
| Custom GLSL shaders                       | `<shaderMaterial>` with extracted GLSL             | 4     | Handled by `clone-advanced`                                 |
| `IntersectionObserver` reveal             | Framer `whileInView` + `viewport: { once: true }`  | 3     | Rarely worth keeping imperative                             |
| Raw `<canvas>` 2D loop                    | Keep the `<canvas>` + `"use client"` + `useEffect` | 4     | If reconstruction fails, video fallback                     |
| WAAPI (`Element.animate()`)               | Translate to Framer `animate`                      | 3     | Similar semantics                                           |
| Parallax (`background-attachment: fixed`) | CSS kept                                           | 2     | Browsers support it directly                                |

## Stage 2 (CSS animation)

### Keyframes

Source:

```css
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.hero-title {
  animation: fadeUp 0.6s ease-out forwards;
}
```

Target — in `globals.css`:

```css
@layer utilities {
  @keyframes fade-up {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .animate-fade-up {
    animation: fade-up 0.6s ease-out forwards;
  }
}
```

Or, per `css-to-tailwind`, add to `tailwind.config.ts`:

```ts
theme: { extend: {
  keyframes: { "fade-up": { from: { opacity: "0", transform: "translateY(12px)" }, to: { opacity: "1", transform: "none" } } },
  animation: { "fade-up": "fade-up 0.6s ease-out forwards" },
}}
```

Then the component just has `className="animate-fade-up"`.

### Transitions

Source: `transition: transform 400ms cubic-bezier(0.22,1,0.36,1);`

Target: `className="transition-transform duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)]"`. If that tuple repeats, promote the easing to `theme.extend.transitionTimingFunction`.

## Stage 3 (JS animation)

### Framer Motion (common path)

The capture hook dump gives you the component's `variants`, `transition`, `animate`, `initial`, `whileInView`, `whileHover`, `whileTap` verbatim. Reproduce them:

```tsx
'use client';
import { motion } from 'framer-motion';

const variants = { hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } };
export default function Hero() {
  return (
    <motion.section
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      variants={variants}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      ...
    </motion.section>
  );
}
```

### GSAP ScrollTrigger kept

When the source has a pinned, scrubbed, multi-step timeline, translating to Framer would flatten it. Keep GSAP:

```tsx
'use client';
import { useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(ScrollTrigger);

export default function PinnedHero() {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const tl = gsap.timeline({
        scrollTrigger: { trigger: ref.current, start: 'top top', end: '+=1200', pin: true, scrub: 1 },
      });
      tl.to('.layer-a', { yPercent: -30 }).to('.layer-b', { yPercent: -50 }, '<');
    },
    { scope: ref }
  );
  return <div ref={ref}>...</div>;
}
```

### Lottie

```tsx
'use client';
import Lottie from 'lottie-react';
import animationData from '@/public/assets/cloned/lottie/<hash>.json';

export default function LottieIcon() {
  return <Lottie animationData={animationData} loop autoplay style={{ width: 64, height: 64 }} />;
}
```

Prefer imports over `fetch()` so the JSON ships in the bundle and there is no layout shift on first play.

## Respecting `prefers-reduced-motion`

The Stage 1 gate runs with reduced motion forced, so your Stage 1 output should render a static final-state snapshot when motion is reduced.

In Framer Motion, use the `MotionConfig` with `reducedMotion="user"` in `layout.tsx`, or gate `animate` / `initial` on a `useReducedMotion()` hook.

For CSS animations, wrap the rule:

```css
@media (prefers-reduced-motion: no-preference) {
  .animate-fade-up {
    animation: fade-up 0.6s ease-out forwards;
  }
}
```

## Do not

- Do not add animations that are not in the source. The clone target is fidelity, not flair.
- Do not approximate a GSAP timeline with a Framer `animate` sequence if the timeline has overlaps, labels, or scrubbing — keep GSAP.
- Do not use `requestAnimationFrame` by hand if Framer covers the case. You will burn React lifecycle bugs.
- Do not import full `gsap` bundle if only `ScrollTrigger` is needed — it is fine to `import { gsap } from "gsap"` because tree-shaking handles it, but check the bundle size if multiple sections use GSAP.
