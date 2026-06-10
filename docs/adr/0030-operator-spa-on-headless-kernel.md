# Operator SPA served from the headless kernel

The system is API-first and deliberately headless: ADR-0001 hides the
double-entry ledger behind business objects, ADR-0003 makes it single-tenant,
and operators drive it over REST plus the admin CLI. There is no UI. For the one
human operator, doing monthly intake by hand-crafting `curl` is painful: they
cannot see at a glance what is entered, and uploading documents / bank statements
and running triage has no surface. This ADR adds a minimal React SPA, served by
the kernel itself at `/`, as that operator window.

## Decision

### A thin same-origin SPA at `/`

A React + Vite + TypeScript + Tailwind app lives in `frontend/` with its own
`package.json` + lockfile, builds to `frontend/dist`, is copied into the image,
and is served by `@nestjs/serve-static` with `serveRoot: '/'` and
`exclude: ['/api*', '/admin*', '/health*']`. Static assets are served by
middleware ahead of the global `ApiTokenGuard`, so the page (HTML/JS/CSS) loads
without a token; only the data XHRs are guarded. Unknown GETs fall back to
`index.html` (SPA routing). Swagger (`/api`), the API (`/api/*`), and admin
(`/admin/*`) are untouched by the exclude list.

### Token in localStorage, attached as a Bearer header

The operator pastes an API token once; it is kept in `localStorage` and attached
to every request by a `fetch` wrapper as `Authorization: Bearer <token>`. A `401`
clears the token and re-prompts. There is no cookie, no session, and no login
backend — the API token **is** the credential (single-tenant, ADR-0003).

### Scope: business objects only — the ledger stays hidden

The SPA shows Organization, Entities (suppliers/customers), Expenses, Sales
invoices, Documents, and Reporting periods + the VAT/KMD declaration. The raw
double-entry ledger — vouchers and account balances — is **deliberately not
surfaced**, preserving ADR-0001's hidden ledger. The operator sees business
facts, never debits and credits.

### Capabilities: read + intake, not ledger editing

Read (list/detail); delete of probe garbage (draft expense/invoice, unreferenced
entity) via the existing `DELETE` routes; document upload + triage/approvals;
bank-statement upload (ADR-0031). Posted records are never edited from the UI —
corrections remain in the kernel's correction flow (ADR-0009).

## Why

Chosen over (a) staying CLI-only — fine for an agent, painful for a human doing
monthly intake; (b) a separate hosted frontend repo — more moving parts, CORS, a
second deploy, overkill for one operator on the tailnet; (c) surfacing the full
ledger — contradicts ADR-0001 and leaks internal mechanics. A thin same-origin
SPA served from the kernel gives a window with zero CORS, one deploy artifact,
and the hidden-ledger boundary intact.

Keeping the token in `localStorage` is an accepted XSS exposure: the instance is
tailnet-only (single box, ADR-0003), single-user, and ships no third-party
scripts (assets are self-built, not CDN). The simplicity outweighs the residual
risk at this scale. Revisit if the surface ever leaves the tailnet or gains
multiple users.

## Consequences

- New `frontend/` workspace (Vite/React/TS/Tailwind) with its own
  `package.json` + lockfile. The Dockerfile builder stage gains
  `cd frontend && npm ci && npm run build`; the production stage copies
  `frontend/dist`.
- `@nestjs/serve-static` is added to the server; `AppModule` imports
  `ServeStaticModule` with the api/admin/health exclude + `index.html` fallback.
- `/` is now occupied by the SPA. No new auth surface and no new permission
  model — the SPA is a client over the already-guarded API.
- Delivered in phases as separate PRs: **P1** shell + auth + read tabs (the
  delete buttons depend on the `cli-delete-garbage` branch's `DELETE` routes
  being deployed); **P2** documents + triage/approvals; **P3** bank statements
  (ADR-0031).
