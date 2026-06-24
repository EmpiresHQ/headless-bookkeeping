# CI Docker: shared `base` stage

## Problem

`packages/server/Dockerfile` has three stages. `builder` and `test` (`FROM builder`) are CI's test image; `production` is the release/deploy image. `production` is a fresh `FROM node:24-alpine` that does **not** share any stage with `builder` beyond the raw Node image: it re-installs the same runtime system packages (`poppler-utils`, `libheif-tools`) and re-copies the same workspace manifests. So the system/base layer is materialised **twice** — once for the test image, once for the production image — and the two builds (CI's `build-test-image`, release's `build-and-push`, both in `.github/workflows/ci.yml`) share no common base stage to cache.

## Goal

Extract the shared system base into a single `base` stage that both `builder`/`test` and `production` derive from, so the system-deps + manifest-copy layer is built/cached **once** and reused by both the CI test image and the release production image.

## Non-goals (explicitly out of scope)

- **Deduplicating the npm install.** Two installs remain: `builder` runs `npm ci` (full, with dev deps for building/testing); `production` runs `npm ci --omit=dev` (runtime-only). They are different installs in different stages and are intentionally left separate (the prune-based single-install approach was considered and rejected as too large for this change).
- **BuildKit npm cache mount.** Considered and rejected: it speeds the install only when it actually runs in the same invocation (local/cache-miss builds) and does not speed native-module compilation, so the benefit did not justify the added moving part.
- **`ci.yml` changes.** No workflow change. Same two build jobs, same `--target test` / `--target production`, same `cache-from/to: type=gha`.

## Design

Restructure `packages/server/Dockerfile` into four stages. The `# syntax=docker/dockerfile:1` directive stays.

```dockerfile
# ── base: shared ancestor for builder/test and production ──
FROM node:24-alpine AS base
# Runtime transcoders: pdftoppm (poppler) rasterises scanned PDFs, heif-convert
# (libheif) transcodes HEIC. Needed at BUILD/TEST time (rasterizer/HEIC integration
# tests shell out to them) AND at production runtime (the OCR path). One layer, shared.
RUN apk add --no-cache poppler-utils libheif-tools
WORKDIR /app
# Workspace-aware manifest copy before any install — shared by both installs.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
COPY packages/cli/package.json    packages/cli/

# ── builder ──
FROM base AS builder
RUN apk add --no-cache python3 make g++          # native-module build toolchain
RUN npm ci                                        # full install (dev deps incl.)
COPY . .
RUN npm run build -w @headless-bookkeeping/web
RUN npm run build -w @headless-bookkeeping/server

# ── production ──
FROM base AS production
# Single RUN so the build toolchain is added, used, and removed within one layer
# (never persisted). curl stays for the runtime healthcheck.
RUN apk add --no-cache python3 make g++ curl \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del python3 make g++
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist    ./packages/web/dist
RUN printf '#!/bin/sh\nexec node /app/packages/server/dist/cli.js "$@"\n' > /usr/local/bin/cli \
 && chmod +x /usr/local/bin/cli
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "packages/server/dist/main.js"]

# ── test ──
FROM builder AS test
WORKDIR /app
CMD ["npm", "run", "test", "-w", "@headless-bookkeeping/server"]
```

### What changes vs. what stays

**Changes**
- New `base` stage owns: `node:24-alpine`, the runtime `apk` packages (`poppler-utils`, `libheif-tools`), `WORKDIR /app`, and the four manifest `COPY` lines.
- `builder` becomes `FROM base` and adds only the build toolchain (`python3 make g++`) before `npm ci`.
- `production` becomes `FROM base`; its `apk add` no longer lists `poppler-utils`/`libheif-tools` (inherited from `base`) — only the transient toolchain + `curl`.

**Stays identical (behaviour-preserving)**
- `production` keeps its single-`RUN` add-toolchain → `npm ci --omit=dev` → `npm cache clean` → `apk del` pattern, so the toolchain never lands in a persisted layer.
- `curl` remains in the production runtime (healthcheck).
- `test` stays `FROM builder` with the same test `CMD`.
- The `cli` wrapper, `ENV`, `EXPOSE`, and `CMD` are unchanged.
- `.github/workflows/ci.yml` is untouched.

## Risks & validation

- **Risk: builder/test loses access to poppler/libheif.** Mitigated — they are in `base`, and `builder` is `FROM base`, so `test` (`FROM builder`) still has `pdftoppm`/`heif-convert`. Validated by the rasterizer/HEIC integration tests passing in the test image.
- **Risk: production runtime loses poppler/libheif or grows in size.** Mitigated — `base` provides both; the toolchain is still added-and-removed in one RUN. Validate the production image runs (`node packages/server/dist/main.js` boots) and `pdftoppm -v` / `heif-convert --version` resolve inside it.
- **Risk: behaviour drift in the manifest copy / install order.** Mitigated — the COPY set and install commands are byte-for-byte the same, just relocated.

### Acceptance

1. `docker build --target test -t app-test .` succeeds; running CI's server suite in it is green (incl. the HEIC/rasterizer integration tests that shell out to the system binaries).
2. `docker build --target production -t app-prod .` succeeds; the image boots and `pdftoppm`/`heif-convert` resolve inside it.
3. In a single `docker build` of `--target production`, the `base` stage's `apk`/manifest layers are built once and reused by both `builder` and `production` (no duplicate `apk add poppler-utils libheif-tools`).
4. `.github/workflows/ci.yml` is unchanged.

## Out of this change / future options

If install time later proves to be the real cost, revisit: (a) a `prod-deps` stage using `npm prune --omit=dev` to produce runtime `node_modules` from the already-compiled `builder` tree (single install + single native compile), and/or (b) persisting a BuildKit npm cache mount across CI runners.
