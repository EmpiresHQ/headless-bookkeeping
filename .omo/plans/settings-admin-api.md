# Settings & Admin Config HTTP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make runtime config HTTP-settable. Today the `setting` table (which drives `ai_model.*`, `prompt.*`, `ingest_policy`, `telegram_*`, `approvers`, `email_whitelist`) is only writable in the DB/at deploy — no HTTP route. Add an admin **settings** API (validated against a known-keys registry) and an admin **API-token management** API (create / list-metadata / revoke). Organization config already exists (`GET/PUT /api/organization`) — not duplicated.

**Architecture:** A new `SettingsService` reads/upserts/deletes the existing generic `setting` table, validating every write against a `KNOWN_SETTINGS` registry (key allowlist + per-key value validator) — unknown key or invalid value → 400. A `SettingsController` (`admin/settings`) and a `TokensController` (`admin/tokens`) sit behind the existing global `ApiTokenGuard` (`APP_GUARD` in `AppModule`) — admin config requires the operator token (bootstrapped by `ApiTokenService.onModuleInit()`, which logs an init token on first boot). `ApiTokenService` gains a `list()` (metadata only — never the hash/plaintext). Validation follows the repo's Zod-DTO + global `ZodValidationPipe` convention. See new **ADR-0028**.

**Tech Stack:** NestJS 11, Kysely 0.29 over better-sqlite3, Jest 30, Zod, TypeScript strict. **Node 24** (`.nvmrc`=24; gate fails under Node 22).

**Branch:** `settings-admin-api` (git worktree at `/Users/alekseirevin/test/hb-settings`, off `wave-8-interaction` — next ADR = 0028; no migration needed: `setting`/`api_token`/`organization` tables already exist).

---

## Guardrails (apply to every task)

- **G1 — gate under Node 24.** Prefix every shell: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;`. Run all commands from the worktree dir `/Users/alekseirevin/test/hb-settings`. Final commit of every task preceded by `npm run build && npm run lint && npm test` green (+ `test:e2e` for the last task).
- **G2 — real-DI integration tests** (in-memory `Kysely<Database>` + `Migrator.migrateToLatest()` + `Test.createTestingModule`); harness: `src/currency/currency.resolution.spec.ts`.
- **G3 — discriminating assertions** (assert a specific stored value / a specific 400 on a bad key).
- **G4 — no new migration** (no schema change). Grep gate empty: `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`.
- **G5 — no `any`, no `as`.** Strict TS; `npm run lint` enforces. Secrets: a token's plaintext is returned ONLY by create; never logged, never in list.

## Assumed current contracts (verified)

- `setting` table: `{ id, key UNIQUE, value, updated_at }` (migration 028). Read pattern: `db.selectFrom('setting').select('value').where('key','=',k).executeTakeFirst()`.
- `ApiTokenService` (`src/auth/api-token.service.ts`): `create(label: string): Promise<{ id: number; token: string }>` (returns plaintext once), `verify(plaintext): Promise<row|null>`, `revoke(id: number): Promise<void>`, `onModuleInit()` seeds + logs an `init-token` on first boot. `api_token` columns: `id, token_hash, label, created_at, revoked_at`. **No `list()` yet** (this plan adds it).
- `ApiTokenGuard` is a global `APP_GUARD` (in `AppModule`); `@Public()` (`src/auth/api-token.guard.ts`) exempts a route. New admin routes are guarded automatically (no `@Public()`).
- `OrganizationController` already exposes `GET/PUT /api/organization` (no work here).
- `AdminController` is `@Controller('admin')` with read-only diagnostics; `AdminModule` imports `DatabaseModule, ReportingPeriodsModule`.
- Validation: a DTO type with a static `schema` (Zod) property; the global `ZodValidationPipe` (`src/common/pipes/zod-validation.pipe.ts`, wired in `main.ts`) calls `metatype.schema.safeParse(body)` → 400 on failure. No global route prefix; controllers self-prefix.
- Kysely injected via `@Inject(KYSELY_MODULE_CONNECTION_TOKEN())` (nestjs-kysely).

---

## File Structure

```
src/admin/
  settings.registry.ts          # NEW: KNOWN_SETTINGS (key allowlist + per-key validator)
  settings.service.ts           # NEW: read/list/upsert/delete over `setting`, validates via registry
  settings.service.spec.ts      # NEW: real-DI
  settings.controller.ts        # NEW: admin/settings GET/GET:key/PUT:key/DELETE:key
  settings.controller.spec.ts   # NEW: controller (real-DI)
  tokens.controller.ts          # NEW: admin/tokens POST/GET/DELETE:id
  tokens.controller.spec.ts     # NEW: controller (real-DI)
  admin.module.ts               # MODIFY: register the new controllers + SettingsService + import AuthModule
