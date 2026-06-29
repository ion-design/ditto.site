---
name: asset-pipeline
description: Rules for how the clone pipeline names, organizes, and references downloaded assets. Covers folder layout under public/assets/cloned, hash-based filename convention, font strategy (self-host via next/font/local, fall back to system stack if licensing unclear), SVG inline-vs-file threshold, video format, and import paths. Load this when downloading assets and when referencing them in JSX.
user-invocable: false
---

# Asset Pipeline

All cloned assets live under the generated project's `public/assets/cloned/`. Never outside this tree. Never in the workspace `.clone-workspace` beyond the capture bundle.

## Layout

```
<project>/public/assets/cloned/
  images/       # jpg, png, webp, avif
  videos/       # mp4 (only)
  fonts/        # woff2 (preferred), woff, ttf
  svg/          # .svg files when not inlined
  lottie/       # .json animation data
```

## Naming

Every file is renamed to `<sha1-8>-<sanitized-original-name>`. The sha1 is of the source URL (not content), truncated to 8 hex chars. Sanitization: lowercase, spaces → `-`, strip everything not in `[a-z0-9.-]`.

Examples:

- `https://cdn.site.com/hero-bg.jpg` → `a1b2c3d4-hero-bg.jpg`
- `https://fonts.site.com/inter-display-500.woff2` → `e5f67890-inter-display-500.woff2`

Collisions are effectively impossible at 8 chars for any one site. If they happen, extend to 10.

The manifest records the full `local_path` for each asset — the generate agent reads that field, never reconstructs the path.

## Fonts

**Preferred: self-hosted via `next/font/local`.** In `src/app/layout.tsx`:

```ts
import localFont from 'next/font/local';

const display = localFont({
  src: [
    { path: '../../public/assets/cloned/fonts/e5f67890-inter-display-400.woff2', weight: '400', style: 'normal' },
    { path: '../../public/assets/cloned/fonts/abcd1234-inter-display-500.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body className="font-display">{children}</body>
    </html>
  );
}
```

Then in `tailwind.config.ts`:

```ts
theme: {
  extend: {
    fontFamily: {
      display: ['var(--font-display)', 'sans-serif'];
    }
  }
}
```

**If licensing is unclear** (manifest marks `license_hint: "licensed"` or `"unclear"`), do NOT ship the font file. Substitute with the closest free alternative from a system stack and flag in the final report:

| Source font                      | Fallback                                               |
| -------------------------------- | ------------------------------------------------------ |
| Any licensed sans                | Inter from Google Fonts (via `next/font/google`)       |
| Any licensed serif               | `ui-serif, Georgia, Cambria, "Times New Roman", serif` |
| Any licensed mono                | `ui-monospace, SFMono-Regular, Menlo, monospace`       |
| Variable display font (licensed) | Inter or Manrope via `next/font/google`                |

Record the substitution in the manifest's `skipped[]` with `reason: "licensed_font_unclear"` and log to `logs/skipped.md`.

## SVGs

**Inline as React component** when all hold:

- Source size < 5KB
- SVG is used in-flow, not as a CSS `background-image`
- SVG has no `<script>` tags (never inline external scripts)

Use `@svgr/webpack` or inline the markup by hand in a small component file `src/components/icons/<Name>.tsx`. Prefer hand-written components for simple icons — `@svgr` adds tooling complexity that rarely pays back.

**Keep as file** when:

- SVG ≥ 5KB
- SVG is used as `background-image` (referenced from CSS)
- SVG contains references to `<filter>` or `<pattern>` that make it complex to inline

For file-kept SVGs, reference as `<img src="/assets/cloned/svg/<hash>.svg" alt="" />`. `next/image` does not accept SVGs without the `dangerouslyAllowSVG` flag — prefer raw `<img>` over enabling that flag.

## Videos

Only MP4. Capture normalizes HLS/DASH to MP4 when possible; if the source is DRM-protected (Widevine / FairPlay / PlayReady signatures in HAR), skip with `reason: "drm"` in the manifest.

Embed as:

```tsx
<video
  src="/assets/cloned/videos/<hash>.mp4"
  autoPlay
  loop
  muted
  playsInline
  poster="/assets/cloned/images/<hash>-poster.jpg"
/>
```

## Images

`next/image` is preferred. Configure no remote domains — everything is local under `/assets/cloned/`, which Next.js serves as static assets automatically.

```tsx
import Image from 'next/image';
<Image
  src="/assets/cloned/images/abc1234-hero.jpg"
  alt=""
  width={1920}
  height={1080}
  priority={isAboveTheFold}
  sizes="(max-width: 768px) 100vw, 1200px"
/>;
```

- `alt=""` for decorative images. Preserve source `alt` when present.
- `priority` on above-the-fold images (hero bg, logo).
- `sizes` matches the responsive layout — omit if the image is fixed-width.

For background images (CSS `background-image`), keep as CSS with arbitrary Tailwind value:

```tsx
<div className="bg-[url('/assets/cloned/images/abc1234-bg.jpg')] bg-cover bg-center" />
```

## Lottie

Lottie JSON files go under `lottie/`. Import them as ES modules, not fetch at runtime — this eliminates flash and is under 100KB in nearly every case:

```tsx
import animationData from '@/public/assets/cloned/lottie/<hash>.json';
```

If a Lottie is > 1MB, consider dynamic import with a `<Suspense>` boundary to defer.

## Import paths

In Next.js, the public directory is served at the root. Use absolute paths starting with `/`:

- ✅ `<img src="/assets/cloned/svg/logo.svg" />`
- ✅ `import data from "@/public/assets/cloned/lottie/x.json"` (for ES import of JSON)
- ❌ Never `../../../public/...` from components
- ❌ Never `https://source-site.com/...` — those were downloaded

## Flagging failures

If an asset download fails (404, timeout, CORS, auth), the orchestrator records it in `logs/skipped.md` with the URL and reason. Generation should render a placeholder of the captured dimensions rather than a broken `<img>` for any section that referenced the missing asset.

## Cleanup rule

Do not delete assets the capture downloaded "just in case they are unused". The analyze agent records `assets[].referenced_by[]`; if the array is empty, leave the file in place — it might be referenced in a stage that has not run yet. Orphan cleanup is a post-run task, not part of generation.
