# Worker service — runs the deterministic compiler (headless Chromium) + optional
# verify builds. Starts from the Playwright base image so Chromium + OS deps are
# preinstalled, pinned to the compiler's Playwright version.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app

COPY . .
RUN npm ci

# Each worker container has its own filesystem → its own build harness (verify
# isolation). Override HARNESS_DIR if running multiple workers on one host.
ENV ARTIFACTS_DIR=/data/artifacts
ENV HARNESS_DIR=/data/harness

CMD ["npm", "run", "start", "--workspace", "@cloner/worker"]
