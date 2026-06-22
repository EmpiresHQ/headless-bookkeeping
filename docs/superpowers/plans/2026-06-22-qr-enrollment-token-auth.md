# QR Enrollment Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-time, short-lived QR enrollment-token flow so a mobile app can exchange a scanned token for a long-lived mobile session token, with QR produced by both the web SPA and the CLI.

**Architecture:** Extend the existing single `api_token` table with a `kind` discriminator (`static`/`enrollment`/`session`) plus `expires_at` and `consumed_at`. Enrollment and session tokens reuse the existing hash/verify/revoke machinery. The global `ApiTokenGuard` gains kind-scoping so an enrollment token is only accepted on the exchange route. Three new HTTP endpoints (under `/api`) drive create-enrollment / exchange / self-revoke; the SPA and CLI both render the versioned QR payload.

**Tech Stack:** NestJS 11, Kysely + better-sqlite3, yargs CLI, React 18 + Vite SPA, Jest (server), Vitest (web).

## Global Constraints

- Server unit tests: `cd packages/server && npx jest -c jest.config.cjs <path>`.
- Server e2e tests: `cd packages/server && npx jest --config ./test/jest-e2e.json <name>`.
- Web tests: `cd packages/web && npx vitest run <path>`.
- No plaintext token is ever stored — only `sha256(token)` via the existing `hashToken`.
- New HTTP routes MUST live under the `/api` prefix; serve-static only excludes `/api`, `/admin`, `/health`, so any route outside those is swallowed by the SPA static handler.
- Controllers declare their full path in `@Controller(...)` (there is no global prefix).
- Enrollment TTL default: 600 seconds. Session tokens are eternal (`expires_at = null`).
- `kind` values are exactly `'static' | 'enrollment' | 'session'`. Existing rows backfill to `'static'`.
- QR payload shape is exactly `{ v: 1, api: string, enroll: string }`.
- Single-tenant: no `tenantId`/`userId`/`refreshToken` in any contract.

---

### Task 1: Migration 051 — add `kind` / `expires_at` / `consumed_at`

**Files:**
- Create: `packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.ts`
- Modify: `packages/server/src/database/migrations/index.ts` (import + register `m051`)
- Modify: `packages/server/src/database/types.ts:431-440` (`ApiTokenTable`)
- Test: `packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.spec.ts`

**Interfaces:**
- Produces: `api_token` rows now carry `kind: 'static'|'enrollment'|'session'` (default `'static'`), `expires_at: number | null`, `consumed_at: number | null`. `ApiTokenTable` gains `kind: Generated<string>`, `expires_at: number | null`, `consumed_at: number | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.spec.ts`:

```typescript
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 051 — api_token lifecycle columns', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  });

  afterEach(async () => db.destroy());

  it('defaults kind to static and lifecycle columns to null', async () => {
    await db
      .insertInto('api_token')
      .values({ token_hash: 'h1', label: 'x' })
      .execute();
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'expires_at', 'consumed_at'])
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('static');
    expect(row.expires_at).toBeNull();
    expect(row.consumed_at).toBeNull();
  });

  it('accepts an enrollment row with expiry', async () => {
    await db
      .insertInto('api_token')
      .values({
        token_hash: 'h2',
        label: 'enroll',
        kind: 'enrollment',
        expires_at: 1750000000,
      })
      .execute();
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'expires_at'])
      .where('token_hash', '=', 'h2')
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('enrollment');
    expect(row.expires_at).toBe(1750000000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/database/migrations/051_add_api_token_kind_lifecycle.spec.ts`
Expected: FAIL — `kind`/`expires_at`/`consumed_at` columns do not exist (SQLite error) or type errors.

- [ ] **Step 3: Create the migration**

Create `packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.ts`:

```typescript
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('api_token')
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('static'))
    .execute();
  await db.schema
    .alterTable('api_token')
    .addColumn('expires_at', 'integer')
    .execute();
  await db.schema
    .alterTable('api_token')
    .addColumn('consumed_at', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('api_token').dropColumn('consumed_at').execute();
  await db.schema.alterTable('api_token').dropColumn('expires_at').execute();
  await db.schema.alterTable('api_token').dropColumn('kind').execute();
}
```

- [ ] **Step 4: Register the migration**

In `packages/server/src/database/migrations/index.ts`, add the import after the `m050` line:

```typescript
import * as m051 from './051_add_api_token_kind_lifecycle';
```

and add to the `migrations` record after the `'050_create_statutory_submission_event'` entry:

