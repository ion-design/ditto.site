# ditto.site Service — REST + MCP API

A hosted service layer around the deterministic compiler in [`compiler/`](../compiler):
**`POST a URL → get back the generated app as a file map`**, over both a REST
API and an MCP server, with a Postgres-backed job queue, result caching, and S3/R2
blob storage. The compiler's clone semantics are unchanged — this only wraps it.

See the root [`README.md`](../README.md) for the compiler architecture and
[`DEPLOY.md`](DEPLOY.md) for production deployment.

## Architecture (monorepo / npm workspaces)

```
compiler/            # the deterministic compiler (unchanged) + a src/index.ts library barrel
packages/
  core/              # the ONLY package that imports the compiler:
                     #   runCloneJob() (temp dir → clone → [verify] → file map), collectFileMap(), cacheKey()
  db/                # Drizzle schema + migrations + repo + pg-boss queue wrapper
  storage/           # ArtifactStore: LocalArtifactStore (disk) | ObjectArtifactStore (S3/R2); tgz/zip bundles
  api/               # Hono app: REST routes + MCP (Streamable-HTTP) + auth/rate-limit/SSRF
  worker/            # queue consumer: dequeue → runCloneJob → store artifacts → persist; verify harness
  test-utils/        # shared test helpers (fixture server, Chromium probe, ephemeral Postgres)
```

Two run modes, same HTTP surface:

- **In-memory (no `DATABASE_URL`)** — `POST` enqueues (202) and runs the clone in the
  background within the API process, holding results in memory. Handy for a quick
  local demo; same poll-to-completion contract as production.
- **DB + queue (`DATABASE_URL` set)** — `POST` enqueues a job (202); a separate
  **worker** process consumes the queue, runs the clone, stores artifacts, and the
  client polls to completion. This is the production mode.

In both modes the job emits structured progress events as it runs — the compiler's
granular log stream (`{ event: "captured", ... }`, `{ event: "generated", ... }`,
`{ event: "build_start", ... }`, etc.) plus service phases (`{ event: "clone_done" }`,
`{ event: "clone_error", error }`). Every event carries a millisecond wall-clock
timestamp `t`; the rest of each object is the payload the emitter logged, so field sets
vary by event. There is no fixed enum of event types — treat unknown `event` strings as
opaque progress and drive UI off the coarse job `status` from `GET /v1/clones/:id`.

Poll `GET /v1/clones/:id/events?after=N` → `{ jobId, events: [{ t, ... }] }`. `after` is a
**sequence cursor** (a 1-based event count, not a timestamp): pass the number of events
you have already consumed to get only newer ones. Caveats:

- The returned event bodies do **not** include the `seq` value, so track the cursor
  yourself as a running count of events received.
- The in-memory backend **ignores `after`** and returns the full list on every poll — so
  in that mode you always get all events and must de-duplicate by count. The DB backend
  honors `after` (`seq > N`).

In production (DB) mode events persist in the `job_events` table (migration
`0002_productive_wallflower.sql`) with a per-job `seq`, so they survive worker restarts
and remain readable after completion.

## Local development

```bash
# 1. start Postgres + MinIO
docker compose up -d

# 2. install + migrate
npm install
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ditto_site npm run db:migrate

# 3. run the API + a worker (two terminals), pointing at the local stack
cp .env.example .env   # then edit
DATABASE_URL=... S3_BUCKET=ditto-site-artifacts S3_ENDPOINT=http://localhost:9000 \
  S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin S3_FORCE_PATH_STYLE=true \
  npm run dev:api
# ... and the worker with the same env:
... npm run dev:worker

# Or, fully containerized:
docker compose --profile app up --build
```

Quick demo without a DB (inline single-page clone):

```bash
SSRF_ALLOW_LOOPBACK=true npm run dev:api    # then:
curl -s -X POST localhost:8787/v1/clones -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","options":{"mode":"single","styling":"tailwind"}}' | jq '.files | keys'
```

To turn that `files` map into a project on disk, pipe the response into the
repo-local `ditto` CLI (`packages/cli`) instead of inspecting the JSON by hand:

```bash
curl -s -X POST localhost:8787/v1/clones -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}' \
  | npm run --silent unpack -- - ./out
# binary assets: set DITTO_API_URL (and DITTO_API_KEY when authenticated) so the
# CLI can fetch each file's reference URL; --no-fetch writes only the text tree.
```

The CLI package is intentionally private for now; run this command from a
checked-out `ditto.site` repo with dependencies installed. Do not use
`npx ditto` until this package is published.

## REST surface

