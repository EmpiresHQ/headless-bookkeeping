# Deploy: Caddy-in-tailnet, Cloudflare A → sidecar tailnet IP

Mirrors the house pattern (cf. `cpu-llm` on the same host). Private, but with a
real public domain + valid cert.

```
tailnet device ──▶ books.empireshq.com  (CF DNS-only → 100.x)
                        ▼
            ┌──────────────────────────────────────────────┐
            │ tailscale (sidecar) ── tailnet IP 100.x       │
            │   └── caddy (shares netns) ── :443, TLS via    │
            │         CF DNS-01 → reverse_proxy app:3000     │
            │ app ── on the internal bridge (no host ports)  │
            └──────────────────────────────────────────────┘
```

- **No host ports** → no clash with Traefik (or anything) on 80/443.
- **Caddy terminates TLS** on the sidecar's tailnet IP using a real Let's Encrypt
  cert (CF **DNS-01**, no inbound needed).
- **Cloudflare just serves DNS**: an `A` record for the domain → the sidecar's
  `100.x` (DNS-only / grey cloud). The `100.x` isn't publicly routable, so only
  tailnet devices reach it — public domain + valid TLS, private access.

---

## 1. Prerequisites on the VPS
- Docker Engine + compose plugin; `/dev/net/tun` present.
- SSH user whose `authorized_keys` holds the public key of `VPS_SSH_KEY`.

## 2. Cloudflare
- **API token** (for Caddy DNS-01): My Profile → API Tokens → **Edit zone DNS**
  (`Zone:DNS:Edit` + `Zone:Read`, scoped to the zone) → `CLOUDFLARE_API_TOKEN`.
- The **A record** is added in step 4 (after you know the tailnet IP), **DNS-only**.

## 3. Tailscale
Admin → Settings → Keys → **Generate auth key**: Reusable ✅, Ephemeral ❌,
tagged (e.g. `tag:headless-bookkeeping`). → `TS_AUTHKEY`. Lock down with ACLs.

## 4. One-time setup on the VPS
The deploy job scp's the config **flat into `DEPLOY_PATH`** (strips `deploy/`):
`DEPLOY_PATH/{docker-compose.yml, Caddyfile, caddy/Dockerfile}`, plus your
`DEPLOY_PATH/.env` and `DEPLOY_PATH/data`.

```bash
sudo mkdir -p /opt/headless-bookkeeping        # = DEPLOY_PATH
cd /opt/headless-bookkeeping
$EDITOR .env     # TS_AUTHKEY, TS_HOSTNAME, SITE_DOMAIN, ACME_EMAIL,
                 # CLOUDFLARE_API_TOKEN, DOCKER_IMAGE
                 # MAILBOX_SECRET_KEY  ← see §9 (required for email intake;
                 #   `openssl rand -hex 32`). Without it, adding a mailbox 500s.
# bring it up once (or let CI do it), then read the sidecar's tailnet IP:
docker compose --env-file .env up -d --build
docker compose exec tailscale tailscale ip -4      # → 100.x.y.z
```
Then in Cloudflare add **`A  SITE_DOMAIN → 100.x.y.z`  (Proxy status: DNS only)**.
Caddy issues the cert via DNS-01 within a minute.

`.env`, `data/`, and the named volumes persist and are never overwritten by deploys.

## 5. Continuous deployment (GitHub Actions)
`.github/workflows/ci.yml`: **push to `main`** → `test` → `build-and-push`
(app image → registry, `:latest` + `:<sha>`) → **`deploy`** (SSH: `docker login`,
`compose pull app` of that SHA, `up -d --build` — app pulled, caddy built locally).

Repo secrets (the `DOCKER_*` ones already exist):

| Secret | Purpose |
|---|---|
| `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY` / `VPS_PORT`(opt) | SSH to the VPS |
| `DEPLOY_PATH` | dir holding `.env` (config lands flat here) |
| `DOCKER_IMAGE` / `DOCKER_USERNAME` / `DOCKER_PASSWORD` | registry (already set) |

## 6. First run & access
Migrations run on boot. From a tailnet device:
```bash
curl https://$SITE_DOMAIN/health
# bootstrap token (on the VPS, from DEPLOY_PATH):
docker compose logs app | grep "INIT API TOKEN"
curl -H "Authorization: Bearer <init-token>" -H 'Content-Type: application/json' \
  -X POST https://$SITE_DOMAIN/admin/tokens -d '{"label":"agent"}'
```
Then `PUT /api/organization`, `POST /api/reporting-periods`. Full API:
`AGENT_API_GUIDE.md`.

## 7. Backups — back up `./data`
`data/app.sqlite` is the **hash-chained ledger**. Use **Litestream** (→ S3/R2) or
periodic `sqlite3 data/app.sqlite ".backup"` offsite.

## 8. Ops
```bash
cd $DEPLOY_PATH
docker compose ps
docker compose logs -f caddy app
docker compose restart app
```

## 9. Email intake — connecting a mailbox (Gmail / Outlook / IMAP)

The server can harvest invoice attachments from mailboxes you connect in
**Settings → Mail intake** in the operator SPA. Two one-time prerequisites, then
connect via OAuth (Gmail/Outlook) or an IMAP app-password.

### 9.1 Required server config

- **`MAILBOX_SECRET_KEY`** (env, in `DEPLOY_PATH/.env`) — a 32-byte hex key used
  to encrypt stored mailbox credentials at rest. **Mandatory**: without it,
  adding any connector fails. Generate once and keep it stable:
  ```bash
  openssl rand -hex 32      # 64 hex chars → MAILBOX_SECRET_KEY=...
  ```
  > ⚠️ Rotating or losing this key makes every stored credential undecryptable —
  > all connectors must be deleted and re-connected. Back it up with your `.env`.
- **`public_api_url`** (app setting, not env) — your public `https://<domain>`.
  Set it in **Settings → Mobile enrollment → Public API URL**. It is the base of
  the OAuth redirect URI, so it must match what you register with Google/Microsoft.

### 9.2 Bring your own Google OAuth app (Gmail)

This is a **BYO-app** flow — you use your own Google Cloud OAuth client, the
deployment never ships shared credentials.

1. **Google Cloud Console** → create/select a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External**; fill the app name + your support email.
   - **Scopes** → add `.../auth/gmail.readonly`, `openid`, and `email`.
   - **Test users** → add the Google account(s) you'll connect (required while
     the app is in *Testing*; otherwise consent is refused).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URI** → exactly:
     `https://<your SITE_DOMAIN>/api/mailbox/oauth/callback`
   - Create → copy the **Client ID** and **Client secret**.
5. In the SPA: **Settings → Mail intake → BYO OAuth app credentials** → paste the
   **Google client id** + **secret** → **Save credentials**.
6. Click **Connect Gmail** → Google consent → you're redirected back with
   *"Mailbox connected"* and the mailbox appears in the list. The mailbox address
   is read from the OAuth identity — you never type it.

**Outlook** is the same shape via **Azure Portal → App registrations**: add a Web
redirect URI `https://<domain>/api/mailbox/oauth/callback`, API permissions
`IMAP.AccessAsUser.All` + `openid` + `email` (+ `offline_access`), then paste the
**Microsoft client id/secret** in the same panel and click **Connect Outlook**.

### 9.3 Plain IMAP (no OAuth)

For any other provider, use **Add IMAP mailbox (app password)**: host/port,
username, and an **app-specific password** (not your login password). Still
requires `MAILBOX_SECRET_KEY` (the password is encrypted with it).