```typescript
  '051_add_api_token_kind_lifecycle': m051,
```

- [ ] **Step 5: Update the table type**

In `packages/server/src/database/types.ts`, replace the `ApiTokenTable` interface (currently lines 431-440) with:

```typescript
export interface ApiTokenTable {
  id: Generated<number>;
  // SHA-256 hash of the plaintext token.
  token_hash: string;
  // Human-readable label (e.g. "init-token", or a device name for sessions).
  label: string | null;
  created_at: Generated<number>;
  // Unix seconds when revoked; NULL = active.
  revoked_at: number | null;
  // Token role: 'static' (CLI/operator), 'enrollment' (one-time QR), 'session' (mobile).
  kind: Generated<string>;
  // Unix seconds when the token expires; NULL = never (static/session).
  expires_at: number | null;
  // Unix seconds when a one-time enrollment token was exchanged; NULL = unused.
  consumed_at: number | null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/database/migrations/051_add_api_token_kind_lifecycle.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts \
        packages/server/src/database/migrations/051_add_api_token_kind_lifecycle.spec.ts
git commit -m "feat(auth): add kind/expires_at/consumed_at to api_token (migration 051)"
```

---

### Task 2: `verify()` returns `kind` and excludes expired/consumed

**Files:**
- Modify: `packages/server/src/auth/api-token.service.ts:89-113` (`verify`)
- Test: `packages/server/src/auth/api-token.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: `api_token` columns from Task 1.
- Produces: `verify(plaintext)` resolves to `{ id; token_hash; label; created_at; revoked_at; kind; expires_at; consumed_at } | null`. Returns `null` for expired (`expires_at <= now`) or consumed (`consumed_at != null`) tokens.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/auth/api-token.service.spec.ts` (inside the existing top-level `describe`; reuse its `db`/`service` setup — match the file's existing `beforeEach`):

```typescript
describe('verify — kind + lifecycle', () => {
  it('returns the kind for a static token', async () => {
    const { token } = await service.create('s');
    const row = await service.verify(token);
    expect(row?.kind).toBe('static');
  });

  it('rejects an expired enrollment token', async () => {
    const plaintext = 'expired-enroll';
    const hash = require('crypto')
      .createHash('sha256')
      .update(plaintext)
      .digest('hex');
    await db
      .insertInto('api_token')
      .values({
        token_hash: hash,
        label: 'e',
        kind: 'enrollment',
        expires_at: Math.floor(Date.now() / 1000) - 10,
      })
      .execute();
    expect(await service.verify(plaintext)).toBeNull();
  });

  it('rejects a consumed enrollment token', async () => {
    const plaintext = 'used-enroll';
    const hash = require('crypto')
      .createHash('sha256')
      .update(plaintext)
      .digest('hex');
    await db
      .insertInto('api_token')
      .values({
        token_hash: hash,
        label: 'e',
        kind: 'enrollment',
        expires_at: Math.floor(Date.now() / 1000) + 600,
        consumed_at: Math.floor(Date.now() / 1000),
      })
      .execute();
    expect(await service.verify(plaintext)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts -t "kind + lifecycle"`
Expected: FAIL — `row.kind` is undefined; expired/consumed tokens still returned.

- [ ] **Step 3: Update `verify`**

In `packages/server/src/auth/api-token.service.ts`, replace the `verify` method body (lines 89-113) with:

```typescript
  async verify(plaintext: string): Promise<{
    id: number;
    token_hash: string;
    label: string | null;
    created_at: number;
    revoked_at: number | null;
    kind: string;
    expires_at: number | null;
    consumed_at: number | null;
  } | null> {
    const candidateHash = hashToken(plaintext);
    const now = Math.floor(Date.now() / 1000);

    const tokens = await this.db
      .selectFrom('api_token')
      .select([
        'id',
        'token_hash',
        'label',
        'created_at',
        'revoked_at',
        'kind',
        'expires_at',
        'consumed_at',
      ])
      .where('revoked_at', 'is', null)
      .where('consumed_at', 'is', null)
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]),
      )
      .execute();

    for (const token of tokens) {
      if (constantTimeEqual(candidateHash, token.token_hash)) {
        return token;
      }
    }

    return null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts`
Expected: PASS (existing cases + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/api-token.service.ts packages/server/src/auth/api-token.service.spec.ts
git commit -m "feat(auth): verify() returns kind and excludes expired/consumed tokens"
```

---

### Task 3: `create(label, kind)` + `createEnrollment()`

**Files:**
- Modify: `packages/server/src/auth/api-token.service.ts:70-83` (`create`), add `createEnrollment`
- Test: `packages/server/src/auth/api-token.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: `verify` (Task 2).
- Produces:
  - `create(label: string, kind?: 'static'|'enrollment'|'session'): Promise<{ id: number; token: string }>` — default kind `'static'`.
  - `createEnrollment(ttlSeconds?: number): Promise<{ id: number; token: string; expiresAt: number }>` — default `ttlSeconds = 600`; `expiresAt` is unix seconds.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/auth/api-token.service.spec.ts`:

```typescript
describe('create + createEnrollment', () => {
  it('mints a session token when kind is session', async () => {
    const { id } = await service.create('iPhone', 'session');
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'label'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('session');
    expect(row.label).toBe('iPhone');
  });

  it('createEnrollment sets kind=enrollment and a future expiry', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { id, token, expiresAt } = await service.createEnrollment(600);
    expect(token).toHaveLength(64);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600);
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'expires_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('enrollment');
    expect(row.expires_at).toBe(expiresAt);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts -t "create + createEnrollment"`
Expected: FAIL — `create` rejects the 2nd arg / `createEnrollment` is not a function.

- [ ] **Step 3: Update `create` and add `createEnrollment`**

In `packages/server/src/auth/api-token.service.ts`, replace the `create` method (lines 70-83) with:

```typescript
  async create(
    label: string,
    kind: 'static' | 'enrollment' | 'session' = 'static',
  ): Promise<{ id: number; token: string }> {
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);

    const result = await this.db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label, kind })
      .executeTakeFirst();

    return { id: Number(result.insertId), token: plaintext };
  }

  /**
   * Mint a one-time, short-lived enrollment token for the QR flow.
   * Returns the plaintext (rendered into the QR) and its expiry (unix seconds).
   */
  async createEnrollment(
    ttlSeconds = 600,
  ): Promise<{ id: number; token: string; expiresAt: number }> {
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

    const result = await this.db
      .insertInto('api_token')
      .values({
        token_hash: tokenHash,
        label: 'enrollment',
        kind: 'enrollment',
        expires_at: expiresAt,
      })
      .executeTakeFirst();

    return { id: Number(result.insertId), token: plaintext, expiresAt };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/api-token.service.ts packages/server/src/auth/api-token.service.spec.ts
git commit -m "feat(auth): create(kind) + createEnrollment()"
```

---

### Task 4: `exchangeEnrollment()` — atomic one-time exchange

**Files:**
- Modify: `packages/server/src/auth/api-token.service.ts` (add `exchangeEnrollment`)
- Test: `packages/server/src/auth/api-token.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: `createEnrollment` (Task 3), `verify` (Task 2).
- Produces: `exchangeEnrollment(plaintext: string, deviceName: string): Promise<{ id: number; token: string }>` — throws `Error('invalid or expired enrollment token')` when the token is not a live unconsumed enrollment; on success consumes the enrollment and returns a freshly minted `session` token.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/auth/api-token.service.spec.ts`:

```typescript
describe('exchangeEnrollment', () => {
  it('consumes the enrollment and mints a session token', async () => {
    const { id: enrollId, token: enroll } = await service.createEnrollment();
    const { id: sessionId, token: session } = await service.exchangeEnrollment(
      enroll,
      'Pixel 8',
    );

    const enrollRow = await db
      .selectFrom('api_token')
      .select(['consumed_at'])
      .where('id', '=', enrollId)
      .executeTakeFirstOrThrow();
    expect(enrollRow.consumed_at).not.toBeNull();

    const sessionRow = await db
      .selectFrom('api_token')
      .select(['kind', 'label'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(sessionRow.kind).toBe('session');
    expect(sessionRow.label).toBe('Pixel 8');

    expect(await service.verify(session)).not.toBeNull();
  });

  it('rejects a second exchange of the same enrollment token', async () => {
    const { token: enroll } = await service.createEnrollment();
    await service.exchangeEnrollment(enroll, 'first');
    await expect(service.exchangeEnrollment(enroll, 'second')).rejects.toThrow(
      'invalid or expired enrollment token',
    );
  });

  it('rejects a non-enrollment token', async () => {
    const { token: staticTok } = await service.create('s');
    await expect(
      service.exchangeEnrollment(staticTok, 'x'),
    ).rejects.toThrow('invalid or expired enrollment token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts -t "exchangeEnrollment"`
Expected: FAIL — `exchangeEnrollment` is not a function.

- [ ] **Step 3: Add `exchangeEnrollment`**

In `packages/server/src/auth/api-token.service.ts`, add this method (after `createEnrollment`):

```typescript
  /**
   * Exchange a one-time enrollment token for a mobile session token.
   * Atomic: the enrollment is consumed inside the same transaction that mints
   * the session, and the conditional UPDATE guards against double-spend.
   */
  async exchangeEnrollment(
    plaintext: string,
    deviceName: string,
  ): Promise<{ id: number; token: string }> {
    const enrollment = await this.verify(plaintext);
    if (!enrollment || enrollment.kind !== 'enrollment') {
      throw new Error('invalid or expired enrollment token');
    }

    const now = Math.floor(Date.now() / 1000);
    const sessionPlaintext = generateToken();
    const sessionHash = hashToken(sessionPlaintext);

    return this.db.transaction().execute(async (trx) => {
      const consumed = await trx
        .updateTable('api_token')
        .set({ consumed_at: now })
        .where('id', '=', enrollment.id)
        .where('consumed_at', 'is', null)
        .executeTakeFirst();

      if (Number(consumed.numUpdatedRows) !== 1) {
        throw new Error('invalid or expired enrollment token');
      }

      const inserted = await trx
        .insertInto('api_token')
        .values({
          token_hash: sessionHash,
          label: deviceName,
          kind: 'session',
        })
        .executeTakeFirst();

      return { id: Number(inserted.insertId), token: sessionPlaintext };
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/api-token.service.ts packages/server/src/auth/api-token.service.spec.ts
git commit -m "feat(auth): exchangeEnrollment() — atomic one-time enrollment exchange"
```

---

### Task 5: Guard kind-scoping + `@EnrollmentOnly()`

**Files:**
- Modify: `packages/server/src/auth/api-token.guard.ts`
- Test: `packages/server/src/auth/api-token.guard.spec.ts` (add controller routes + cases)

**Interfaces:**
- Consumes: `verify` returning `kind` (Task 2).
- Produces:
  - `export const EnrollmentOnly = () => ...` decorator marking a route to accept only `kind === 'enrollment'`.
  - Default (undecorated) routes accept only `kind in ['static','session']`; an enrollment token there → 401.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/auth/api-token.guard.spec.ts`, add an enrollment-only route to the test controller and new cases. Add to `TestController`:

```typescript
  @EnrollmentOnly()
  @Post('exchange')
  postExchange(): { ok: boolean } {
    return { ok: true };
  }
```

Update the import line `import { ApiTokenGuard, Public } from './api-token.guard';` to:

```typescript
import { ApiTokenGuard, Public, EnrollmentOnly } from './api-token.guard';
```

and add `Post` to the `@nestjs/common` import. Then add a `describe`:

```typescript
describe('kind scoping', () => {
  it('rejects an enrollment token on a default route', async () => {
    const { token } = await apiTokenService.createEnrollment();
    await request(app.getHttpServer())
      .get('/test/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('accepts an enrollment token on an @EnrollmentOnly route', async () => {
    const { token } = await apiTokenService.createEnrollment();
    await request(app.getHttpServer())
      .post('/test/exchange')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  });

  it('rejects a static token on an @EnrollmentOnly route', async () => {
    await request(app.getHttpServer())
      .post('/test/exchange')
      .set('Authorization', `Bearer ${initToken}`)
      .expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.guard.spec.ts -t "kind scoping"`
Expected: FAIL — `EnrollmentOnly` not exported; enrollment token currently passes on the default route.

- [ ] **Step 3: Add the decorator and scoping logic**

In `packages/server/src/auth/api-token.guard.ts`, after the `Public` declaration add:

```typescript
export const TOKEN_KINDS_KEY = 'tokenKinds';

/**
 * Restrict a route to enrollment tokens only (the QR-exchange endpoint).
 * Static/session tokens are rejected; enrollment tokens are rejected everywhere
 * else by the guard's default allow-list.
 */
export const EnrollmentOnly = () =>
  SetMetadata(TOKEN_KINDS_KEY, ['enrollment']);
```

Then in `canActivate`, replace the block that attaches the token (after `if (!valid) { throw ... }`) with:

```typescript
    const allowedKinds = this.reflector.getAllAndOverride<string[]>(
      TOKEN_KINDS_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? ['static', 'session'];

    if (!allowedKinds.includes(valid.kind)) {
      throw new UnauthorizedException('Token kind not allowed for this route');
    }

    // Attach token info to the request for downstream use.
    (request as Record<string, unknown>)['apiToken'] = valid;

    return true;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/auth/api-token.guard.spec.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/api-token.guard.ts packages/server/src/auth/api-token.guard.spec.ts
git commit -m "feat(auth): guard kind-scoping + @EnrollmentOnly decorator"
```

---

### Task 6: `MobileAuthController` — enroll / exchange / revoke

**Files:**
- Create: `packages/server/src/auth/mobile-auth.controller.ts`
- Modify: `packages/server/src/auth/auth.module.ts` (register controller)
- Test: `packages/server/test/mobile-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `ApiTokenService.createEnrollment`, `exchangeEnrollment`, `revoke`; `EnrollmentOnly` (Task 5); `Public` is NOT used (all three routes are guarded).
- Produces HTTP routes:
  - `POST /api/device-enrollments` → `{ apiBaseUrl: string; enrollmentToken: string; expiresAt: string }` (ISO-8601).
  - `POST /api/mobile/sessions` (enrollment-only) body `{ deviceName: string }` → `{ accessToken: string }`.
  - `POST /api/mobile/sessions/revoke` → 204.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/mobile-auth.e2e-spec.ts` (model the bootstrap on `app.e2e-spec.ts`; key shape below):

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../src/database/types';
import { seedApiToken, auth } from './e2e-auth';

describe('Mobile enrollment auth (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let staticToken: string;

  beforeAll(async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.test';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<Kysely<Database>>(KYSELY_MODULE_CONNECTION_TOKEN());
    staticToken = await seedApiToken(db);
  });

  afterAll(async () => app.close());

  it('runs the full enroll → exchange → call → revoke cycle', async () => {
    // 1. Operator mints an enrollment token.
    const enrollRes = await request(app.getHttpServer())
      .post('/api/device-enrollments')
      .set('Authorization', `Bearer ${staticToken}`)
      .expect(201);
    expect(enrollRes.body.apiBaseUrl).toBe('https://api.example.test');
    expect(typeof enrollRes.body.enrollmentToken).toBe('string');
    expect(typeof enrollRes.body.expiresAt).toBe('string');
    const enroll = enrollRes.body.enrollmentToken as string;

    // 2. Exchange it for a session token.
    const exchangeRes = await request(app.getHttpServer())
      .post('/api/mobile/sessions')
      .set('Authorization', `Bearer ${enroll}`)
      .send({ deviceName: 'iPhone QA' })
      .expect(201);
    const session = exchangeRes.body.accessToken as string;
    expect(typeof session).toBe('string');

    // 3. Session token works on a normal API route.
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);

    // 4. The same enrollment token cannot be exchanged again.
    await request(app.getHttpServer())
      .post('/api/mobile/sessions')
      .set('Authorization', `Bearer ${enroll}`)
      .send({ deviceName: 'dupe' })
      .expect(401);

    // 5. Self-revoke, then the session token stops working.
    await request(app.getHttpServer())
      .post('/api/mobile/sessions/revoke')
      .set('Authorization', `Bearer ${session}`)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${session}`)
      .expect(401);
  });

  it('rejects an enrollment token on a normal API route', async () => {
    const enrollRes = await request(app.getHttpServer())
      .post('/api/device-enrollments')
      .set('Authorization', `Bearer ${staticToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/organization')
      .set('Authorization', `Bearer ${enrollRes.body.enrollmentToken}`)
      .expect(401);
  });
});
```

(`auth` from `e2e-auth.ts` is available if you prefer it over inline `.set`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest --config ./test/jest-e2e.json mobile-auth`
Expected: FAIL — routes 404 (controller not registered).

- [ ] **Step 3: Create the controller**

Create `packages/server/src/auth/mobile-auth.controller.ts`:

```typescript
import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiTokenService } from './api-token.service';
import { EnrollmentOnly } from './api-token.guard';

const exchangeSchema = z.object({ deviceName: z.string().min(1) });
export class ExchangeDto extends createZodDto(exchangeSchema) {}

@ApiTags('mobile-auth')
@Controller('api')
export class MobileAuthController {
  constructor(private readonly apiTokenService: ApiTokenService) {}

  /** POST /api/device-enrollments — mint a one-time QR enrollment token. */
  @ApiOperation({ summary: 'Create a device enrollment token' })
  @Post('device-enrollments')
  @HttpCode(HttpStatus.CREATED)
  async createEnrollment() {
    const apiBaseUrl = process.env.PUBLIC_API_URL;
    if (!apiBaseUrl) {
      throw new InternalServerErrorException('PUBLIC_API_URL is not configured');
    }
    const { token, expiresAt } = await this.apiTokenService.createEnrollment();
    return {
      apiBaseUrl,
      enrollmentToken: token,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  /** POST /api/mobile/sessions — exchange an enrollment token for a session. */
  @ApiOperation({ summary: 'Exchange an enrollment token for a mobile session' })
  @EnrollmentOnly()
  @Post('mobile/sessions')
  @HttpCode(HttpStatus.CREATED)
  async exchange(
    @Req() req: { apiToken: { token_hash: string } },
    @Body() body: ExchangeDto,
  ) {
    // The guard already verified an enrollment token; resolve & consume by
    // its plaintext via the Authorization header is unnecessary — the service
    // re-verifies the plaintext, so pass it through from the header.
    const header = (req as unknown as {
      headers: Record<string, string | undefined>;
    }).headers['authorization']!;
    const plaintext = header.slice('Bearer '.length);
    try {
      const { token } = await this.apiTokenService.exchangeEnrollment(
        plaintext,
        body.deviceName,
      );
      return { accessToken: token };
    } catch {
      throw new UnauthorizedException('invalid or expired enrollment token');
    }
  }

  /** POST /api/mobile/sessions/revoke — revoke the calling session token. */
  @ApiOperation({ summary: 'Revoke the current mobile session token' })
  @Post('mobile/sessions/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Req() req: { apiToken: { id: number } }) {
    await this.apiTokenService.revoke(req.apiToken.id);
  }
}
```

Note the exchange handler needs the request including `headers`; widen the `@Req()` type as shown. The guard runs first and rejects non-enrollment tokens before this method executes.

- [ ] **Step 4: Register the controller**

In `packages/server/src/auth/auth.module.ts`, add the import and `controllers`:

```typescript
import { MobileAuthController } from './mobile-auth.controller';
```

and update the `@Module({...})`:

```typescript
@Module({
  imports: [DatabaseModule],
  controllers: [MobileAuthController],
  providers: [ApiTokenService, ApiTokenGuard],
  exports: [ApiTokenService, ApiTokenGuard],
})
export class AuthModule {}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && npx jest --config ./test/jest-e2e.json mobile-auth`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/mobile-auth.controller.ts packages/server/src/auth/auth.module.ts packages/server/test/mobile-auth.e2e-spec.ts
git commit -m "feat(auth): mobile enrollment endpoints (enroll/exchange/revoke)"
```

---

### Task 7: CLI `token enroll` with terminal QR

**Files:**
- Modify: `packages/server/package.json` (add `qrcode-terminal` + `@types/qrcode-terminal`)
- Modify: `packages/server/src/cli/cli.ts` (add `token enroll` subcommand)
- Test: `packages/server/src/cli/cli.spec.ts` (add cases; if no spec exists, create it following the buildCli unit-test pattern)

**Interfaces:**
- Consumes: `ApiTokenService.createEnrollment` (Task 3) via `CliDeps.tokens`.
- Produces: `cli token enroll [--ttl <sec>] [--api <url>] [--label <name>]` — prints JSON `{ v, api, enroll, expiresAt }` to stdout (`io.out`) and an ASCII QR + human note to stderr (`io.err`). Errors (no `--api` / `PUBLIC_API_URL`) go through `io.err` and reject.

- [ ] **Step 1: Add dependencies**

Run:

```bash
cd packages/server && npm install qrcode-terminal && npm install -D @types/qrcode-terminal
```

- [ ] **Step 2: Write the failing test**

Add to `packages/server/src/cli/cli.spec.ts` (create the file if absent — instantiate `buildCli` with a fake `tokens` whose `createEnrollment` returns a fixed value, and capture `out`/`err`):

```typescript
describe('token enroll', () => {
  const makeIo = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
  };

  const fakeTokens = {
    createEnrollment: async () => ({ id: 1, token: 'enr0lltok', expiresAt: 1750000000 }),
  } as unknown as import('../auth/api-token.service').ApiTokenService;

  it('prints a JSON payload with v:1 and the enroll token to stdout', async () => {
    const { io, out } = makeIo();
    const cli = buildCli({ tokens: fakeTokens } as any, io);
    await cli.parseAsync(['token', 'enroll', '--api', 'https://api.example.test']);
    const payload = JSON.parse(out.join(''));
    expect(payload.v).toBe(1);
    expect(payload.api).toBe('https://api.example.test');
    expect(payload.enroll).toBe('enr0lltok');
  });

  it('fails when no --api and no PUBLIC_API_URL', async () => {
    const prev = process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_API_URL;
    const { io } = makeIo();
    const cli = buildCli({ tokens: fakeTokens } as any, io);
    await expect(
      cli.parseAsync(['token', 'enroll']),
    ).rejects.toThrow(/api/i);
    if (prev !== undefined) process.env.PUBLIC_API_URL = prev;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/cli/cli.spec.ts -t "token enroll"`
Expected: FAIL — `enroll` is not a known subcommand (strict mode rejects).

- [ ] **Step 4: Add the subcommand**

In `packages/server/src/cli/cli.ts`, add the import at the top:

```typescript
import qrcode from 'qrcode-terminal';
```

Then, inside the `token` command builder (after the `revoke <id>` command, before `.demandCommand(1, 'Specify a token subcommand')`), add:

```typescript
          .command(
            'enroll',
            'Mint a one-time enrollment token and render it as a QR code',
            (y) =>
              y
                .option('ttl', {
                  type: 'number',
                  default: 600,
                  describe: 'Lifetime in seconds',
                })
                .option('api', {
                  type: 'string',
                  describe: 'API base URL (falls back to PUBLIC_API_URL)',
                })
                .option('label', {
                  type: 'string',
                  default: 'enrollment',
                  describe: 'Human label',
                }),
            async (argv) => {
              const api = argv.api ?? process.env.PUBLIC_API_URL;
              if (!api) {
                throw new Error(
                  'enroll requires --api or PUBLIC_API_URL to be set',
                );
              }
              const { token, expiresAt } = await tokens.createEnrollment(
                argv.ttl,
              );
              const payload = { v: 1, api, enroll: token };
              // Human-facing QR + note → stderr (does not pollute stdout JSON).
              qrcode.generate(JSON.stringify(payload), { small: true }, (qr) =>
                io.err(`${qr}\n`),
              );
              io.err(`enrollment expires in ${argv.ttl}s\n`);
              // Machine-readable payload → stdout.
              io.out(json({ ...payload, expiresAt }));
            },
          )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/cli/cli.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json packages/server/package-lock.json packages/server/src/cli/cli.ts packages/server/src/cli/cli.spec.ts
git commit -m "feat(cli): token enroll — mint enrollment token + terminal QR"
```

---

### Task 8: SPA "Enroll device" screen

**Files:**
- Modify: `packages/web/package.json` (add `qrcode` + `@types/qrcode`)
- Modify: `packages/web/src/api.ts` (add `createDeviceEnrollment`)
- Create: `packages/web/src/components/EnrollView.tsx`
- Modify: `packages/web/src/tabs.tsx` (add the tab)
- Test: `packages/web/src/components/EnrollView.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `./auth`; `POST /api/device-enrollments` (Task 6).
- Produces:
  - `createDeviceEnrollment(): Promise<DeviceEnrollment>` where `DeviceEnrollment = { apiBaseUrl: string; enrollmentToken: string; expiresAt: string }`.
  - `EnrollView` React component, default-exported as a named export `EnrollView`.

- [ ] **Step 1: Add dependencies**

Run:

```bash
cd packages/web && npm install qrcode && npm install -D @types/qrcode
```

- [ ] **Step 2: Write the failing test**

Create `packages/web/src/components/EnrollView.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnrollView } from './EnrollView';
import * as api from '../api';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,FAKE') },
}));

describe('EnrollView', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a QR image after fetching an enrollment token', async () => {
    vi.spyOn(api, 'createDeviceEnrollment').mockResolvedValue({
      apiBaseUrl: 'https://api.example.test',
      enrollmentToken: 'enr0lltok',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    render(<EnrollView />);

    const img = await screen.findByAltText('Enrollment QR code');
    await waitFor(() =>
      expect(img).toHaveAttribute('src', 'data:image/png;base64,FAKE'),
    );
  });

  it('shows an error message when the request fails', async () => {
    vi.spyOn(api, 'createDeviceEnrollment').mockRejectedValue(
      new Error('boom'),
    );
    render(<EnrollView />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/EnrollView.test.tsx`
Expected: FAIL — `EnrollView` / `createDeviceEnrollment` do not exist.

- [ ] **Step 4: Add the API function**

In `packages/web/src/api.ts`, add (near the other POST helpers):

```typescript
export interface DeviceEnrollment {
  apiBaseUrl: string;
  enrollmentToken: string;
  expiresAt: string;
}

export const createDeviceEnrollment = () =>
  apiFetch<DeviceEnrollment>('/api/device-enrollments', { method: 'POST' });
```

- [ ] **Step 5: Create the component**

Create `packages/web/src/components/EnrollView.tsx`:

```typescript
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { createDeviceEnrollment, type DeviceEnrollment } from '../api';

export function EnrollView() {
  const [qr, setQr] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setError(null);
      setQr(null);
      try {
        const e = await createDeviceEnrollment();
        if (cancelled) return;
        setEnrollment(e);
        const payload = JSON.stringify({
          v: 1,
          api: e.apiBaseUrl,
          enroll: e.enrollmentToken,
        });
        const dataUrl = await QRCode.toDataURL(payload);
        if (!cancelled) setQr(dataUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="font-semibold">Enroll a mobile device</h2>
      {error && <p className="text-red-600">{error}</p>}
      {qr && <img src={qr} alt="Enrollment QR code" width={256} height={256} />}
      {enrollment && (
        <p className="text-sm text-gray-600">
          Expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}
        </p>
      )}
      <button
        className="rounded bg-gray-800 px-3 py-1 text-white"
        onClick={() => setReloadKey((k) => k + 1)}
      >
        Regenerate
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Register the tab**

In `packages/web/src/tabs.tsx`, add the import:

```typescript
import { EnrollView } from './components/EnrollView';
```

add a tab definition (near `settingsTab`):

```typescript
const enrollTab: TabDef = {
  key: 'enroll',
  label: 'Enroll device',
  load: async () => [],
  columns: [],
  Custom: EnrollView,
};
```

and add `enrollTab` to the `TABS` array (before `settingsTab`).

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/components/EnrollView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/web/package.json packages/web/package-lock.json packages/web/src/api.ts packages/web/src/components/EnrollView.tsx packages/web/src/tabs.tsx packages/web/src/components/EnrollView.test.tsx
git commit -m "feat(web): Enroll device tab — render QR for device enrollment"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Server unit + e2e + web + lint**

Run each and confirm green:

```bash
cd packages/server && npx jest -c jest.config.cjs
cd packages/server && npx jest --config ./test/jest-e2e.json
cd packages/web && npx vitest run
cd packages/server && npm run lint
cd packages/web && npm run lint
```

Expected: all suites pass, lint clean. If anything fails, fix before claiming completion (invoke superpowers:systematic-debugging if a failure is non-obvious).

- [ ] **Step 2: Commit any lint fixups**

```bash
git add -A && git commit -m "chore(auth): lint/format fixups for enrollment flow"
```

---

## Self-Review

**Spec coverage:**
- §1 data model → Task 1. ✅
- §2 service (`verify`/`create`/`createEnrollment`/`exchangeEnrollment`) → Tasks 2,3,4. ✅
- §3 guard kind-scoping + `@EnrollmentOnly` → Task 5. ✅
- §4 HTTP contract (3 endpoints) → Task 6. ✅ (paths namespaced under `/api` per Global Constraints; `apiBaseUrl` from `PUBLIC_API_URL`.)
- §5 QR payload → produced identically in Task 6 (`/device-enrollments` returns the parts), Task 7 (CLI builds `{v,api,enroll}`), Task 8 (SPA builds `{v,api,enroll}`). ✅
- §6 SPA screen → Task 8. ✅
- §7 CLI `token enroll` → Task 7. ✅
- §8 error handling → covered across guard 401 (Task 5/6), atomic consume (Task 4), `PUBLIC_API_URL` missing (Task 6), idempotent revoke (existing `revoke`). ✅
- §9 testing → each task is TDD; Task 9 runs the full suite. ✅

**Type consistency:** `createEnrollment` returns `{ id, token, expiresAt }` (Task 3) and is consumed by Task 6 (uses `token`, `expiresAt`) and Task 7 (uses `token`, `expiresAt`). `exchangeEnrollment(plaintext, deviceName)` (Task 4) consumed by Task 6. `kind` values consistent (`'static'|'enrollment'|'session'`). `EnrollmentOnly` exported in Task 5, imported in Tasks 5/6. `DeviceEnrollment` shape consistent between api.ts (Task 8) and the controller response (Task 6: `apiBaseUrl`/`enrollmentToken`/`expiresAt`). ✅

**Placeholder scan:** no TBD/TODO; every code step has complete code. ✅
