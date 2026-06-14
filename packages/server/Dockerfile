# syntax=docker/dockerfile:1

# ── Builder ─────────────────────────────────────────────────────
FROM node:24-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app

# Workspace-aware install: root + every package manifest before npm ci.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
COPY packages/cli/package.json    packages/cli/
RUN npm ci

COPY . .
RUN npm run build -w @headless-bookkeeping/web
RUN npm run build -w @headless-bookkeeping/server

# ── Production ──────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
COPY packages/cli/package.json    packages/cli/
# poppler-utils (pdftoppm) rasterises scanned PDFs; libheif-tools (heif-convert)
# transcodes HEIC/HEIF photos to PNG — both feed the vision OCR path (ADR-0032).
RUN apk add --no-cache python3 make g++ curl poppler-utils libheif-tools && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apk del python3 make g++

# Built outputs. web/dist must be present so the server can resolve
# @headless-bookkeeping/web at runtime (npm ci linked the workspace symlink).
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist    ./packages/web/dist

# Admin CLI on PATH (`docker compose exec app cli token create`).
RUN printf '#!/bin/sh\nexec node /app/packages/server/dist/cli.js "$@"\n' > /usr/local/bin/cli && \
    chmod +x /usr/local/bin/cli

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "packages/server/dist/main.js"]

# ── Test ────────────────────────────────────────────────────────
FROM builder AS test
WORKDIR /app
CMD ["npm", "run", "test", "-w", "@headless-bookkeeping/server"]
