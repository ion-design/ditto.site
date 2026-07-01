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

Dependencies are monitored by [Dependabot](.github/dependabot.yml). Use
`npm audit --omit=dev --audit-level=moderate` for runtime dependency checks.

Known residual items:

- A full `npm audit` reports a moderate `esbuild` advisory through
  `drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils`. This is a
  development-only migration generator path. The audit-suggested downgrade to
  `drizzle-kit@0.18.1` breaks the current `drizzle-kit generate` workflow, so do
  not run `npm audit fix --force` blindly.
- Generated Next.js apps use the current Next 15 line instead of the older 14.x
  template. npm may still report a moderate PostCSS advisory inherited through
  Next until the upstream package carries a patched PostCSS version.

Generated apps are static exports by default. Review and update their
`package.json` before operating them as long-lived public services.
