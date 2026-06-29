# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report them privately via GitHub's [private vulnerability reporting](https://github.com/ion-design/ditto.site/security/advisories/new)
("Security" tab → "Report a vulnerability"), or email **samraaj@ion.design**. We'll
acknowledge within a few business days and keep you updated on the fix.

## Supported versions

This project is pre-1.0; security fixes land on `main`. Pin a commit if you need
stability.

## Operating a public clone endpoint (read this before deploying)

The service is a **"fetch any URL"** system, so a misconfigured deployment can be
abused. The codebase ships defenses — keep them on:

- **SSRF protection** (`packages/api/src/ssrf.ts`): every submitted URL is
  validated and its resolved IPs are checked against private / loopback /
  link-local / cloud-metadata (`169.254.169.254`) / reserved ranges **after DNS
  resolution** (covers DNS-rebinding). It's enabled by default — do **not** set
  `SSRF_DISABLE=true` or `SSRF_ALLOW_LOOPBACK=true` in production.
- **API-key auth + rate limits**: set `API_KEYS` and `RATE_LIMIT_PER_MINUTE`.
- **Per-job caps**: the compiler bounds every capture wait; the queue enforces
  retries/timeouts. Size worker memory for headless Chromium (~0.5–1 GB/clone).
- **Capture sanity**: degenerate/bot-walled captures are flagged
  (`capture.pollution` / `capture.blocked`) rather than served as success.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) and [`docs/SERVICE.md`](docs/SERVICE.md).

## Dependency advisories

Dependencies are monitored by [Dependabot](.github/dependabot.yml). One known item:
the compiler's build harness and the **generated** app pin `next@14.2.21`, which has
a published advisory. Bumping it should be paired with a benchmark re-run (it affects
`next build` and the emitted `package.json`), so it's tracked rather than auto-applied.
