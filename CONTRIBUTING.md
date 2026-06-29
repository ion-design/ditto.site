# Contributing

Thanks for your interest! This repo is a deterministic website **compiler**
(`compiler/`) plus a hosted **service layer** (`packages/`). The benchmarks and
fixtures double as the regression suite.

## Setup

```bash
npm install                      # installs all workspaces
npx playwright install chromium  # for capture / browser-gated tests
```

## Develop

- **Service layer** lives in `packages/*` (TypeScript, run via `tsx`, no build step).
  - `npm run typecheck` — type-checks every workspace.
  - `npm test` — runs every workspace's tests (node:test). Tests gate themselves:
    browser tests skip without Chromium; Postgres tests use `TEST_DATABASE_URL` or a
    throwaway local Postgres (root only).
  - Start locally: `docker compose up -d` then `npm run dev:api` / `npm run dev:worker`
    (see [`docs/SERVICE.md`](docs/SERVICE.md)).
- **Compiler** lives in `compiler/`. See the root [`README.md`](README.md) for the
  architecture overview.
  The service layer depends on it **only** through `compiler/src/index.ts` (the
  library barrel) — do not import compiler internals from `packages/*`.

## Ground rules

- **Don't change the compiler's clone semantics** from the service layer. The
  service is a wrapper; clone output must stay byte-deterministic (rubric Gate 6).
  Golden-file tests rely on this.
- Every change should keep `npm run typecheck` and `npm test` green.
- Database schema changes: edit `packages/db/src/schema.ts`, then
  `npm run db:generate` to produce a migration, and commit it.
- Keep new code in the style of the surrounding code (naming, comments, idiom).

## Database migrations

```bash
npm run db:generate   # after editing the Drizzle schema → writes packages/db/migrations/*
npm run db:migrate    # applies to $DATABASE_URL
```

## Pull requests

1. Fork / branch off `main`.
2. Make your change with tests; keep `npm run typecheck` and `npm test` green.
3. Open a PR and fill in the [PR template](.github/pull_request_template.md). CI
   (typecheck + the full suite, with Postgres + Chromium) must pass.
4. If your change touches the deterministic compiler's clone output, say so and
   include benchmark results (`npm run bench`).

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs & security issues

- **Bugs / features:** open an issue using the templates.
- **Security vulnerabilities:** do **not** open a public issue — follow
  [`SECURITY.md`](SECURITY.md) (private GitHub advisory).