src/auth/
  api-token.service.ts          # MODIFY: add list() (metadata only)
  api-token.service.spec.ts     # MODIFY: list() test
test/
  admin-config.e2e-spec.ts      # NEW: e2e — set a setting + create/revoke a token over HTTP with the bootstrap token
docs/adr/0028-admin-config-http-api.md   # NEW
```

---

## Task 1: `KNOWN_SETTINGS` registry + `SettingsService`

**Files:** Create `src/admin/settings.registry.ts`, `src/admin/settings.service.ts`, `src/admin/settings.service.spec.ts`.

- [ ] **Step 1: Write the registry**

```typescript
// src/admin/settings.registry.ts
/** The settings an operator may set over HTTP. Each entry validates its value.
 * Agent keys are enumerated explicitly (the agent set is fixed: triage, intent_classifier). */
export interface KnownSetting {
  description: string;
  validate(value: string): boolean;
}

const nonEmpty = (v: string): boolean => v.trim().length > 0;
const ingestPolicy = (v: string): boolean =>
  v === 'known-only' || v === 'quarantine' || v === 'open';

export const KNOWN_SETTINGS: Record<string, KnownSetting> = {
  ai_model: { description: 'Global default AI model id', validate: nonEmpty },
  'ai_model.triage': { description: 'Model override for the triage agent', validate: nonEmpty },
  'ai_model.intent_classifier': { description: 'Model override for the intent classifier', validate: nonEmpty },
  'prompt.triage': { description: 'Instruction override for the triage agent', validate: nonEmpty },
  'prompt.intent_classifier': { description: 'Instruction override for the intent classifier', validate: nonEmpty },
  ingest_policy: { description: 'known-only | quarantine | open', validate: ingestPolicy },
  telegram_allowlist: { description: 'Comma-separated Telegram chat ids', validate: nonEmpty },
  telegram_webhook_secret: { description: 'Telegram webhook secret token', validate: nonEmpty },
  telegram_bot_token: { description: 'Telegram bot token', validate: nonEmpty },
  approvers: { description: 'Comma-separated approver identities', validate: nonEmpty },
  email_whitelist: { description: 'Comma-separated converse/command allowlist', validate: nonEmpty },
};

export function isKnownSettingKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_SETTINGS, key);
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/admin/settings.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { SettingsService } from './settings.service';

