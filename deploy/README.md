# Deploy: Cloudflare (DNS) → Caddy (TLS) → app, on a Tailscale node

```
client ── HTTPS ──▶ Cloudflare (DNS + proxy, your domain)
                        │  Full (strict), Origin Certificate
                        ▼
                    Caddy :443  (TLS termination + reverse proxy)
                        │  APP_UPSTREAM
                        ▼
                    app :3000   (NestJS, SQLite ledger in ./data)

Tailscale: private/admin access to the node(s) — SSH, tailnet-only reach.
           Not the public ingress.
```

Two topologies, same files:
- **Single node** — `app` + `caddy` on one VPS (public IP). `APP_UPSTREAM=app:3000`. Tailscale = admin/SSH.
- **Split** — private app node (tailnet only, no public IP) + a small public **Caddy edge** that bridges Cloudflare to the app over the tailnet. Run only `caddy` on the edge with `APP_UPSTREAM=<app-node-tailscale-ip>:3000`, and only `app` on the private node.

---

## 1. Tailscale

On every node:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # authenticate; --ssh to enable Tailscale SSH
tailscale ip -4              # the node's 100.x.y.z address
```
- Lock down with tailnet ACLs so only you/admins reach the nodes.
- **Split topology:** note the app node's `100.x.y.z` — that's your `APP_UPSTREAM` host. (Use the IP, not the MagicDNS name — it won't resolve inside the Caddy container. Alternatively run `caddy` with `network_mode: host`.)

## 2. Cloudflare

1. **DNS:** add an `A`/`AAAA` record for `SITE_DOMAIN` → the public node's IP, **Proxied (orange cloud)**.
2. **SSL/TLS mode:** Full (strict).
3. **API token (for TLS):** Caddy uses the **Cloudflare DNS plugin** to auto-issue
   Let's Encrypt certs via the ACME **DNS-01** challenge — no Origin cert, no
   inbound :80 needed, and it works behind the orange cloud. Create a scoped
   token: My Profile → API Tokens → Create Token → **Edit zone DNS**, scoped to
   this zone (`Zone:DNS:Edit` + `Zone:Read`). Put it in `deploy/.env` as
   `CF_API_TOKEN`. The plugin is baked into the Caddy image (`deploy/caddy/Dockerfile`).

## 3. Deploy

On the node (repo root):
```bash
cp deploy/.env.example deploy/.env       # set SITE_DOMAIN, APP_UPSTREAM, CF_API_TOKEN
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs -f app   # watch boot + migrations
```
Split topology: run `... up -d --build caddy` on the edge node and `... up -d --build app` on the private node.

Health: `curl https://$SITE_DOMAIN/health` → `{"status":"ok"}`.

## 4. First run

Migrations run automatically on boot (seeds the org + chart of accounts). Then:

```bash
# Grab the one-time bootstrap API token from the logs:
docker compose -f deploy/docker-compose.yml logs app | grep "INIT API TOKEN"

# Mint a real operator/agent token (A1) and store it in your secret manager:
curl -H "Authorization: Bearer <init-token>" -H 'Content-Type: application/json' \
  -X POST https://$SITE_DOMAIN/admin/tokens -d '{"label":"agent"}'
```
Then onboard the org (`PUT /api/organization`) and open a period
(`POST /api/reporting-periods`). See `AGENT_API_GUIDE.md` for the full API.

## 5. Hardening

- **No origin bypass:** allow `:80/:443` only from [Cloudflare IP ranges](https://www.cloudflare.com/ips/) so nobody hits the origin IP directly:
  ```bash
  # example with ufw — repeat for each CF range, then default-deny inbound
  sudo ufw allow in on tailscale0          # keep tailnet admin open
  for ip in $(curl -s https://www.cloudflare.com/ips-v4); do sudo ufw allow from $ip to any port 443 proto tcp; done
  sudo ufw --force enable
  ```
- **App auth:** every route except `/health` requires `Authorization: Bearer <token>`. Add **Cloudflare Access** in front for a second factor if desired.
- **Admin over tailnet only (optional):** keep `/admin/*` reachable only via the tailnet by hitting `http://<node-tailscale-ip>:3000/admin/...` directly and not exposing it through the public Caddy site.

## 6. Backups — back up `./data`

`data/app.sqlite` is the **hash-chained ledger** — losing it loses the books. Options:
- **Litestream** (recommended): continuous SQLite replication to S3/R2.
  ```yaml
  # add a litestream sidecar that watches /app/data/app.sqlite → your bucket
  ```
- Or a periodic `sqlite3 data/app.sqlite ".backup"` + offsite copy / volume snapshot.

## 7. Ops

```bash
# update to a new build
git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
# logs / restart
docker compose -f deploy/docker-compose.yml logs -f
docker compose -f deploy/docker-compose.yml restart app
```
