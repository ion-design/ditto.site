<p align="center">
  <img src="docs/assets/ditto.svg" alt="ditto.site logo" width="112" />
</p>

# [ditto.site](https://ditto.site)

[![CI](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml/badge.svg)](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

ditto.site turns a public URL into a self-contained TypeScript app. It captures
what the browser actually rendered, then emits a deterministic Next.js App
Router project by default, or Vite React when requested.

The compiler is not an LLM page author. It is a capture-to-code pipeline: same
frozen capture in, byte-stable app out.

> **"Cloning" here means generating a codebase from a live URL — not `git clone`.**
> You don't need an existing repository, and you don't need the site's source. Point
> ditto.site at a public URL and it writes you a fresh project from what the page
> renders in a browser.

Read the public development and evaluation method in
[docs/METHODOLOGY.md](docs/METHODOLOGY.md). For a map of all the docs, see
[docs/README.md](docs/README.md).

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

> **Keys are secrets.** Put your key in an environment variable (`export
> DITTO_API_KEY=dtto_live_...`) and reference `$DITTO_API_KEY` in every command —
> never paste the raw key inline, where it lands in shell history, logs, or a chat.
> Don't commit it. You can rotate a key anytime from the dashboard.

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

The service returns either a queued job or an inline result. A finished result
is a file map — every generated file keyed by its app-relative path:

```json
{
  "jobId": "job_123",
  "status": "succeeded",
  "files": {
    "package.json": { "type": "text", "content": "{ ... }", "bytes": 812, "sha256": "..." },
    "src/app/page.tsx": { "type": "text", "content": "export default ...", "bytes": 2048, "sha256": "..." },
    "public/assets/logo.png": { "type": "binary", "url": ".../files/public/assets/logo.png", "bytes": 5123, "sha256": "..." }
  }
}
```

**Turn that JSON into a project on disk** with the official unpacker — from a
checked-out `ditto.site` repo with dependencies installed, pipe the response
straight in with no temp file:

```bash
curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}' \
  | npm run --silent unpack -- - ./out
```

`npm run unpack -- <clone.json|-> <out-dir>` writes the text files inline and
materializes binary assets (inline base64, or fetched from their `url` using
`$DITTO_API_URL` / `$DITTO_API_KEY`). The CLI package is repo-local until the
npm distribution story is ready, so do not use `npx ditto` yet. See
[`packages/cli`](packages/cli/README.md) for options.

If you got back a queued job (`{ "jobId": "job_123", "status": "queued" }`),
poll it, then unpack the finished result — or download the whole app as one
archive:

```bash
JOB_ID="job_123"

# poll status, then unpack the finished file map
curl -sS -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID/result" \
  | npm run --silent unpack -- - ./out

# ...or grab the whole app as a single archive
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
# this git clone gets the ditto.site tool itself — the URL you clone into a
# codebase comes later, as the argument to `npm run clone`.
git clone https://github.com/ion-design/ditto.site.git
cd ditto.site

npm ci
npx playwright install chromium

npm run clone -- https://example.com/ --out=./output
```

The generated app lands under `output/<site>/app`. On success the CLI prints a
copy-paste-safe summary — a single quoted `cd … && npm install && npm run dev`
line and pointers to the safe-to-edit files (`src/app/content.ts`,
`src/app/components/`; the app's `AGENTS.md` has the full guide).

To skip the copy-paste entirely and go straight to a running preview:

```bash
npm run clone -- https://example.com/ --serve        # clone, npm install, npm run dev
npm run clone -- https://example.com/ --open         # ...and open the browser too
```

Common local variants:

```bash
npm run clone -- https://example.com/ --mode=multi
npm run clone -- https://example.com/ --styling=css
npm run clone -- https://example.com/ --framework=vite
npm run validate-site -- runs/site-example.com/<timestamp>
```

Without `--out`, runs land under `runs/<site>/<timestamp>/` and a stable
`runs/<site>/latest` symlink always points at the newest clone, so scripts and
`cd` targets don't depend on the timestamp.

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
| `packages/cli/` | `ditto` CLI — unpack a clone result JSON into a project tree |
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
