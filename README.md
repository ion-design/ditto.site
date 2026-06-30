<p align="center">
  <img src="docs/assets/ditto.svg" alt="ditto.site logo" width="112" />
</p>

# [ditto.site](https://ditto.site)

[![CI](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml/badge.svg)](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

ditto.site turns a public URL into a self-contained TypeScript app. It captures
what the browser actually rendered, then emits a deterministic Next.js App
Router project by default, or Vite React when requested.

The compiler is not an LLM page author. It is a capture-to-code pipeline: same
frozen capture in, byte-stable app out.

Read the public development and evaluation method in
[docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Usage

- REST API: `https://api.ditto.site`
- MCP server: `https://api.ditto.site/mcp`

Get a hosted key at `https://www.ditto.site/api-key`, or call the verified-email
signup flow directly:

```bash
curl -sS -X POST "https://api.ditto.site/v1/signup/request" \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com"}'
```

The emailed verification link lands on `/api-key?token=...`, which calls
`POST /v1/signup/verify` and displays the new `dtto_live_...` key once.

### REST API

Start a clone job:

```bash
export DITTO_API_URL="https://api.ditto.site"
export DITTO_API_KEY="ditto_live_example"

curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/",
    "options": {
      "mode": "single",
      "styling": "tailwind",
      "framework": "next"
    }
  }'
```

The service returns either an inline result or a queued job:

```json
{ "jobId": "job_123", "status": "queued" }
```

Poll and download the generated app:

```bash
JOB_ID="job_123"

curl -sS -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID"

curl -L -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID/bundle?format=tgz" \
  -o ditto-clone.tgz
```

Useful options:

| Option | Values | Default |
| --- | --- | --- |
| `mode` | `single`, `multi` | `single` |
| `styling` | `tailwind`, `css` | `tailwind` |
| `framework` | `next`, `vite` | `next` |
| `verify` | `true`, `false` | `false` |
| `asyncVerify` | `true`, `false` | `false` |
| `maxRoutes` | number | service default |

REST endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/clones` | Start a clone |
| `GET` | `/v1/clones/:id` | Read job status and metadata |
| `GET` | `/v1/clones/:id/result` | Read the eager file map |
| `GET` | `/v1/clones/:id/files/*` | Stream one generated file |
| `GET` | `/v1/clones/:id/bundle?format=tgz` | Download the whole app |
| `DELETE` | `/v1/clones/:id` | Delete a clone and its artifacts |

### MCP

Connect an MCP client to the hosted Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "ditto": {
      "url": "https://api.ditto.site/mcp",
      "headers": {
        "Authorization": "Bearer ${DITTO_API_KEY}"
      }
    }
  }
}
```

The MCP server is designed for agents. It returns job ids, metadata, manifests,
and file references first, then lets the agent read only the files it needs.

Core MCP tools:

| Tool | Purpose |
| --- | --- |
| `clone_website` | Start a clone and return `{ jobId, status }` |
| `get_clone_status` | Poll job progress |
| `get_clone_result` | Read result metadata without file contents |
| `list_clone_files` | List generated file paths, sizes, and hashes |
| `read_clone_files` | Read selected text files or binary URLs |
| `get_clone_bundle` | Get a download URL for the generated app |

Example agent prompt:

```text
Use the ditto MCP server to clone https://example.com as a Next.js app.
Wait for the job to finish, list the generated files, then read package.json,
src/app/page.tsx, and src/app/ditto.css.
```

### Local CLI

```bash
git clone https://github.com/ion-design/ditto.site.git
cd ditto.site

npm ci
npx playwright install chromium

npm run clone -- https://example.com/ --out=./output
```

The generated app lands under `output/<site>/app`.

Common local variants:

```bash
npm run clone -- https://example.com/ --mode=multi
npm run clone -- https://example.com/ --styling=css
npm run clone -- https://example.com/ --framework=vite
npm run validate-site -- runs/site-example.com/<timestamp>
```

### Local REST And MCP Service

Quick inline mode, with no database:

```bash
npm ci
npx playwright install chromium

SSRF_ALLOW_LOOPBACK=true npm run dev:api
```

Then call the local REST API:

```bash
curl -sS -X POST "http://localhost:8787/v1/clones" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}'
```

For the queued service with Postgres and MinIO:

```bash
docker compose up -d
cp .env.example .env

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ditto_site \
  npm run db:migrate

npm run dev:api
npm run dev:worker
```

The local MCP endpoint is `http://localhost:8787/mcp`.

## What You Get

A generated app includes:

- a runnable Next.js or Vite React project,
- reconstructed pages and route modules,
- captured assets, fonts, icons, manifest files, and metadata,
- `robots`, `sitemap`, `llms.txt`, and JSON-LD when discoverable,
- small `ditto` runtime helpers for recognized interactions and motion,
- generated `AGENTS.md` and `ARCHITECTURE.md` handoff docs.

Delivery output is under `generated/app/` during validation and under
`<out>/<site>/app` for CLI delivery.

## How It Works

```text
URL
  -> browser capture
  -> normalized render IR
  -> deterministic inference
  -> app generation
  -> asset materialization
  -> optional validation
```

Capture records DOM, computed styles, layout boxes, source metadata, CSS, fonts,
assets, screenshots, interaction states, and reproducible motion where it can be
observed safely. Unsupported app logic, auth, payments, personalization, and
arbitrary third-party JavaScript are not replayed.

For the detailed service API, see [docs/SERVICE.md](docs/SERVICE.md). For
deployment, see [docs/DEPLOY.md](docs/DEPLOY.md). For the development method
behind the compiler, see [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

Hosted deployments should keep `/v1/clones*` and `/mcp` behind API-key auth.
When `SIGNUP_ENABLED=true` in DB mode, the Resend-backed
`POST /v1/signup/request` and `POST /v1/signup/verify` flow can publicly mint
`dtto_live_...` keys from verified email links while storing only key hashes.
Keep `SIGNUP_DIRECT_ENABLED=false` in production unless direct unauthenticated
minting is intentional.

## Repository Map

| Path | Purpose |
| --- | --- |
| `compiler/` | deterministic capture, inference, generation, and validation |
| `packages/core/` | compiler adapter and file-map helpers |
| `packages/api/` | Hono REST API and MCP server |
| `packages/db/` | Drizzle schema, migrations, repository, and queue wrapper |
| `packages/storage/` | local and S3/R2 artifact storage |
| `packages/worker/` | queued clone runner and optional verification |
| `docs/` | methodology, service, deployment, release, and responsible-use docs |
| `examples/` | benchmark results and visual evidence |

## Responsible Use

Use ditto.site only where you have the right to inspect, copy, transform, and
operate on the target content. Do not use it for phishing, impersonation,
credential capture, bypassing access controls, or high-volume third-party
capture without permission.

See [docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md).

## Contributing

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
```

Browser tests require Chromium. Postgres-backed tests use `TEST_DATABASE_URL` or
the local compose stack. Changes that alter compiler output should include a
focused fixture or benchmark note.

The repository is MIT-licensed open source. The npm workspaces are intentionally
marked `private` until the package boundaries are ready for public npm
publishing.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[SUPPORT.md](SUPPORT.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © ion-design and contributors.
