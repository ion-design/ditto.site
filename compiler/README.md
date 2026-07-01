# ditto.site Compiler

This workspace contains the deterministic compiler used by ditto.site. It captures
a source URL, builds a render IR, infers assets/fonts/tokens/sections/recipes/SEO,
generates a Next.js App Router app by default or a Vite React app on request, and
validates the result with deterministic gates.

The full architecture overview lives in [../README.md](../README.md). This file
keeps only compiler-local commands and notes.

## Commands

```bash
cd compiler
npm install
npx playwright install chromium

npm run clone -- https://example.com/
npm run clone -- https://example.com/ --mode=multi --styling=tailwind
npm run clone -- https://example.com/ --mode=single --framework=vite
npm run clone-site -- https://example.com/
npm run validate-site -- ../runs/site-example.com/<timestamp>
npm run clone -- https://example.com/ --mode=multi --concurrency=5
npm run clone -- https://example.com/ --mode=multi --validate --validate-concurrency=3 --viewport-concurrency=2
npm run validate-site -- ../runs/site-example.com/<timestamp> --validate-concurrency=3 --viewport-concurrency=2
npm run bench -- --tier=easy
npm run bench-site
npm run quality -- ../runs/example.com/<timestamp>
npm run audit -- ../runs/example.com/<timestamp>
npm test
npm run typecheck
```

Root-level scripts forward to these commands, so `npm run clone -- <url>` works
from the repository root too.

Multi-page generation defaults to the fast no-validation path. Use `--validate`
when the clone command itself should run the full build/render/gates QA pass, or
run `validate-site` separately. `--concurrency` controls source route capture;
`--validate-concurrency` controls how many routes validation grades at once; and
`--viewport-concurrency` controls how many clone viewports each route renders at
once.

## Generated App Shape

Default Next generated apps use `src/app/ditto.css` and optional helpers under
`src/app/ditto/`. Vite generated apps use `src/ditto.css` and optional helpers
under `src/ditto/`, with multi-route pages under `src/routes/`. Validation builds
keep `data-cid` attributes for source/clone alignment; delivered apps strip those
validation ids and keep only required `data-ditto-id` anchors.
