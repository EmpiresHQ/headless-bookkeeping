# syntax=docker/dockerfile:1

# ── Base ────────────────────────────────────────────────────────
# Shared ancestor for builder/test and production. Owns the runtime system
# packages and the workspace manifests so that layer is built/cached ONCE and
# reused by both the CI test image and the release production image.
#
# poppler-utils (pdftoppm) rasterises scanned PDFs; libheif-tools (heif-convert)
# transcodes HEIC/HEIF photos to PNG. Needed at BUILD/TEST time (the
# rasterizer/HEIC integration tests shell out to them) AND at production runtime
# (the vision OCR path, ADR-0032).
FROM node:24-alpine AS base
RUN apk add --no-cache poppler-utils libheif-tools
WORKDIR /app

# Workspace-aware manifest copy before any install — shared by both installs.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
COPY packages/cli/package.json    packages/cli/

# ── Builder ─────────────────────────────────────────────────────
FROM base AS builder
RUN apk add --no-cache python3 make g++   # native-module build toolchain
RUN npm ci

COPY . .
RUN npm run build -w @headless-bookkeeping/web
RUN npm run build -w @headless-bookkeeping/server

# ── Production ──────────────────────────────────────────────────
FROM base AS production
# Single RUN so the build toolchain is added, used, and removed within one layer
# (never persisted). curl stays for the runtime healthcheck.
RUN apk add --no-cache python3 make g++ curl && \
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
