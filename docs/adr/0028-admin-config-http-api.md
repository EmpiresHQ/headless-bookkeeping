# Admin Config HTTP API — settings CRUD + token management

Before this ADR, the `setting` table (which drives `ai_model.*`, `prompt.*`,
`ingest_policy`, `telegram_*`, `approvers`, `email_whitelist`) was writable only
at the database/deploy level. Operators had no HTTP surface to change runtime
config without direct DB access. Similarly, API token creation required manual
SQL — there was no self-service token management endpoint. This ADR adds both.

## Decision

### Settings CRUD — `admin/settings`

A new `SettingsController` at `admin/settings` exposes four routes:

| Method   | Path                     | Response |
|----------|--------------------------|----------|
| `GET`    | `/admin/settings`        | `{ settings: [{key,value}] }` |
| `GET`    | `/admin/settings/:key`   | `{ key, value }` |
| `PUT`    | `/admin/settings/:key`   | `{ key, value }` — 200 |
| `DELETE` | `/admin/settings/:key`   | `{ key, deleted }` — 200 |

All writes are validated against a `KNOWN_SETTINGS` registry
(`src/admin/settings.registry.ts`): an explicit allowlist of keys, each with a
per-key value validator. An unknown key or an invalid value returns 400. This is
intentional: free-form key/value storage would allow silent misconfiguration
(e.g. a typo in `ai_model.triage` silently falling through to the global
default). The registry is the authoritative catalogue of operator-settable
config; new settings are added there explicitly.

`SettingsService` (`src/admin/settings.service.ts`) owns all reads/writes to the
existing `setting` table via Kysely's `onConflict` upsert idiom.

### Token management — `admin/tokens`

A new `TokensController` at `admin/tokens` exposes:

| Method   | Path               | Response |
|----------|--------------------|----------|
| `POST`   | `/admin/tokens`    | `{ id, token }` — 201; plaintext returned **once** |
| `GET`    | `/admin/tokens`    | `{ tokens: [{id, label, created_at, revoked_at}] }` |
| `DELETE` | `/admin/tokens/:id`| `{ id, revoked }` — 200 |

`ApiTokenService.list()` returns metadata only — `id`, `label`, `created_at`,
`revoked_at`. `token_hash` is never selected. Plaintext appears exactly once: in
the `POST /admin/tokens` response body.

### Organisation config is NOT duplicated

`GET /api/organization` and `PUT /api/organization` (existing
`OrganizationController`) manage the organisation record — name, country, base
currency. That surface is separate and is not touched here.

### Bootstrap token

`ApiTokenService.onModuleInit()` already seeds a single `init-token` on first
boot if no tokens exist, logging the plaintext once at `WARN` level so the
operator can capture it. No additional bootstrap work is needed.

### Security

All admin routes sit behind the existing global `ApiTokenGuard`
(`APP_GUARD` in `AppModule`). No `@Public()` decorator is applied to any admin
route — they are guarded automatically. The guard verifies the `Authorization:
Bearer <token>` header against the `api_token` table (SHA-256 hash comparison,
constant-time). A missing or invalid token returns 401.

### Validation convention

Follows the repo's established pattern: each DTO class carries a static `schema`
(Zod) property; the global `ZodValidationPipe` (wired in `main.ts`) calls
`metatype.schema.safeParse(body)` and returns 400 on failure.

## Why

Chosen over (a) leaving config write-only at DB/deploy level (no operator
self-service, risky to give operators direct DB access in production), (b)
free-form key/value store without a registry (silent misconfiguration from typos
or undocumented keys), and (c) duplicating the organisation surface (already
covered by `GET/PUT /api/organization`). A validated, explicit registry surfaces
the complete set of operator-settable config in one place, making both the API
and its constraints auditable.

## Consequences

- New files: `src/admin/settings.registry.ts`, `src/admin/settings.service.ts`,
  `src/admin/settings.controller.ts`, `src/admin/tokens.controller.ts`.
- `AdminModule` now imports `AuthModule` so `ApiTokenService` is injectable into
  `TokensController`.
- `ApiTokenService` gains `list()` — metadata only, never `token_hash`.
- No migration needed: `setting`, `api_token`, and `organization` tables already
  exist.
- E2e coverage: `test/admin-config.e2e-spec.ts` exercises all four scenarios
  (write + read, 401 without auth, 400 on unknown key, token lifecycle).
