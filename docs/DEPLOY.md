# Deploy — Railway + Neon + R2

The service is two long-lived processes (an **api** and a **worker**) plus managed
Postgres and S3-compatible storage. The recommended OSS-friendly stack:

- **Railway** — hosts the `api` and `worker` services (one Railway service each,
  built from the Dockerfiles in [`docker/`](../docker)).
- **Neon** — managed Postgres (the database *and* the pg-boss queue).
- **Cloudflare R2** (or AWS S3) — blob storage for binary assets + bundles. R2 has
  no egress fees, friendly for forks/self-host.

## 1. Database (Neon)

1. Create a Neon project; copy the pooled connection string.
2. Apply migrations (from CI/CD or locally):
   ```bash
   DATABASE_URL='postgres://...neon.../ditto_site?sslmode=require' npm run db:migrate
   ```
   Run this on every deploy that changes `packages/db/migrations`.

## 2. Blob storage (R2 / S3)

Create a bucket (e.g. `ditto-site-artifacts`) and an access key. Note the S3 API
endpoint (R2: `https://<accountid>.r2.cloudflarestorage.com`).

## 3. Railway services

Create two services in one Railway project, both deploying this repo:

| Service | Dockerfile | Scaling |
|---|---|---|
| `api` | `docker/api.Dockerfile` | light; autoscale on CPU |
| `worker` | `docker/worker.Dockerfile` | scale by queue depth (Playwright image) |

Set these variables on **both** services:

```
DATABASE_URL=postgres://...neon.../ditto_site?sslmode=require
S3_BUCKET=ditto-site-artifacts
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com   # omit for AWS S3
S3_REGION=auto                                             # 'auto' for R2
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

API-only:

```
PORT=8787
PUBLIC_BASE_URL=https://api.yourdomain.com   # so MCP-returned URLs are absolute
API_KEYS=key_live_xxx,key_live_yyy           # require auth
RATE_LIMIT_PER_MINUTE=60
# SSRF is on by default; do NOT set SSRF_ALLOW_LOOPBACK in prod.
```

Worker-only:

```
CACHE_STALE_AFTER=24h
ARTIFACTS_DIR=/data/artifacts   # only used if S3 is not configured
HARNESS_DIR=/data/harness       # isolated build harness for verify
```

## 4. Scaling notes

- **Capture workers** parallelize freely (each clone = one headless Chromium,
  ~0.5–1 GB peak); scale horizontally by queue depth.
- **Verify** is the heavy step (`next build`). Each worker container has its own
  filesystem, so its `HARNESS_DIR` is naturally isolated; for multiple workers on
  one host, give each a distinct `HARNESS_DIR`.
- Per-job wall-clock caps and retries are handled by pg-boss; a `compilerVersion`
  bump invalidates the cache automatically.

## 5. CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) typechecks and runs the
test suite on every push/PR with a Postgres service container + Chromium installed,
so the DB and browser-gated tests run in CI. Heavy real-site benchmarks remain a
manual/nightly concern; benchmark lists live in
[`compiler/benchmarks/`](../compiler/benchmarks).
