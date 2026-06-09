# syntax=docker/dockerfile:1

# ── Builder stage ───────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production stage ───────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ curl && \
    npm ci --production && \
    npm cache clean --force && \
    apk del python3 make g++

COPY --from=builder /app/dist ./dist

# Expose the admin CLI on PATH so `docker compose exec app cli token create` works.
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/cli && \
    chmod +x /usr/local/bin/cli

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/main.js"]

# ── Test stage ────────────────────────────────────────────────
FROM builder AS test

WORKDIR /app

COPY . .

CMD ["npm", "run", "test"]
