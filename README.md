# ishaans-ditto-site

[![CI](https://github.com/devteamaegis/ishaans-ditto-site/actions/workflows/ci.yml/badge.svg)](https://github.com/devteamaegis/ishaans-ditto-site/actions/workflows/ci.yml)
[![License: MIT](LICENSE)](LICENSE)
[![Node](.nvmrc)](.nvmrc)

Deterministic website compiler fork of [ditto.site](https://github.com/ion-design/ditto.site). A public URL becomes a self-contained TypeScript app: capture what the browser actually rendered, then emit a byte-stable Next.js App Router project (or Vite React when requested).

The compiler is not an LLM page author. It is a capture-to-code pipeline — same frozen `source/` in, byte-identical `generated/` out.

Read the evaluation method in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) and the July 2026 debug bench in [docs/debug-bench-2026-07-03.md](docs/debug-bench-2026-07-03.md).

## What's different from upstream ditto.site

| Capability | Description |
|------------|-------------|
| **Dual deliverable** | Generated Next.js app at `/` plus static HTML mirror at `/static/` |
| **Frozen live witness** | `source/evidence/live-witness/` — HTML, DOM, screenshots captured once; gates never re-hit production |
| **Extended gates** | HTML witness (2b), DOM witness triangle (3b/3c), manifest hash (6b), responsive probes, visual audit |
| **Lottie replay** | Captured animation JSON → `DittoLottie` client component; static frame for gates |
| **Layout repair** | Post-gate loop recentres fixed columns with uniform horizontal drift (`layout-repair.json`) |
| **Pattern catalog** | SHA256-pinned `compiler/data/pattern-catalog.json` drives capture recipes and generation fix bundles |
| **Benchmark profiles** | `profiles/` for cropin.com, onni.com, everlastingcomfort.com acceptance tiers |

## Usage

### Local CLI

```bash
git clone https://github.com/devteamaegis/ishaans-ditto-site.git
cd ishaans-ditto-site

npm ci
npx playwright install chromium
cd compiler/.harness && npm ci && cd ../..

CATALOG_ONLY_HINTS=true npm run typecheck
CATALOG_ONLY_HINTS=true npm test
```

Clone a site (capture + generate + optional validate):

```bash
cd compiler
CATALOG_ONLY_HINTS=true npm run clone -- https://example.com/ --runs=../runs --viewports=1280 --validate
```

Output lands under `runs/<host>/<timestamp>/generated/app/`.

Common variants:

```bash
npm run clone -- https://example.com/ --viewports=375,768,1280,1920 --interactions --motion --validate
npm run regen -- ../runs/example.com/<timestamp>   # regenerate from frozen capture
npm run bench -- --tier=easy --limit=3 --runs=../runs/bench
```

### Local REST API + UI

Quick inline mode (no database):

```bash
npm ci
npx playwright install chromium

PORT=8899 npm run dev:api
```

Open `http://localhost:8899/` for the clone UI, or call the REST API:

```bash
curl -sS -X POST "http://localhost:8899/v1/clones" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single","styling":"tailwind","framework":"next"}}'
```

Poll progress:

```bash
curl -sS "http://localhost:8899/v1/clones/<jobId>/events?after=0"
curl -sS "http://localhost:8899/v1/clones/<jobId>"
```

Browse the built clone: `http://localhost:8899/v1/clones/<jobId>/app-preview/`

### Queued service (Postgres + worker)

```bash
docker compose up -d
cp .env.example .env

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ditto_site npm run db:migrate

npm run dev:api
npm run dev:worker
```

The worker persists pipeline events to `job_events` and serves them via `GET /v1/clones/:id/events`.

## REST endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/clones` | Start a clone |
| `GET` | `/v1/clones/:id` | Job status and metadata |
| `GET` | `/v1/clones/:id/events` | Pipeline progress events |
| `GET` | `/v1/clones/:id/result` | Eager file map |
| `GET` | `/v1/clones/:id/files/*` | Stream one generated file |
| `GET` | `/v1/clones/:id/app-preview/*` | Browsable built clone |
| `GET` | `/v1/clones/:id/bundle?format=tgz` | Download the whole app |
| `DELETE` | `/v1/clones/:id` | Delete clone artifacts |

MCP endpoint (when enabled): `http://localhost:8899/mcp`

## What you get

A generated app includes:

- Runnable Next.js or Vite React project with Tailwind utilities (default) or semantic CSS
- Reconstructed pages, optional extracted components, and section modules
- Captured assets, fonts, icons, robots/sitemap/llms.txt, JSON-LD when discoverable
- `ditto/` runtime helpers: tabs, accordions, menus, `DittoMotion`, `DittoLottie`
- Static mirror at `/static/` for diff-friendly HTML
- Generated `AGENTS.md` and `ARCHITECTURE.md` handoff docs

Delivery output: `generated/app/` during validation; `runs/<site>/<timestamp>/generated/app` for CLI runs.

## How it works

```
Live URL
  → capture (Playwright, settle recipe, lazy sweep, Lottie/motion/interactions)
  → normalize IR + frozen evidence/live-witness/
  → infer (sections, tokens, recipes, pattern catalog)
  → generate (Next.js + mirror, optional components)
  → validate (gates 0–6 + witness + perceptual + layout repair loop)
  → service layer (REST + UI + optional Postgres queue)
```

**Determinism contract:** same frozen `source/` ⇒ byte-identical `generated/` (Gate 6). No `Date.now` / `Math.random` in generate/infer. Validation never re-fetches live URLs.

For service API details see [docs/SERVICE.md](docs/SERVICE.md). For deployment see [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository map

| Path | Purpose |
|------|---------|
| `compiler/` | Capture, inference, generation, validation, benchmarks |
| `packages/core/` | Compiler adapter, clone job runner, app preview |
| `packages/api/` | Hono REST API, MCP, web UI |
| `packages/db/` | Drizzle schema, migrations, repository, queue |
| `packages/storage/` | Local and S3/R2 artifact storage |
| `packages/worker/` | Queued clone runner |
| `docs/` | Methodology, service, deployment, debug benches |
| `profiles/` | Site-specific acceptance profiles |
| `examples/` | Benchmark results and visual evidence |
| `docker/` | Compose stack for Postgres + MinIO + api/worker |

## Responsible use

Use only where you have the right to inspect, copy, transform, and operate on the target content. Do not use for phishing, impersonation, credential capture, or bypassing access controls.

See [docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md).

## Contributing

```bash
npm ci
npx playwright install chromium
cd compiler/.harness && npm ci && cd ../..
CATALOG_ONLY_HINTS=true npm run typecheck
CATALOG_ONLY_HINTS=true npm test
```

Browser tests require Chromium. Postgres-backed tests use `TEST_DATABASE_URL` or the local compose stack. Changes that alter compiler output should include a focused fixture or benchmark note.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT © ion-design and contributors. See [LICENSE](LICENSE).
