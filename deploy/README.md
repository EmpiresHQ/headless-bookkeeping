# Deploy: Cloudflare (DNS) → Caddy (TLS) → app, on a Tailscale node

```
client ── HTTPS ──▶ Cloudflare (DNS + proxy, your domain)
                        ▼
                   :443  ── all three containers share the tailscale netns ──┐
                   ┌─────────────────────────────────────────────────────┐   │
                   │ tailscale (sidecar) ── owns netns, publishes :80/:443 │   │
                   │   ├── caddy  ── TLS (LE via CF DNS-01) + reverse_proxy │   │
                   │   └── app    ── NestJS, SQLite ledger in ./data       │   │
                   └─────────────────────────────────────────────────────┘   │
                        ▲ tailnet (admin/SSH, and the bridge in a split setup) ┘
```

Everything runs in containers — **no host install of Tailscale or Caddy**. The
`tailscale` sidecar joins the tailnet with an auth key and owns the network
namespace; `caddy` and `app` join it via `network_mode: service:tailscale`, so
Caddy reaches the app at `localhost:3000` and the whole stack is one tailnet
node.

Two topologies, same files:
- **Single node** — all three services on one VPS. `APP_UPSTREAM=localhost:3000`.
- **Split** — private app node (app + tailscale, no public IP) + a public Caddy
  edge (caddy + tailscale). On the edge set `APP_UPSTREAM=<app-node-tailnet-ip>:3000`.

---

## 1. Prerequisites on the VPS

- Docker Engine + compose plugin.
- `/dev/net/tun` present (almost all VPSes; needed by the tailscale sidecar).
- An SSH user whose `authorized_keys` contains the public key whose private half
  you'll store as the `VPS_SSH_KEY` GitHub secret.

## 2. Cloudflare

1. **DNS:** `A`/`AAAA` for `SITE_DOMAIN` → the node's public IP, **Proxied (orange cloud)**.
2. **SSL/TLS mode:** Full (strict).
3. **API token (for TLS):** Caddy uses the **Cloudflare DNS plugin** to auto-issue
   Let's Encrypt certs via ACME **DNS-01** — no Origin cert, no inbound :80, works
   behind the orange cloud. Create a scoped token (My Profile → API Tokens →
   **Edit zone DNS**, this zone: `Zone:DNS:Edit` + `Zone:Read`) → `CF_API_TOKEN`.

## 3. Tailscale

Generate an **auth key** (admin console → Settings → Keys; reusable or ephemeral,
tag it for ACLs) → `TS_AUTHKEY`. That's it — the sidecar joins on first `up`.
Lock the node down with tailnet ACLs.

## 4. One-time setup on the VPS

```bash
sudo mkdir -p /opt/headless-bookkeeping/deploy        # = DEPLOY_PATH
cd /opt/headless-bookkeeping
# create deploy/.env from the template and fill it in:
#   SITE_DOMAIN, CF_API_TOKEN, TS_AUTHKEY, DOCKER_IMAGE  (APP_UPSTREAM=localhost:3000)
$EDITOR deploy/.env
```
The CI deploy job scp's the rest of `deploy/` and runs compose. `deploy/.env`,
`data/` and named volumes persist on the box and are never overwritten.

## 5. Continuous deployment (GitHub Actions)

`.github/workflows/ci.yml`: **push to `main`** → `test` → `build-and-push`
(image to the registry, tagged `:latest` and `:<sha>`) → **`deploy`** (SSH to the
VPS, `docker login`, `compose pull app` of that exact SHA, `up -d`). The deploy
job pins the running image to the commit SHA.

Add these repo secrets (the `DOCKER_*` ones already exist):

| Secret | Purpose |
|---|---|
| `VPS_HOST` | VPS hostname / IP |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | private SSH key (PEM) authorized on the VPS |
| `VPS_PORT` | SSH port (optional, default 22) |
| `DEPLOY_PATH` | dir holding `deploy/.env`, e.g. `/opt/headless-bookkeeping` |
| `DOCKER_IMAGE` / `DOCKER_USERNAME` / `DOCKER_PASSWORD` | registry (already set) |

First release: push to `main` (or run the workflow via *Run workflow*). To deploy
by hand instead:
```bash
cd $DEPLOY_PATH
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```
Health: `curl https://$SITE_DOMAIN/health` → `{"status":"ok"}`.

## 6. First run

Migrations run on boot (seed org + chart of accounts). Then:
```bash
# one-time bootstrap token from the logs:
docker compose -f deploy/docker-compose.yml logs app | grep "INIT API TOKEN"
# mint a real operator/agent token (A1), store it in your secret manager:
curl -H "Authorization: Bearer <init-token>" -H 'Content-Type: application/json' \
  -X POST https://$SITE_DOMAIN/admin/tokens -d '{"label":"agent"}'
```
Then `PUT /api/organization` and `POST /api/reporting-periods`. Full API:
`AGENT_API_GUIDE.md`.

## 7. Hardening

- **No origin bypass:** allow `:80/:443` only from [Cloudflare IP ranges](https://www.cloudflare.com/ips/) so the origin IP can't be hit directly; reach admin over the tailnet instead.
- **App auth:** every route except `/health` needs `Authorization: Bearer <token>`. Optionally add Cloudflare Access in front.
- Keep the Tailscale auth key ephemeral/rotated; tag the node and restrict via ACLs.

## 8. Backups — back up `./data`

`data/app.sqlite` is the **hash-chained ledger** — losing it loses the books.
Use **Litestream** (continuous SQLite replication to S3/R2) or periodic
`sqlite3 data/app.sqlite ".backup"` copied offsite.

## 9. Ops

```bash
docker compose -f deploy/docker-compose.yml logs -f
docker compose -f deploy/docker-compose.yml restart app
# manual update (CI does this automatically on push to main):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull app && \
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```
