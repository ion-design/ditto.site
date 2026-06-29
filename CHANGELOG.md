# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0,
so minor/patch semantics are not yet guaranteed.

## [Unreleased]

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
