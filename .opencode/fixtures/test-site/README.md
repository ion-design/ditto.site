# Capture-fixture site

A small static site that exercises the capture-side ailing patterns we found on real WordPress / Elementor targets:

| Section                  | What it tests                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `#hero`                  | `min-height: calc(100vh - var(--nav-h))` — vh detection should flag this                             |
| `#features`              | full-width gradient + content `max-width` inner — `full_width` detection                             |
| `#features .card.reveal` | IntersectionObserver-driven opacity reveal — only renders correctly when capture scrolls into view   |
| `#bg`                    | lazy-loaded background-image (class toggle on intersection) — CSS-rule extraction must catch the URL |
| `#bg::after`             | `::before/::after` decorative bg-image — pseudo-element styles must be captured                      |
| `#marquee`               | CSS-keyframes infinite scroll with offscreen items — capture should still see all 8 logos            |
| `#detailed-svg`          | inline SVG with `<defs>`, `<linearGradient>`, complex paths — must be preserved verbatim             |

## Serve

```bash
cd .opencode/fixtures/test-site
python3 -m http.server 8765
# http://localhost:8765
```

## Run capture against the fixture

```bash
SLUG=fixture
TS=$(date +%Y%m%d-%H%M%S)
WS=".clone-workspace/${SLUG}-${TS}"
mkdir -p "$WS"
python3 .opencode/scripts/capture.py \
  --url http://localhost:8765 \
  --viewports 1280 \
  --output "$WS/capture"
```

Then verify the new signals are present:

```bash
# vh detection
jq '.[0:5]' "$WS/vh-flags.json"            # expect #hero or .hero with vh ≈ 91 (= (720-64)/720*100)

# CSS asset extraction
jq '.assets[] | select(.from_css)' "$WS/capture/meta.json"  # expect ./hero-bg.svg + ./decoration.svg

# section discovery
jq '.[0].selector,.[1].selector,.[2].selector' "$WS/capture/sections/1280.json"

# per-section screenshots
ls "$WS/capture/section-shots/1280/"
```

## Iterate fast

```bash
# Replay only the post-process (vh-flags, meta.json) — sub-second
python3 .opencode/scripts/capture.py --replay --output "$WS/capture"

# Diff a rendered clone vs the captured fixture
python3 .opencode/scripts/dump-rendered.py \
  --url http://localhost:3000/ \
  --output /tmp/rendered.json \
  --viewport 1280 --scroll-y 0
python3 .opencode/scripts/dom-diff.py \
  --captured "$WS/capture/dom/1280/step-00.json" \
  --rendered /tmp/rendered.json \
  --root-selector "#hero"
```

The fixture is intentionally tiny so a full capture takes <5s. Use it to validate any capture-side change before re-running against a real site.
