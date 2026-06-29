---
name: site-manifest
description: Schema and rules for manifest.json — the single blueprint artifact the analyze agent produces and the generate + validate agents consume. Defines field shapes, stable id conventions, token naming conventions, and what goes where. Load this in the analyze agent before writing manifest.json and in any agent that reads it.
user-invocable: false
---

# site-manifest

Everything the generate + validate agents need lives in `manifest.json` at `<workspace>/manifest.json`. The capture bundle is the raw source; the manifest is the refined, structured index.

## Top-level schema

```ts
type Manifest = {
  source_url: string; // absolute URL
  captured_at: string; // ISO 8601
  viewports: number[]; // e.g. [375, 768, 1280, 1920]

  design_tokens: {
    colors: Record<string, string>; // semantic_name -> hex (e.g. "primary" -> "#1A1A1A")
    typography: {
      families: Record<string, string>; // semantic -> family (e.g. "display" -> "'Inter Display', sans-serif")
      scales: Array<{
        name: string; // "display" | "h1" | "body" | "small" | ...
        size: string; // "48px"
        lineHeight: string; // "1.1"
        weight: number; // 500
        letterSpacing: string; // "-0.02em"
      }>;
    };
    spacing: number[]; // the scale in px — e.g. [4, 8, 12, 16, 24, 32, 48, 64]
    radii: Record<string, string>; // "sm" -> "4px"
    shadows: Record<string, string>; // "md" -> "0 1px 2px ..." (full CSS value)
    breakpoints: Record<string, number>; // "md" -> 768
  };

  fonts: Array<{
    family: string; // "Inter Display"
    weights: number[]; // [400, 500, 700]
    styles: Array<'normal' | 'italic'>;
    source_urls: string[]; // as seen in @font-face
    local_paths: string[]; // where they were downloaded
    license_hint?: 'licensed' | 'unclear' | 'open';
  }>;

  sections: Array<{
    id: string; // slug — stable across reruns
    name: string; // "Hero" | "Feature Grid" | ...
    dom_path: string; // relative to capture_dir — JSON file with DOM + computed styles
    screenshot_paths: Record<number, string>; // viewport -> relative path in capture_dir
    section_anchor?: string; // CSS selector for this section's root element (e.g. "#hero", ".elementor-element-fe377c0"). Used by validate's dom-diff `root_selector`. REQUIRED when present in capture.
    bounding_box: { x: number; y: number; width: number; height: number }; // at canonical 1280×720 capture
    vh_relative?: boolean; // true if the height is viewport-height-derived (see vh-flags.json)
    vh_value?: number; // implied vh percentage (e.g. 88 for ~min-height: 88vh) when vh_relative is true
    full_width?: boolean; // true if width matched viewport width at capture time AND nominal source CSS targets full-bleed (use w-full / w-screen, not the literal px value)
    max_stage_required: 1 | 2 | 3 | 4;
    detected_libs: string[]; // ["gsap", "framer-motion", "lottie", "three"]
    third_party_widgets: Array<{ vendor: string; selector: string; bbox: BBox }>;
    repeated_patterns: Array<{
      selector: string; // pattern selector in the captured DOM
      count: number; // 3+
      candidate_component: {
        name: string; // PascalCase
        props: string[]; // field names extracted from pattern variance
      };
    }>;
  }>;

  assets: Array<{
    type: 'image' | 'video' | 'font' | 'svg' | 'lottie';
    source_url: string; // absolute
    local_path: string; // "public/assets/cloned/images/<hash>-<name>"
    dimensions?: { width: number; height: number };
    from_css?: boolean; // true if discovered from a CSS url() rather than a HAR response
    referenced_by: string[]; // section ids where this asset appears
  }>;

  // Optional — populated when capture.py finds vh-relative elements (compares
  // canonical 1280×720 capture against a 1280×1080 alt-height capture).
  vh_relative_elements?: Array<{
    path: string; // structural path produced by detect_vh_flags()
    tag: string;
    id?: string | null;
    class?: string | null;
    primary_h: number; // height at 1280×720
    alt_h: number; // height at 1280×1080
    ratio: number; // alt_h / primary_h — should ~= 1.5 for vh-relative
    vh: number; // implied vh % (= primary_h / 720 * 100)
  }>;

  skipped: Array<{
    reason: 'drm' | 'third_party_widget' | 'auth_required' | 'wasm_obfuscated' | 'licensed_font_unclear';
    element?: string; // selector
    original_url?: string;
    vendor?: string;
  }>;
};
```

