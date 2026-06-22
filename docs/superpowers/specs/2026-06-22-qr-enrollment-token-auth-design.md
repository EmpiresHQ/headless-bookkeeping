# QR Enrollment Token Auth — Design

Date: 2026-06-22
Status: Approved (brainstorming) — ready for implementation plan
Scope: backend (token lifecycle + HTTP contract) + web SPA QR screen + CLI QR command
Out of scope: native mobile app (iOS/Android). The mobile client is a separate
sub-project; this spec only delivers the server-side flow it will talk to, plus
the two QR producers (SPA and CLI).

## Purpose

Add a low-friction enrollment flow so a mobile app can authenticate without ever
seeing a long-lived token in a QR code. A CLI or the web SPA mints a **one-time,
short-lived enrollment token**, renders it as a QR code, the mobile app scans it
and exchanges it for a **mobile session token** that signs subsequent API calls.

## Key insight — minimal delta to existing model

The system already has a complete bearer-token mechanism:

- Single table `api_token` (`id`, `token_hash` SHA-256 unique, `label`,
  `created_at`, `revoked_at`). No plaintext stored.
- `ApiTokenService`: `create` (mint, returns plaintext once), `verify` (loads all
  active tokens, constant-time compares), `list`, `revoke`.
- Global `ApiTokenGuard` (APP_GUARD) checks `Authorization: Bearer <token>`;
  `@Public()` exempts routes. Single-tenant — no user/tenant binding anywhere.
- Token management today is **CLI-only** (`token create/list/revoke`); the SPA
  stores a static token in `localStorage` (`bk_api_token`) and sends it as Bearer.

Therefore:

- A **mobile session token** is just a normal `api_token` row (long-lived bearer,
  hashed, revocable) — reuse the existing machinery entirely.
- An **enrollment token** is the same row plus two properties: an expiry and
  one-time use.

So the whole feature is: add a `kind` discriminator + `expires_at` + `consumed_at`
to `api_token`, teach the guard to scope by kind, and add three HTTP endpoints
plus two QR producers. No new table.

## Decisions (locked during brainstorming)

- **Session token access:** full access, identical to a static token. Differs only
  by `kind` and provenance. No scopes/permissions system (none exists today).
- **Session token lifetime:** eternal, like static tokens — revoke-only, no expiry,
  no refresh token.
- **Enrollment TTL:** 10 minutes (600s) default, one-time use.
- **Device metadata:** the device name supplied at exchange is written to the
  session token's `label` (e.g. "iPhone Алексея") — visible in `token list`,
  convenient for revoke.
- **tenantId / userId:** omitted from the contract — system is single-tenant.
- **QR producers:** both SPA (via HTTP endpoint) and CLI (direct service call).

## 1. Data model — extend `api_token`

New migration `051_add_api_token_kind_lifecycle.ts`. Add three columns:

| Column | Type | Meaning |
|--------|------|---------|
| `kind` | TEXT NOT NULL DEFAULT `'static'` | `static` \| `enrollment` \| `session` |
| `expires_at` | INTEGER NULL | unix seconds; populated **only** for `enrollment` |
| `consumed_at` | INTEGER NULL | unix seconds when an enrollment was exchanged (one-time-use marker) |

Existing rows backfill to `kind='static'`, `expires_at=NULL`, `consumed_at=NULL`,
so the init-token and every current token behave exactly as before. Session tokens
also keep `expires_at=NULL` (eternal). Update `ApiTokenTable` in
`packages/server/src/database/types.ts` accordingly.

`down()` drops the three columns.

## 2. `ApiTokenService` changes

Keep existing methods behaviour-compatible; add new ones.

- **`verify(plaintext)`** — extend the active-token filter to also exclude expired
  and consumed tokens, and return `kind`:
  - existing: `WHERE revoked_at IS NULL`
  - add: `AND (expires_at IS NULL OR expires_at > <now>) AND consumed_at IS NULL`
  - return shape gains `kind`, `expires_at`, `consumed_at`.
- **`create(label, kind = 'static')`** — add an optional `kind` param; default keeps
  current behaviour and call sites unchanged.
- **`createEnrollment(ttlSeconds = 600)`** — mint `kind='enrollment'`,
  `expires_at = now + ttlSeconds`. Returns `{ id, token, expiresAt }`.
- **`exchangeEnrollment(plaintext, deviceName)`** — in a **transaction**:
  1. resolve the enrollment row via the same hash/constant-time path, asserting it
     is `kind='enrollment'`, not revoked, not expired, not consumed;
  2. atomically consume it:
     `UPDATE api_token SET consumed_at = now WHERE id = ? AND consumed_at IS NULL`
     — assert exactly one affected row (double-spend guard);
  3. mint a session token via `create(deviceName, 'session')`.
  Returns the session `{ id, token }`. On any failure (expired, consumed, wrong
  kind) the transaction rolls back and nothing is minted.

## 3. Guard — kind scoping (security-critical)

Today any valid bearer passes on any route. Introduce kind scoping:

- **Default:** the guard accepts only `static` + `session` (full-access kinds).
  An `enrollment` token presented on any normal route → 401.
- **`@EnrollmentOnly()` decorator** (new, alongside `@Public()` in
  `api-token.guard.ts`): marks the exchange route so it accepts **only** an
  `enrollment` token, and rejects `static`/`session`.

