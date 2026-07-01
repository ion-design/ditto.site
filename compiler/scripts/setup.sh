#!/usr/bin/env bash
# Reproduce the compiler environment from a clean checkout.
#   - installs compiler deps
#   - installs the Chromium build Playwright needs
#   - installs the shared build harness deps (Next/Vite/React) used to build & render
#     every generated app during validation
# Safe to re-run; each step is idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[setup] installing compiler deps"
npm install

echo "[setup] installing Playwright chromium"
npx playwright install chromium

echo "[setup] installing build harness deps"
( cd .harness && npm install )

echo "[setup] done. Try: npm run clone -- https://example.com/"
