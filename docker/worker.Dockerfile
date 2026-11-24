# Worker service — runs the deterministic compiler (headless Chromium) + optional
# verify builds. Install only Chromium and its dependencies from the exact
# Playwright version in the lockfile; avoid the unused WebKit/Firefox runtime.
FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6
WORKDIR /app

# tini as PID 1: reaps orphaned processes. Without it, a worker process killed
# mid-capture (e.g. under memory pressure) leaves its Chromium tree re-parented
# to an npm PID 1 that never reaps — zombies accumulate until every subsequent
# spawn fails with EAGAIN (observed in prod 2026-07-07: 50 consecutive
# browserType.launch failures until the container was replaced).
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Preserve the RDS trust bundle instead of layering over the old application image.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/aws/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/opt/aws/rds-ca.pem
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The worker uses npm again when it provisions its isolated verification harness.
RUN npm install --global npm@11.21.3 && npm cache clean --force

COPY . .
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Each worker container has its own filesystem → its own build harness (verify
# isolation). Override HARNESS_DIR if running multiple workers on one host.
ENV ARTIFACTS_DIR=/data/artifacts
ENV HARNESS_DIR=/data/harness

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start", "--workspace", "@cloner/worker"]
