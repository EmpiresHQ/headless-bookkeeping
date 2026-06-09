# caddy:2 + the Cloudflare DNS plugin (for ACME DNS-01). Mirrors the host's
# cpu-llm Dockerfile.caddy. https://caddyserver.com/docs/modules/dns.providers.cloudflare
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
EXPOSE 443
