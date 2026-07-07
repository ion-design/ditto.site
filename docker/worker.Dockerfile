# Worker service — runs the deterministic compiler (headless Chromium) + optional
# verify builds. Starts from the Playwright base image so Chromium + OS deps are
# preinstalled, pinned to the compiler's Playwright version.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app

# tini as PID 1: reaps orphaned processes. Without it, a worker process killed
# mid-capture (e.g. under memory pressure) leaves its Chromium tree re-parented
# to an npm PID 1 that never reaps — zombies accumulate until every subsequent
# spawn fails with EAGAIN (observed in prod 2026-07-07: 50 consecutive
# browserType.launch failures until the container was replaced).
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm ci

# Each worker container has its own filesystem → its own build harness (verify
# isolation). Override HARNESS_DIR if running multiple workers on one host.
ENV ARTIFACTS_DIR=/data/artifacts
ENV HARNESS_DIR=/data/harness

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start", "--workspace", "@cloner/worker"]
