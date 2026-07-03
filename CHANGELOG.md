# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0,
so minor/patch semantics are not yet guaranteed.

## [Unreleased]

### Changed — Local CLI success output and orientation

- The `clone-static` CLI now prints a copy-paste-safe success summary to stderr: a
  single **quoted** `cd "<app>" && npm install && npm run dev` line (survives terminal
  wrapping — no more broken `cd` from a wrapped timestamped path) plus the key
  `AGENTS.md` safe-to-edit pointers (`src/app/content.ts`, `src/app/components/`). The
  machine-readable `{ "event": "done", ... }` JSON line on stdout is unchanged (now
  also carrying `stableApp`).
- Added `--serve` (run `npm install` + `npm run dev` in the generated app) and
  `--open` (also launch the browser at the dev URL) so "see it locally" is one flag.
- In the default runs layout, each clone now refreshes a `runs/<site>/latest` symlink
  pointing at the newest run, giving a stable, timestamp-free path for `cd` and scripts.

### Added — Docs hub and terminology/secret-hygiene clarifications

- Added [`docs/README.md`](docs/README.md) as a central documentation index.
- Clarified prominently that ditto.site "cloning" means generating a codebase from a
  live URL, **not** `git clone` (no source repo required), in the README and docs hub.
- Added an explicit "API keys are secrets — use `$DITTO_API_KEY`, never inline/commit,
  rotate anytime" note beside the key/auth examples in the README and `docs/SERVICE.md`.

### Added — `ditto` unpack CLI

- **`packages/cli`** — a zero-dependency `ditto` command-line helper. `npm run
  unpack -- <clone.json|-> <out-dir>` turns the `files` map returned by
  `POST /v1/clones` (or `GET /v1/clones/:id/result`) into a real project tree on
  disk: text files written inline, binary assets materialized from inline base64
  or fetched from their reference URL (`$DITTO_API_URL` / `$DITTO_API_KEY`), with
  path-traversal guards and pre-write `sha256` integrity checks. Reads from stdin
  so a `curl` response can be piped straight in. Documented next to the REST
  examples in the README and `docs/SERVICE.md`.

### Added — Open-source readiness

- Added support, release, responsible-use, CODEOWNERS, and gitattributes files.
- Made workspace package metadata explicit for license and repository scanners.
- Tightened contributor and PR checklists around runtime audit, documentation,
  responsible use, and committed artifacts.

### Changed — Generated app dependency templates

- Updated generated Next apps to the current Next 15 line with React 19.
- Updated generated Vite apps to Vite 6.4 with React 19, keeping the generated
  app Node floor compatible with the repo's `>=20` engine policy.

### Added — Service layer (REST + MCP API)

A hosted service around the deterministic compiler, as an npm-workspaces monorepo
(`packages/*`). The compiler's clone behavior is unchanged — only a library boundary
was added.

- **`packages/core`** — the sole compiler adapter: `runCloneJob` (temp-dir lifecycle,
  optional verify), `collectFileMap`, `cacheKey`.
- **`packages/db`** — Drizzle schema + migrations (jobs/clones/cache/apiKeys), repo,
  and a pg-boss queue.
- **`packages/storage`** — `ArtifactStore` (local disk or S3/R2 via presigned URLs),
  deterministic `tgz`/`zip` bundles.
- **`packages/api`** — Hono app: REST routes + MCP (Streamable-HTTP), API-key auth,
  rate limiting, and SSRF protection.
- **`packages/worker`** — queue consumer with isolated per-worker `verify` build
  harness; supports multi-page (`clone_site`) jobs.
- Freshness-bounded caching (`CACHE_STALE_AFTER`, `noCache`), Docker images +
  `docker-compose` (Postgres + MinIO), CI, and Railway/Neon/R2 deploy docs.
- Root CLI passthrough scripts so the compiler CLI runs from the repo root too.

See [`docs/SERVICE.md`](docs/SERVICE.md) and [`README.md`](README.md).

### Changed — Component extraction keeps styling out of the content model

- Extracted components no longer pull per-instance `className` strings into the editable
  content model (`content.ts`). When a node's class varies across instances, the tokens
  common to all instances are baked into the component skeleton and only the per-instance
  **diff** is emitted — to a separate `_styles.ts` plumbing module (alongside `_cids.ts`),
  merged back at render time with a generated `cn()` helper. `content.ts` now holds only
  semantic fields (text, href, src, alt, …). Render-identical (token order doesn't affect
  computed style); gates 0–6 and site/determinism unaffected. Swap `cn` for `tailwind-merge`
  if you want conflict-aware merging when hand-editing the overrides.

### Notes

- The deterministic compiler predates this changelog; the current architecture is
  summarized in [`README.md`](README.md), with operational service details in
  [`docs/SERVICE.md`](docs/SERVICE.md).