The guard reads `kind` from the `verify()` result and checks it against the route's
allowed kinds (via Reflector metadata, mirroring the `IS_PUBLIC_KEY` pattern).
`request.apiToken` keeps carrying the resolved token row (now including `kind` and
`id`) for downstream use (e.g. self-revoke).

## 4. HTTP contract — `MobileAuthController`

| Method | Auth | Behaviour |
|--------|------|-----------|
| `POST /device-enrollments` | normal token (SPA operator) | `createEnrollment()` → `{ apiBaseUrl, enrollmentToken, expiresAt }` |
| `POST /mobile/sessions` | `@EnrollmentOnly()` | body `{ deviceName }` → `exchangeEnrollment` → `{ accessToken }` |
| `POST /mobile/sessions/revoke` | session token | revokes **itself** via `request.apiToken.id` → 204 |

- `apiBaseUrl` comes from server env (`PUBLIC_API_URL`). If unset, `POST
  /device-enrollments` fails with a clear 500/config error rather than emitting a
  bad QR. Validation: must be HTTPS outside local/dev.
- `expiresAt` is ISO-8601 (`2026-06-22T12:15:00Z`).
- `refreshToken`, `tenantId`, `userId` are intentionally absent (single-tenant MVP).

## 5. QR payload (versioned from day one)

```json
{ "v": 1, "api": "https://api.example.com", "enroll": "<one-time-token>" }
```

Both producers build the identical shape. Mobile-side validation rules (documented
here for the mobile sub-project, not implemented in this repo): `v` must be `1`;
`api` must be HTTPS (prefer an allowlist, else show host before accepting); `enroll`
must be present and non-empty; reject unknown structure or unsupported version.

## 6. SPA — "Enroll device" screen

New tab/screen in `packages/web`:

- Calls `POST /device-enrollments` via the existing `apiFetch` (operator already
  authenticated with the static token in `localStorage`).
- Builds the payload JSON and renders it as a QR code (add a QR lib to
  `packages/web`, e.g. `qrcode`).
- Shows a countdown to `expiresAt` and a "regenerate" button (re-calls the endpoint).
- On `UnauthorizedError`, falls back to the existing token gate (current behaviour).

## 7. CLI — `token enroll` with terminal QR

New subcommand beside `token create/list/revoke` in `packages/server/src/cli/cli.ts`:

```
cli token enroll [--ttl <sec>] [--api <url>] [--label <name>]
```

- Calls `tokens.createEnrollment(ttl)` **directly** (CLI holds `ApiTokenService`
  via `CliDeps.tokens`; no HTTP).
- Resolves `api` from `--api` or `PUBLIC_API_URL` env; if neither is set, exit with a
  clear error (no QR emitted).
- Renders an **ASCII QR** to the terminal (add a lib to the CLI package, e.g.
  `qrcode-terminal`).
- Stream convention mirrors `token create`:
  - **stdout** (`io.out`): machine-readable JSON payload `{ v, api, enroll, expiresAt }`
    so `$(cli token enroll)` captures it cleanly.
  - **stderr** (`io.err`): the ASCII QR art + human note ("expires in 10m").

## 8. Error handling / edge cases

- Enrollment expired or already consumed → exchange returns 401.
- Enrollment token used on a normal route → 401 (kind mismatch).
- Concurrent exchange of the same enrollment → atomic `consumed_at` conditional
  update ensures exactly one wins; the loser gets 401.
- `PUBLIC_API_URL` unset → enrollment creation fails loudly (SPA and CLI), no QR.
- Self-revoke is idempotent (revoking an already-revoked token is a no-op 204).

## 9. Testing (TDD)

**Service (`api-token.service.spec.ts`):**
- `createEnrollment` sets `kind='enrollment'` and `expires_at`.
- `exchangeEnrollment` consumes the enrollment and mints a `kind='session'` token
  with the supplied label.
- Second `exchangeEnrollment` on the same token fails (one-time use).
- Expired enrollment is rejected by `verify`/exchange.
- A `session` token passes `verify` and works on normal routes.

**Guard (`api-token.guard.spec.ts`):**
- `enrollment` token rejected on a default-scoped route.
- `enrollment` token accepted on an `@EnrollmentOnly()` route; `static`/`session`
  rejected there.

**E2E (`*.e2e-spec.ts`):**
- enroll → exchange → authenticated call succeeds → self-revoke → subsequent call
  with the revoked session token fails (401).

**CLI:**
- `token enroll` mints an enrollment of the right kind with the TTL.
- Missing `--api` and env → clear error, no QR.
- stdout payload parses as JSON, contains `v:1` and a non-empty `enroll`.

**Web:**
- Enroll screen renders the payload as a QR; handles error / expiry / 401 fallback.

## 10. Notes / future work

- `verify()` scans all active tokens linearly. Short-lived enrollment tokens churn,
  but expired ones drop out of the scan immediately and consumed ones are excluded;
  acceptable for MVP. A token-prefix lookup index is the future optimisation if the
  active set grows.
- No tenant/user binding because the system is single-tenant. If multi-tenancy is
  introduced later, `api_token` would gain a tenant/user FK and the exchange would
  bind the session to the enrolling operator's identity.
- Mobile client (scanner, secure storage, interceptor, logout state machine) is a
  separate sub-project; its requirements are captured in the original handoff.