```
POST   /v1/clones                 { url, options? }  → 202 {jobId,status} | 200 {cached result | inline result}
POST   /v1/signup                 { email, label? } → 201 {apiKey,message}  (direct public signup when enabled)
POST   /v1/signup/request         { email } → 202 {message}                 (send verification email)
POST   /v1/signup/verify          { token } → 201 {apiKey,message}          (consume email token)
GET    /v1/clones                  → list (metadata)
GET    /v1/clones/:id              → status + metadata (fileCount, totalBytes, capture, timings)
GET    /v1/clones/:id/events?after=N → { jobId, events } — progress events after cursor N (poll while running)
GET    /v1/clones/:id/result       → the eager CloneResult (text files inline; binaries by URL)
GET    /v1/clones/:id/files/*      → stream one generated file (e.g. .../files/preview.html — see Preview)
GET    /v1/clones/:id/app-preview/*  → serve the clone's built static export when present (404 until built)
GET    /v1/clones/:id/bundle?format=tgz|zip  → the whole app as one archive (302 → S3 when configured)
DELETE /v1/clones/:id              → purge artifacts
GET    /healthz                    → { ok: true }  (unauthenticated)
```

`/v1/clones*` and `/mcp` are authenticated when `API_KEYS` is set or DB-backed
keys exist. Use `Authorization: Bearer <key>` or `x-api-key: <key>`.

> **Treat keys as secrets.** In any snippet you copy or share, template the key as
> an environment variable (`Authorization: Bearer $DITTO_API_KEY`) rather than an
> inline `dtto_live_...` token — inline keys leak into shell history, logs, and
> pasted transcripts. Never commit a key; rotate a leaked one from the dashboard.
Signup routes are intentionally public only when `SIGNUP_ENABLED=true` **and**
`DATABASE_URL` is set. Direct `POST /v1/signup` mints a `dtto_live_...` key
immediately when `SIGNUP_DIRECT_ENABLED=true`. For public production signup,
prefer the Resend-backed verified flow: `POST /v1/signup/request` sends a
one-time email link, and `POST /v1/signup/verify` consumes the token, stores
only the API key's SHA-256 hash in Postgres, stores the verified email in the
key label for attribution, and returns the raw key once.

Normal product `options` are `{ mode?: "single" | "multi", styling?: "tailwind" | "css", framework?: "next" | "vite", preview?: boolean }`.
`mode` defaults to `"single"`, `styling` defaults to `"tailwind"`, and `framework` defaults to `"next"`. `preview`
controls the browsable built export served at `/v1/clones/:id/app-preview/` (see **Preview** below); it is on by
default for single-page clones, so pass `preview:true` to force it for a multi-page clone. Operational options
remain `{ verify?, asyncVerify?, maxRoutes?, maxCollection?, captureConcurrency?, validationConcurrency?, viewportConcurrency?, noCache? }`; `noCache` is service-level and
bypasses the cache. Deprecated aliases (`multiPage`, `humanizeMode`) and dev-only escape
hatches are still accepted for compatibility, but are not part of the normal product surface.
`Cache-Control: no-cache` is honored as an alias.

For fast production responses, keep `verify:false` on the delivery job. The service skips
validation-only full-page screenshots in that mode. When `verify:true`, multi-page validation
can render routes and viewports concurrently with `validationConcurrency` and
`viewportConcurrency`; source route capture concurrency is controlled by `captureConcurrency`.
When running with the DB worker, `asyncVerify:true` persists the clone result first and then
attaches the verify report afterward while the worker still has the run artifacts. This is the
current async QA path; a post-hoc verify endpoint would require persisting full capture artifacts,
not just the generated app bundle.

## Preview

Every clone emits a flat, self-contained **`preview.html`** at generate time — it is a
regular entry in the result file map (path `preview.html`, at the app root), and the
manifest records it as `preview_html: "preview.html"` (always present). It exists as soon
as the compiler's `generate` step finishes emitting the file map — well before any Next
build or deploy — so a consumer can show the cloned page within seconds. Its arrival is
visible in the event stream as a `{ event: "generated", ... }` event.

Fetch it through the ordinary files route:

```bash
curl -sS -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID/files/preview.html" -o preview.html
```

**What it is — and isn't.** `preview.html` is a single HTML file with inline CSS and **no
JavaScript** (no runtime scripts). It renders the captured page statically: animations are
frozen at their captured start frame, Lottie/`<video>` mounts show their captured
poster/first-frame still, and nothing is interactive — no menus, no hover, no scroll
effects. It is a faithful *picture* of the page, not a working app. For interaction, use the
built export (`/v1/clones/:id/app-preview/`) or the deployed app.

**Relative assets.** `preview.html` references its images and fonts with relative paths
(`public/assets/cloned/...`), so those sub-paths resolve against the same files route the
HTML itself came from (`/v1/clones/:id/files/public/assets/cloned/...`). Serve or proxy the
file under that mount and the assets load with no rewriting.

**Iframe auth caveat.** Because the files route is authenticated (when `API_KEYS`/DB keys
are set), you cannot drop `.../files/preview.html` straight into an `<iframe src=...>` — the
browser can't attach your `Authorization` header to the iframe's asset sub-requests, so
images and fonts 404. Front it with a small server-side proxy that injects the key and
re-serves both the HTML and its `public/assets/...` sub-paths from your own origin, then
point the iframe at the proxy.