describe('SettingsService (integration)', () => {
  let db: Kysely<Database>;
  let settings: SettingsService;

  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('migrate failed');
    const module: TestingModule = await Test.createTestingModule({
      providers: [{ provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db }, SettingsService],
    }).compile();
    settings = module.get(SettingsService);
  });
  afterEach(async () => { await db.destroy(); });

  it('upserts a known key and reads it back', async () => {
    await settings.set('ai_model', 'openai/gpt-4o');
    await expect(settings.get('ai_model')).resolves.toBe('openai/gpt-4o');
  });

  it('upsert overwrites (not duplicates) an existing key', async () => {
    await settings.set('ai_model', 'a');
    await settings.set('ai_model', 'b');
    await expect(settings.get('ai_model')).resolves.toBe('b');
    const rows = await db.selectFrom('setting').selectAll().where('key', '=', 'ai_model').execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects an unknown key', async () => {
    await expect(settings.set('not_a_key', 'x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid value for a known enum key', async () => {
    await expect(settings.set('ingest_policy', 'banana')).rejects.toBeInstanceOf(BadRequestException);
    await settings.set('ingest_policy', 'quarantine');
    await expect(settings.get('ingest_policy')).resolves.toBe('quarantine');
  });

  it('list returns all stored settings; delete removes one', async () => {
    await settings.set('ai_model', 'm');
    await settings.set('ingest_policy', 'open');
    const all = await settings.list();
    expect(all).toEqual(expect.arrayContaining([
      { key: 'ai_model', value: 'm' }, { key: 'ingest_policy', value: 'open' },
    ]));
    await settings.delete('ai_model');
    await expect(settings.get('ai_model')).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify fail** → `Cannot find module './settings.service'`.

- [ ] **Step 4: Implement `SettingsService`**

```typescript
// src/admin/settings.service.ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { KNOWN_SETTINGS, isKnownSettingKey } from './settings.registry';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private now(): number { return Math.floor(Date.now() / 1000); }

  async get(key: string): Promise<string | null> {
    const row = await this.db.selectFrom('setting').select('value').where('key', '=', key).executeTakeFirst();
    return row?.value ?? null;
  }

  async list(): Promise<{ key: string; value: string }[]> {
    return this.db.selectFrom('setting').select(['key', 'value']).orderBy('key').execute();
  }

  async set(key: string, value: string): Promise<void> {
    if (!isKnownSettingKey(key)) {
      throw new BadRequestException(`Unknown setting key: ${key}`);
    }
    if (!KNOWN_SETTINGS[key].validate(value)) {
      throw new BadRequestException(`Invalid value for setting ${key}`);
    }
    await this.db
      .insertInto('setting')
      .values({ key, value, updated_at: this.now() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: this.now() }))
      .execute();
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom('setting').where('key', '=', key).execute();
  }
}
```
> Verify Kysely's `onConflict` upsert form against an existing usage in the repo (grep `onConflict`); if the repo uses a different upsert idiom (e.g. delete-then-insert), match it.

- [ ] **Step 5: Run to verify pass** (5 tests). **Step 6: Build+lint+commit**

```bash
git add src/admin/settings.registry.ts src/admin/settings.service.ts src/admin/settings.service.spec.ts
git commit -m "feat(admin): SettingsService + known-keys registry (validated HTTP-settable config)"
```

---

## Task 2: `SettingsController` (`admin/settings`)

**Files:** Create `src/admin/settings.controller.ts`, `src/admin/settings.controller.spec.ts`; modify `src/admin/admin.module.ts`.

- [ ] **Step 1: Failing controller test** (real-DI; call controller methods directly, asserting service effects + a 400 on a bad key)

```typescript
// src/admin/settings.controller.spec.ts  — boot real DI (in-memory db + SettingsService + SettingsController), then:
it('PUT upserts a known key; GET reads it', async () => {
  await controller.put('ai_model', { value: 'openai/gpt-4o' });
  await expect(controller.get('ai_model')).resolves.toEqual({ key: 'ai_model', value: 'openai/gpt-4o' });
});
it('GET list returns stored settings', async () => {
  await controller.put('ingest_policy', { value: 'open' });
  const res = await controller.list();
  expect(res.settings).toEqual(expect.arrayContaining([{ key: 'ingest_policy', value: 'open' }]));
});
it('PUT a bad value 400s', async () => {
  await expect(controller.put('ingest_policy', { value: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
});
it('DELETE removes a key', async () => {
  await controller.put('ai_model', { value: 'm' });
  await controller.delete('ai_model');
  await expect(controller.get('ai_model')).resolves.toEqual({ key: 'ai_model', value: null });
});
```
(Mirror the real-DI module-boot from `settings.service.spec.ts`, adding `SettingsController` to the test module.)

- [ ] **Step 2: Run** → fail (module not found).

- [ ] **Step 3: Implement controller + DTO**

```typescript
// src/admin/settings.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { SettingsService } from './settings.service';

const setSettingSchema = z.object({ value: z.string() });
export class SetSettingDto {
  static schema = setSettingSchema;
  value!: string;
}

@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async list(): Promise<{ settings: { key: string; value: string }[] }> {
    return { settings: await this.settings.list() };
  }

  @Get(':key')
  async get(@Param('key') key: string): Promise<{ key: string; value: string | null }> {
    return { key, value: await this.settings.get(key) };
  }

  @Put(':key')
  @HttpCode(HttpStatus.OK)
  async put(@Param('key') key: string, @Body() dto: SetSettingDto): Promise<{ key: string; value: string }> {
    await this.settings.set(key, dto.value);
    return { key, value: dto.value };
  }

  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('key') key: string): Promise<{ key: string; deleted: true }> {
    await this.settings.delete(key);
    return { key, deleted: true };
  }
}
```
Modify `admin.module.ts`: add `SettingsController` to `controllers`, `SettingsService` to `providers`.

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(admin): SettingsController (admin/settings CRUD, Zod-validated, token-guarded)"`

---

## Task 3: `ApiTokenService.list()` (metadata only)

**Files:** Modify `src/auth/api-token.service.ts`, `src/auth/api-token.service.spec.ts`.

- [ ] **Step 1: Failing test** — `list()` returns `{ id, label, created_at, revoked_at }[]` and NEVER `token_hash`.

```typescript
it('list returns token metadata without the hash', async () => {
  const created = await service.create('my-token');
  const list = await service.list();
  const row = list.find((t) => t.id === created.id);
  expect(row).toMatchObject({ id: created.id, label: 'my-token', revoked_at: null });
  expect(row).not.toHaveProperty('token_hash');
  expect(JSON.stringify(list)).not.toContain(created.token); // plaintext never present
});
```

- [ ] **Step 2: Run** → fail (`list` undefined).

- [ ] **Step 3: Implement**

```typescript
async list(): Promise<{ id: number; label: string; created_at: number; revoked_at: number | null }[]> {
  return this.db
    .selectFrom('api_token')
    .select(['id', 'label', 'created_at', 'revoked_at'])
    .orderBy('id')
    .execute();
}
```
(Adjust selected columns to the real `api_token` schema; the rule: never select `token_hash`.)

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(auth): ApiTokenService.list() — token metadata, never the hash"`

---

## Task 4: `TokensController` (`admin/tokens`)

**Files:** Create `src/admin/tokens.controller.ts`, `src/admin/tokens.controller.spec.ts`; modify `src/admin/admin.module.ts` (+ import `AuthModule` so `ApiTokenService` is injectable).

- [ ] **Step 1: Failing test** (real-DI)

```typescript
it('POST creates a token, returns plaintext ONCE', async () => {
  const res = await controller.create({ label: 'ci' });
  expect(res.token).toMatch(/^[0-9a-f]{64}$/);
  expect(res.id).toBeGreaterThan(0);
});
it('GET lists token metadata (no plaintext, no hash)', async () => {
  const created = await controller.create({ label: 'ci' });
  const res = await controller.list();
  expect(res.tokens.some((t) => t.id === created.id && t.label === 'ci')).toBe(true);
  expect(JSON.stringify(res.tokens)).not.toContain(created.token);
});
it('DELETE revokes a token', async () => {
  const created = await controller.create({ label: 'tmp' });
  await controller.revoke(created.id);
  const row = await db.selectFrom('api_token').select('revoked_at').where('id', '=', created.id).executeTakeFirstOrThrow();
  expect(row.revoked_at).not.toBeNull();
});
```

- [ ] **Step 2: Run** → fail.

- [ ] **Step 3: Implement**

```typescript
// src/admin/tokens.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { ApiTokenService } from '../auth/api-token.service';

const createTokenSchema = z.object({ label: z.string().min(1) });
export class CreateTokenDto { static schema = createTokenSchema; label!: string; }

@Controller('admin/tokens')
export class TokensController {
  constructor(private readonly tokens: ApiTokenService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateTokenDto): Promise<{ id: number; token: string }> {
    return this.tokens.create(dto.label);
  }

  @Get()
  async list(): Promise<{ tokens: { id: number; label: string; created_at: number; revoked_at: number | null }[] }> {
    return { tokens: await this.tokens.list() };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(@Param('id', ParseIntPipe) id: number): Promise<{ id: number; revoked: true }> {
    await this.tokens.revoke(id);
    return { id, revoked: true };
  }
}
```
Modify `admin.module.ts`: import `AuthModule` (so `ApiTokenService` resolves — confirm `AuthModule` exports it; if not, export it there), add `TokensController` to `controllers`.

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(admin): TokensController (admin/tokens create/list/revoke; plaintext returned once)"`

---

## Task 5: e2e + ADR-0028 + full gate

**Files:** Create `test/admin-config.e2e-spec.ts`, `docs/adr/0028-admin-config-http-api.md`.

- [ ] **Step 1: e2e** — boot the real app (mirror `test/intake.e2e-spec.ts` harness: in-memory db, real migrations, `MastraService`/`DOCUMENT_STORAGE_ROOT` overrides as needed). Capture the bootstrap token: since `ApiTokenService.onModuleInit()` seeds one on first boot, either (a) read it from the `api_token` table you control (you can't — it's hashed) — instead **create a token via the service directly in the test setup** (`app.get(ApiTokenService).create('e2e')`) and use its plaintext as the Bearer. Then:
  - `PUT /admin/settings/ai_model` with `Authorization: Bearer <token>` and `{value:'openai/gpt-4o'}` → 200; `GET /admin/settings/ai_model` → value present.
  - `PUT /admin/settings/ai_model` with NO auth header → 401 (global guard).
  - `PUT /admin/settings/not_a_key` → 400.
  - `POST /admin/tokens {label:'x'}` → 201 with a token; `GET /admin/tokens` → contains it (no plaintext); `DELETE /admin/tokens/:id` → 200.

- [ ] **Step 2: Run** `nvm use 24 && npx jest --config test/jest-e2e.json test/admin-config.e2e-spec.ts` → PASS.

- [ ] **Step 3: ADR-0028** — record: the admin config HTTP surface (settings CRUD + token management), the known-keys registry (why validated not free-form), org config already at `/api/organization` (not duplicated), bootstrap via `onModuleInit` init-token, everything behind the global `ApiTokenGuard`.

- [ ] **Step 4: Full gate** `nvm use 24 && npm run build && npm run lint && npm run test && npm run test:e2e` → all green. Grep gate `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"` empty.

- [ ] **Step 5: Commit** `git add test/admin-config.e2e-spec.ts docs/adr/0028-admin-config-http-api.md && git commit -m "test(admin)+docs(adr-0028): admin config HTTP API e2e + ADR"`

---

## Self-Review (author checklist — completed)

**1. Spec coverage:** settings registry+service → Task 1; settings HTTP CRUD → Task 2; token list (metadata) → Task 3; token management HTTP → Task 4; e2e + ADR + gate → Task 5. Org config: already exists (`/api/organization`), explicitly not duplicated. Bootstrap: existing `onModuleInit` init-token, no work. ✅

**2. Placeholder scan:** the `onConflict` upsert idiom and `AuthModule` export of `ApiTokenService` carry "verify against the repo" notes — those are real existing-pattern confirmations, not TODOs (the engineer matches the established idiom). No bare TODOs.

**3. Type consistency:** `KNOWN_SETTINGS`/`isKnownSettingKey`, `SettingsService.{get,list,set,delete}`, `SetSettingDto`/`CreateTokenDto` (static `schema`), `ApiTokenService.list()` shape (`{id,label,created_at,revoked_at}`, never `token_hash`) are consistent across Tasks 1–5.

---

## Execution Handoff

5 tasks, each red→green→commit under Node 24, run from the `/Users/alekseirevin/test/hb-settings` worktree. Sequential (registry→service→controllers→tokens→e2e). Security-sensitive (token plaintext returned once, never listed/logged) — review Tasks 3–4 carefully. Recommended: subagent-driven.
