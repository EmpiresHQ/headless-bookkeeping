# Caddy with the Cloudflare DNS plugin baked in (the stock caddy:2 image does
# not include it). Enables ACME DNS-01 challenges via the Cloudflare API, so
# Caddy auto-provisions Let's Encrypt certs even behind Cloudflare's proxy
# (orange cloud) without needing inbound :80 or a manual Origin Certificate.
# https://caddyserver.com/docs/modules/dns.providers.cloudflare
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