**Intended staging.** The preview is the middle rung of a three-step reveal for a consumer
UI: show the **original site** first (instant), swap to **`preview.html`** the moment
`generate` finishes (seconds — a static, frozen likeness), then swap to the **deployed app**
once the build + deploy completes (fully interactive).

**Incremental clone (single → multi, for speed).** Clone one URL single-page first
(fast app back), then POST the **same URL** with `{ mode: "multi" }` — the second call
reuses the first's entry capture (no re-capture of page 1), crawls + captures only the
remaining routes, and regenerates the whole site on top (shared chrome / tokens /
components preserved). The result carries `captureReused: true` when this fired. Backed
by a persistent per-URL capture cache (`CAPTURE_CACHE_DIR`, default on under
`local-data/`; staleness bounded by the cache TTL). The two calls have distinct cache
keys (single vs multi), so neither shadows the other.

## MCP surface (Streamable-HTTP at `/mcp`)

List-then-read so a clone never floods the agent's context:

- `clone_website({ url, options })` → `{ jobId, status }` (returns immediately).
- `get_clone_status({ jobId })` → `{ status, timings, capture }`.
- `get_clone_result({ jobId })` → **metadata only** (routes, verify summary, capture, fileCount, totalBytes, bundleUrl).
- `list_clone_files({ jobId, glob?, route?, cursor?, limit? })` → manifest `[{path,type,bytes,sha256}]`, no content.
- `read_clone_files({ jobId, paths[], maxBytes? })` → contents for specific files (text inline; binaries as URLs; per-call size budget).
- `get_clone_bundle({ jobId, format? })` → a download reference `{ url, format, bytes, sha256 }` (not bytes).
- `list_clones()` / `cancel_clone({ jobId })`.

## Environment reference

| Var | Used by | Default | Notes |
|---|---|---|---|
| `PORT` | api | `8787` | |
| `DATABASE_URL` | api, worker | — | set ⇒ async DB+queue mode |
| `ARTIFACTS_DIR` | worker, api | `./local-data/artifacts` | local blob root (when not using S3) |
| `CACHE_STALE_AFTER` | worker | `24h` | cache TTL (`ms/s/m/h/d`; `0` disables) |
| `HARNESS_DIR` | worker | `./local-data/harness` | per-worker Next/Vite build harness (verify) |
| `CAPTURE_CACHE_DIR` | worker, api | `./local-data/capture-cache` | per-URL entry-capture cache for the single→multi reuse path (`""` disables) |
| `VERIFY_TIER` | worker | `stage2` | perceptual gate tier for verify |
| `PUBLIC_BASE_URL` | api | — | absolute base for MCP-returned URLs |
| `API_KEYS` | api | — | comma-separated keys; empty = open |
| `RATE_LIMIT_PER_MINUTE` | api | `0` | per key/IP cap (0 = unlimited) |
| `SIGNUP_ENABLED` | api | `false` | DB mode only: expose public API-key signup routes |
| `SIGNUP_RATE_LIMIT_PER_HOUR` | api | `3` | per-IP signup cap; `0` disables signup throttling |
| `DEFAULT_SIGNUP_KEY_RATE_LIMIT` | api | `30` | stored on keys minted by signup; service-wide enforcement still uses `RATE_LIMIT_PER_MINUTE` |
| `SIGNUP_DIRECT_ENABLED` | api | `true` | keep direct `POST /v1/signup` enabled; set `false` when Resend verification is configured |
| `RESEND_API_KEY` | api | — | enables verified-email signup request/verify endpoints |
| `SIGNUP_FROM_EMAIL` | api | — | verified sender, e.g. `Ditto <hello@ditto.site>` |
| `SIGNUP_VERIFY_URL` | api | — | landing-page URL that receives `?token=...`, e.g. `https://www.ditto.site/api-key` |
| `SIGNUP_TOKEN_TTL_MINUTES` | api | `30` | one-time email verification token lifetime |
| `SIGNUP_CORS_ORIGINS` | api | `https://ditto.site,https://www.ditto.site` | comma-separated browser origins allowed to call public signup routes |
| `SSRF_DISABLE` | api | `false` | turn off the SSRF guard (not recommended) |
| `SSRF_ALLOW_LOOPBACK` | api | `false` | allow cloning localhost (local dev) |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` / `S3_PUBLIC_URL` | api, worker | — | set `S3_BUCKET` ⇒ object storage |

## Testing

`npm test` runs all workspace suites (node:test via tsx). Tests gate themselves on
their dependencies: browser tests skip without Chromium (`npx playwright install
chromium`), Postgres tests use `TEST_DATABASE_URL` or a throwaway local Postgres
(root only). The compiler's byte-determinism (Gate 6) makes the golden-file tests
exact.
