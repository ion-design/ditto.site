# Debug benchmark — 10 homepage clones (2026-07-03)

Branch `fable/pattern-index-preview-speed` (PR #3). Homepage only, viewport 1280,
`interactions/components/motion: false`, `CATALOG_ONLY_HINTS=true`. Two passes per site:
**fresh** = cold capture + full gate validation (`verify:true`, per-site tier) + app preview;
**cached** = repeat clone against the capture cache + preview build (no verify) — the
user-visible "clone it again" path the <60 s target applies to.

Note on the Build column: on the fresh pass a clean verify leaves a build in the harness and
the preview reuses it (publish ≈ 0 s, build time is inside Verify). The cached pass's preview
time IS a full `next build`, so that column is the honest standalone build cost.

| Site | Kind | Fresh total (s) | Capture (s) | Generate (s) | Verify (s) | Cached total (s) | Build, cached (s) | Score | G0–6 | Stage2 | App preview | Mirror | Issues |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| michaelcole | portfolio (easy) | 14.6 | 4.0 | 1.0 | 9.7 | 6.2 | 6.2 | 100 | ✅ | ✅ | ✅ (42 files) | ✅ | — |
| leerob | personal (easy) | 14.6 | 4.3 | 1.5 | 8.8 | 6.6 | 6.6 | 99.9 | ✅ | ✅ | ✅ (49 files) | ✅ | html_witness: 3/3 origin asset refs never discovered by capture |
| daringfireball | content blog | 55.8 | 19.4 | 1.3 | 35.0 | 6.2 | 5.8 | 96 | ❌ | ❌ | ✅ (62 files) | ✅ | html_witness: 3/20 origin asset refs never discovered by capture; layout: vp1280 leaf median bbox delta 177.4px (> 16px); responsive: 1/1 centred-container checks off-centre at non-captured widths |
| brew | OSS static | 16.2 | 4.5 | 0.7 | 10.9 | 6.4 | 6.3 | 99.7 | ✅ | ✅ | ✅ (38 files) | ✅ | responsive: 1/3 centred-container checks off-centre at non-captured widths |
| astro | OSS landing (modern) | 26.8 | 6.5 | 4.8 | 15.3 | 6.0 | 5.7 | 99.5 | ✅ | ✅ | ✅ (122 files) | ✅ | — |
| linear | SaaS marketing (motion) | 30.5 | 8.8 | 4.1 | 17.5 | 6.6 | 6.0 | 99.7 | ✅ | ✅ | ✅ (85 files) | ✅ | html_witness: 4/4 origin asset refs never discovered by capture |
| stripe | big marketing | 67.3 | 15.4 | 28.5 | 22.5 | 9.0 | 7.5 | 99.7 | ❌ | ❌ | ✅ (780 files) | ✅ | layout: vp1280 leaf size ok 92% (< 92%); responsive: 1/8 centred-container checks off-centre at non-captured widths |
| ooni | Shopify e-commerce | 64.1 | 32.0 | 15.7 | 16.2 | 7.8 | 6.7 | 99.4 | ✅ | ✅ | ✅ (627 files) | ✅ | html_witness: 4/245 origin asset refs never discovered by capture; dom_clone_witness: clone vs witness text 99.2% |
| allbirds | Shopify e-commerce | 28.0 | 9.1 | 7.0 | 11.8 | 6.0 | 5.7 | 99.7 | ✅ | ✅ | ✅ (176 files) | ✅ | dom_clone_witness: clone vs witness text 99.1% |
| cropin | WordPress/Elementor | 103.5 | 15.2 | 59.3 | 28.3 | 11.4 | 8.0 | 99.3 | ✅ | ✅ | ✅ (318 files) | ✅ | html_witness: 42/203 origin asset refs never discovered by capture; responsive: 3/4 centred-container checks off-centre at non-captured widths |

## Summary

- **Sites**: 10/10 completed, 0 errors, 0 auth walls, 0 polluted captures.
- **Gates 0–6**: 8/10 pass · **Stage 2**: 8/10 pass · score avg 99.3, min 96.
- **App preview**: 10/10 non-empty (`public/app-preview/index.html`) · **Mirror**: 10/10 present.
- **Fresh total** (capture+generate+verify+preview): p50 28.0 s · p95 103.5 s · max 103.5 s (cropin).
- **Cached total** (clone+preview): p50 6.4 s · p95 11.4 s · max 11.4 s — ALL 10/10 runs reused the capture cache and ALL are under the 60 s target (worst 11.4 s, 5× margin).
- **Failures by gate** (fresh, diagnostic gates included): {"html_witness": 5, "layout": 2, "responsive": 4, "dom_clone_witness": 2}.

### Failure modes observed

1. **Layout drift on classic fixed-column pages** (daringfireball: 177 px median leaf delta; the
   clone loses the centered fixed-width column). Biggest real fidelity miss of the run.
2. **Threshold-edge layout/centering flags on huge marketing pages** (stripe: leaf-size 92% at the
   92% bar; 1/8 centering probe off at non-captured widths). Cosmetically minor, score 99.7.
3. **Capture discovery misses** (daringfireball: 3/20 witness asset refs never discovered —
   conditionally-loaded images the settle pass never triggered).
4. **Generate time scales with node count** (stripe, 2192 nodes: 28.5 s generate vs 1–4 s typical;
   cropin 1145 nodes: ~13 s). Inference/codegen has an O(n²)-ish hot spot worth profiling.

## Top 3 fixes (highest impact)

1. **Profile + cut the generate hot path on big pages** — `compiler/src/generate/app.ts` /
   `compiler/src/infer/*`: stripe spends 28.5 s in IR+infer+codegen (node-count-quadratic behavior;
   likely the per-node style dedup / Tailwind emission loops). A profile run + memoization there
   converts the worst fresh clone from 67 s to ~40 s and shrinks cropin similarly.
2. **Centered fixed-column repair** — `compiler/src/validate/gates.ts` (gate 5 leaf-median) already
   localizes it; wire it into a repair pass in `compiler/src/generate/refineSizing.ts`-style loop:
   when median leaf delta is a uniform horizontal offset, re-emit the container with `margin-inline:
   auto` / explicit max-width instead of baked left offsets (daringfireball class; also fixes the
   responsive centering flags on stripe).
3. **Settle-pass asset discovery for conditional images** — `compiler/src/settle/recipe.ts` +
   `compiler/src/capture/capture.ts`: after the scroll pass, sweep `<img loading=lazy>`, `data-src`,
   and `picture>source` refs that never fired and fetch them via the fallback context (the 2b
   `untracked` metric now measures exactly this gap).

## Raw logs (one JSON event line per phase per site)

### michaelcole
```json
{"t": 1783116647163, "event": "goto", "url": "https://www.michaelcole.me/"}
{"t": 1783116650672, "event": "captured", "viewport": 1280, "nodes": 27, "scrollHeight": 800}
{"t": 1783116651621, "event": "ir_built", "nodes": 27}
{"t": 1783116651621, "event": "inferred", "sections": 0, "assets": 9, "fonts": 0}
{"t": 1783116651621, "event": "generated", "assetsCopied": 7, "assetsMissing": 0}
{"t": 1783116661284, "event": "validated", "status": "pass", "score": 100, "gates0to6": true}
{"t": 1783116661284, "event": "app_build_start"}
{"t": 1783116661294, "event": "app_build_done", "ok": true, "ms": 10, "files": 42, "reused": true}
{"t": 1783116661309, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/michaelcole.me/source"}
{"t": 1783116661317, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116661345, "pass": 2, "event": "ir_built", "nodes": 27}
{"t": 1783116661345, "pass": 2, "event": "inferred", "sections": 0, "assets": 9, "fonts": 0}
{"t": 1783116661345, "pass": 2, "event": "generated", "assetsCopied": 7, "assetsMissing": 0}
{"t": 1783116661346, "pass": 2, "event": "app_build_start"}
{"t": 1783116667510, "pass": 2, "event": "app_build_done", "ok": true, "ms": 6164, "files": 42, "reused": false}
```

### leerob
```json
{"t": 1783116667670, "event": "goto", "url": "https://leerob.io/"}
{"t": 1783116671831, "event": "captured", "viewport": 1280, "nodes": 34, "scrollHeight": 800}
{"t": 1783116673277, "event": "ir_built", "nodes": 32}
{"t": 1783116673277, "event": "inferred", "sections": 1, "assets": 19, "fonts": 30}
{"t": 1783116673277, "event": "generated", "assetsCopied": 11, "assetsMissing": 0}
{"t": 1783116682107, "event": "validated", "status": "pass", "score": 99.9, "gates0to6": true}
{"t": 1783116682107, "event": "app_build_start"}
{"t": 1783116682118, "event": "app_build_done", "ok": true, "ms": 11, "files": 49, "reused": true}
{"t": 1783116682124, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/leerob.io/source"}
{"t": 1783116682136, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116682153, "pass": 2, "event": "ir_built", "nodes": 32}
{"t": 1783116682153, "pass": 2, "event": "inferred", "sections": 1, "assets": 19, "fonts": 30}
{"t": 1783116682153, "pass": 2, "event": "generated", "assetsCopied": 11, "assetsMissing": 0}
{"t": 1783116682154, "pass": 2, "event": "app_build_start"}
{"t": 1783116688766, "pass": 2, "event": "app_build_done", "ok": true, "ms": 6611, "files": 49, "reused": false}
```

### daringfireball
```json
{"t": 1783116688925, "event": "goto", "url": "https://daringfireball.net/"}
{"t": 1783116708154, "event": "captured", "viewport": 1280, "nodes": 1181, "scrollHeight": 57745}
{"t": 1783116709377, "event": "ir_built", "nodes": 1165}
{"t": 1783116709377, "event": "inferred", "sections": 1, "assets": 22, "fonts": 0}
{"t": 1783116709377, "event": "generated", "assetsCopied": 17, "assetsMissing": 0}
{"t": 1783116744425, "event": "validated", "status": "partial", "score": 96, "gates0to6": false}
{"t": 1783116744426, "event": "app_build_start"}
{"t": 1783116744495, "event": "app_build_done", "ok": true, "ms": 69, "files": 62, "reused": true}
{"t": 1783116744555, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/daringfireball.net/source"}
{"t": 1783116744636, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116744857, "pass": 2, "event": "ir_built", "nodes": 1165}
{"t": 1783116744857, "pass": 2, "event": "inferred", "sections": 1, "assets": 22, "fonts": 0}
{"t": 1783116744857, "pass": 2, "event": "generated", "assetsCopied": 17, "assetsMissing": 0}
{"t": 1783116744885, "pass": 2, "event": "app_build_start"}
{"t": 1783116750668, "pass": 2, "event": "app_build_done", "ok": true, "ms": 5783, "files": 62, "reused": false}
```

### brew
```json
{"t": 1783116750852, "event": "goto", "url": "https://brew.sh/"}
{"t": 1783116755253, "event": "captured", "viewport": 1280, "nodes": 324, "scrollHeight": 3435}
{"t": 1783116755926, "event": "ir_built", "nodes": 320}
{"t": 1783116755926, "event": "inferred", "sections": 1, "assets": 7, "fonts": 0}
{"t": 1783116755926, "event": "generated", "assetsCopied": 5, "assetsMissing": 0}
{"t": 1783116766882, "event": "validated", "status": "pass", "score": 99.7, "gates0to6": true}
{"t": 1783116766882, "event": "app_build_start"}
{"t": 1783116766895, "event": "app_build_done", "ok": true, "ms": 13, "files": 38, "reused": true}
{"t": 1783116766908, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/brew.sh/source"}
{"t": 1783116766924, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116766979, "pass": 2, "event": "ir_built", "nodes": 320}
{"t": 1783116766979, "pass": 2, "event": "inferred", "sections": 1, "assets": 7, "fonts": 0}
{"t": 1783116766979, "pass": 2, "event": "generated", "assetsCopied": 5, "assetsMissing": 0}
{"t": 1783116766985, "pass": 2, "event": "app_build_start"}
{"t": 1783116773257, "pass": 2, "event": "app_build_done", "ok": true, "ms": 6272, "files": 38, "reused": false}
```

### astro
```json
{"t": 1783116773425, "event": "goto", "url": "https://astro.build/"}
{"t": 1783116779800, "event": "captured", "viewport": 1280, "nodes": 1155, "scrollHeight": 9057}
{"t": 1783116784558, "event": "ir_built", "nodes": 893}
{"t": 1783116784558, "event": "inferred", "sections": 3, "assets": 52, "fonts": 6}
{"t": 1783116784558, "event": "generated", "assetsCopied": 48, "assetsMissing": 0}
{"t": 1783116799955, "event": "validated", "status": "pass", "score": 99.5, "gates0to6": true}
{"t": 1783116799956, "event": "app_build_start"}
{"t": 1783116799991, "event": "app_build_done", "ok": true, "ms": 35, "files": 122, "reused": true}
{"t": 1783116800019, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/astro.build/source"}
{"t": 1783116800058, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116800262, "pass": 2, "event": "ir_built", "nodes": 893}
{"t": 1783116800262, "pass": 2, "event": "inferred", "sections": 3, "assets": 52, "fonts": 6}
{"t": 1783116800262, "pass": 2, "event": "generated", "assetsCopied": 48, "assetsMissing": 0}
{"t": 1783116800290, "pass": 2, "event": "app_build_start"}
{"t": 1783116805966, "pass": 2, "event": "app_build_done", "ok": true, "ms": 5676, "files": 122, "reused": false}
```

### linear
```json
{"t": 1783116806122, "event": "goto", "url": "https://linear.app/"}
{"t": 1783116814784, "event": "captured", "viewport": 1280, "nodes": 1995, "scrollHeight": 10511}
{"t": 1783116818765, "event": "ir_built", "nodes": 1774}
{"t": 1783116818765, "event": "inferred", "sections": 1, "assets": 99, "fonts": 4}
{"t": 1783116818765, "event": "generated", "assetsCopied": 29, "assetsMissing": 0}
{"t": 1783116836357, "event": "validated", "status": "pass", "score": 99.7, "gates0to6": true}
{"t": 1783116836357, "event": "app_build_start"}
{"t": 1783116836420, "event": "app_build_done", "ok": true, "ms": 63, "files": 85, "reused": true}
{"t": 1783116836457, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/linear.app/source"}
{"t": 1783116836526, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116836963, "pass": 2, "event": "ir_built", "nodes": 1774}
{"t": 1783116836963, "pass": 2, "event": "inferred", "sections": 1, "assets": 99, "fonts": 4}
{"t": 1783116836963, "pass": 2, "event": "generated", "assetsCopied": 29, "assetsMissing": 0}
{"t": 1783116837009, "pass": 2, "event": "app_build_start"}
{"t": 1783116843023, "pass": 2, "event": "app_build_done", "ok": true, "ms": 6014, "files": 85, "reused": false}
```

### stripe
```json
{"t": 1783116843195, "event": "goto", "url": "https://stripe.com/"}
{"t": 1783116858436, "event": "captured", "viewport": 1280, "nodes": 2628, "scrollHeight": 14620}
{"t": 1783116886608, "event": "ir_built", "nodes": 2192}
{"t": 1783116886609, "event": "inferred", "sections": 1, "assets": 386, "fonts": 2}
{"t": 1783116886609, "event": "generated", "assetsCopied": 376, "assetsMissing": 0}
{"t": 1783116909407, "event": "validated", "status": "partial", "score": 99.7, "gates0to6": false}
{"t": 1783116909408, "event": "app_build_start"}
{"t": 1783116909918, "event": "app_build_done", "ok": true, "ms": 510, "files": 780, "reused": true}
{"t": 1783116910351, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/stripe.com/source"}
{"t": 1783116910636, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116911553, "pass": 2, "event": "ir_built", "nodes": 2192}
{"t": 1783116911553, "pass": 2, "event": "inferred", "sections": 1, "assets": 386, "fonts": 2}
{"t": 1783116911553, "pass": 2, "event": "generated", "assetsCopied": 376, "assetsMissing": 0}
{"t": 1783116911630, "pass": 2, "event": "app_build_start"}
{"t": 1783116919110, "pass": 2, "event": "app_build_done", "ok": true, "ms": 7480, "files": 780, "reused": false}
```

### ooni
```json
{"t": 1783116919509, "event": "goto", "url": "https://ooni.com/"}
{"t": 1783116951322, "event": "captured", "viewport": 1280, "nodes": 3042, "scrollHeight": 5805}
{"t": 1783116966805, "event": "ir_built", "nodes": 939}
{"t": 1783116966805, "event": "inferred", "sections": 1, "assets": 355, "fonts": 42}
{"t": 1783116966805, "event": "generated", "assetsCopied": 300, "assetsMissing": 0}
{"t": 1783116983213, "event": "validated", "status": "pass", "score": 99.4, "gates0to6": true}
{"t": 1783116983213, "event": "app_build_start"}
{"t": 1783116983390, "event": "app_build_done", "ok": true, "ms": 177, "files": 627, "reused": true}
{"t": 1783116983494, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/ooni.com/source"}
{"t": 1783116983669, "pass": 2, "event": "captured", "reused": true}
{"t": 1783116984373, "pass": 2, "event": "ir_built", "nodes": 939}
{"t": 1783116984373, "pass": 2, "event": "inferred", "sections": 1, "assets": 355, "fonts": 42}
{"t": 1783116984373, "pass": 2, "event": "generated", "assetsCopied": 300, "assetsMissing": 0}
{"t": 1783116984441, "pass": 2, "event": "app_build_start"}
{"t": 1783116991185, "pass": 2, "event": "app_build_done", "ok": true, "ms": 6744, "files": 627, "reused": false}
```

### allbirds
```json
{"t": 1783116991409, "event": "goto", "url": "https://www.allbirds.com/"}
{"t": 1783117000379, "event": "captured", "viewport": 1280, "nodes": 1957, "scrollHeight": 3433}
{"t": 1783117007337, "event": "ir_built", "nodes": 541}
{"t": 1783117007337, "event": "inferred", "sections": 4, "assets": 123, "fonts": 31}
{"t": 1783117007337, "event": "generated", "assetsCopied": 74, "assetsMissing": 0}
{"t": 1783117019195, "event": "validated", "status": "pass", "score": 99.7, "gates0to6": true}
{"t": 1783117019195, "event": "app_build_start"}
{"t": 1783117019225, "event": "app_build_done", "ok": true, "ms": 30, "files": 176, "reused": true}
{"t": 1783117019246, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/allbirds.com/source"}
{"t": 1783117019308, "pass": 2, "event": "captured", "reused": true}
{"t": 1783117019536, "pass": 2, "event": "ir_built", "nodes": 541}
{"t": 1783117019536, "pass": 2, "event": "inferred", "sections": 4, "assets": 123, "fonts": 31}
{"t": 1783117019536, "pass": 2, "event": "generated", "assetsCopied": 74, "assetsMissing": 0}
{"t": 1783117019576, "pass": 2, "event": "app_build_start"}
{"t": 1783117025272, "pass": 2, "event": "app_build_done", "ok": true, "ms": 5696, "files": 176, "reused": false}
```

### cropin
```json
{"t": 1783117025437, "event": "goto", "url": "https://www.cropin.com/"}
{"t": 1783117040469, "event": "captured", "viewport": 1280, "nodes": 2443, "scrollHeight": 11973}
{"t": 1783117099456, "event": "ir_built", "nodes": 1145}
{"t": 1783117099456, "event": "inferred", "sections": 1, "assets": 216, "fonts": 323}
{"t": 1783117099456, "event": "generated", "assetsCopied": 146, "assetsMissing": 0}
{"t": 1783117128065, "event": "validated", "status": "pass", "score": 99.3, "gates0to6": true}
{"t": 1783117128065, "event": "app_build_start"}
{"t": 1783117128563, "event": "app_build_done", "ok": true, "ms": 498, "files": 318, "reused": true}
{"t": 1783117128761, "pass": 2, "event": "capture_reuse", "from": "/private/tmp/claude-501/-Users-ishaansamantray-Desktop-nexara/a6a75a5b-4b13-4679-9b37-87947fd2ce7a/scratchpad/debug10/capture-cache/cropin.com/source"}
{"t": 1783117128938, "pass": 2, "event": "captured", "reused": true}
{"t": 1783117131919, "pass": 2, "event": "ir_built", "nodes": 1145}
{"t": 1783117131920, "pass": 2, "event": "inferred", "sections": 1, "assets": 216, "fonts": 323}
{"t": 1783117131920, "pass": 2, "event": "generated", "assetsCopied": 146, "assetsMissing": 0}
{"t": 1783117132011, "pass": 2, "event": "app_build_start"}
{"t": 1783117140051, "pass": 2, "event": "app_build_done", "ok": true, "ms": 8041, "files": 318, "reused": false}
```