## Id conventions

- `section.id` is a slug from `section.name`, suffixed with a stable counter when the same semantic name appears twice: `features-0`, `features-1`. Order is DOM order top-to-bottom.
- Asset `local_path` uses an 8-char sha1 hash of the source URL + the original filename: `abc12345-hero-background.jpg`. This guarantees no collisions and is stable across reruns.
- `repeated_patterns[].candidate_component.name` is PascalCase, singular: `FeatureCard` not `FeatureCards`.

## Determinism

The analyze agent MUST produce the same manifest on the same capture input. This means:

- No timestamps inside section ids (`captured_at` at the top is fine — it is read-once)
- No random numbers, no iterator-order-dependent ids
- Sort arrays by semantic key (sections by DOM order, assets by local_path, skipped by reason then element)

## Promotion rule for tokens

A value goes into `design_tokens` only if it is used 3+ times in the capture. One-off values stay inline in the DOM fragment and become arbitrary Tailwind values in generation.

Exception: the page-level background color, primary text color, and primary font family always go into `design_tokens` regardless of count — downstream agents need them to set globals.

## Capture artifacts the analyze agent should read

In addition to per-section `dom_path` files, several capture-level artifacts are now available:

- `<capture_dir>/sections/<viewport>.json` — `__CLONE_LIST_SECTIONS__` candidate sections per viewport, with bbox and selector. Use these as scaffolding when decomposing into manifest sections — the smarter scroll loop already used these to time the capture, so each candidate has a clean DOM dump.
- `<capture_dir>/section-shots/<viewport>/section-NN.png` — pre-cropped per-section screenshots. Map these to manifest sections by index; the validate agent uses them as the diff reference.
- `<capture_dir>/css-rules/<viewport>.json` — every same-origin CSS rule, plus extracted `url()` asset references. Use this to recover source intent (e.g. `min-height: 100vh`, `width: 100%`, `aspect-ratio: 16/9`) that resolved computed styles erase. Also lets you recover backgrounds/masks/cursors that were not GET-requested at capture time.
- `<capture_dir>/dom-alt/1280-1080/step-00.json` — DOM at canonical width with alt height. Used internally to derive `vh-flags.json`; you don't need to read this directly.
- `<workspace>/vh-flags.json` (next to manifest.json) — pre-computed list of vh-relative element candidates. Cross-reference against your section bbox.y values to populate `section.vh_relative` + `section.vh_value`.

## How to populate vh_relative on a section

1. Load `vh-flags.json`.
2. For each entry, check whether its `path` resolves to an element inside or equal to one of your section roots.
3. If a flagged entry IS the section root, set `section.vh_relative = true` and `section.vh_value = entry.vh`.
4. If a flagged entry is a child but the child's height equals the section's height, the section itself is vh-relative — same flag.
5. The generate agent uses this to emit `min-h-[<vh>vh]` (Tailwind arbitrary) or `min-h-screen` when vh ≈ 100. See `css-to-tailwind` for the rule.

## Reading the DOM fragment

Each `section.dom_path` points to a JSON file with this shape:

```ts
type DomNode = {
  tag: string;
  attrs: Record<string, string>; // already translated: class, for, tabindex names
  text?: string; // text content if leaf or pre-text
  computed: {
    // resolved computed styles — only non-default values
    color?: string;
    backgroundColor?: string;
    fontFamily?: string;
    fontSize?: string;
    // ... any property the node actually uses
    pseudo?: {
      '::before'?: Record<string, string>;
      '::after'?: Record<string, string>;
      ':hover'?: Record<string, string>;
      ':focus-visible'?: Record<string, string>;
    };
  };
  children: DomNode[];
};
```

The generate agent walks this tree and emits JSX with Tailwind classes derived from `computed`. Because the styles are already resolved, no cascade reasoning is required.

## Validation

After writing `manifest.json`, self-check:

- `viewports.length >= 1`
- Every `section.screenshot_paths` has a key for each viewport
- Every `asset.local_path` starts with `public/assets/cloned/`
- No section has `max_stage_required > 4` or `< 1`
- `design_tokens.colors.primary` exists (fall back to `#000` if none inferred — noisy fallback is better than missing key)

If a check fails, fix the manifest — do not write a broken one.
