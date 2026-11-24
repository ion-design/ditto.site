# API service (REST + MCP). Light — no browser needed (capture runs in the worker).
FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6
WORKDIR /app

RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Preserve the verified RDS CA path used by the existing AWS image overlay.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/aws/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/opt/aws/rds-ca.pem

# Refresh the package manager's own bundled dependencies as well as the app lock.
RUN npm install --global npm@11.21.3 && npm cache clean --force

# Install workspace deps from the lockfile.
COPY . .
RUN npm ci --omit=dev

ENV PORT=8787
EXPOSE 8787

# Runs TypeScript directly via tsx (matches the compiler's runtime model).
CMD ["npm", "run", "start", "--workspace", "@cloner/api"]
