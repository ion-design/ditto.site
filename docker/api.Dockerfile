# API service (REST + MCP). Light — no browser needed (capture runs in the worker).
FROM node:22-slim
WORKDIR /app

# Install workspace deps from the lockfile.
COPY . .
RUN npm ci

ENV PORT=8787
EXPOSE 8787

# Runs TypeScript directly via tsx (matches the compiler's runtime model).
CMD ["npm", "run", "start", "--workspace", "@cloner/api"]
