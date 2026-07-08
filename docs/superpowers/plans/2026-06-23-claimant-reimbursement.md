# Claimant Reimbursement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claimant (employee/director) as a first-class Entity role so receipts paid out of pocket post to `Cr CLAIMANT_PAYABLE` instead of `Cr AP`, with a triage gate where the approver confirms payment.

**Architecture:** `claimant_id` is persisted on the `document` row at upload time (channel context is lost by the time the async worker runs), carried through `IntakeWorkflowService` → `ProposeDraftService` → `Expense`, and switched on in `VoucherProjectionService` to change the credit leg. All claimant documents unconditionally route to `needs_triage`; the approver confirms "did this person pay?" via `POST /api/documents/:id/confirm-payment`. `company_addressed_receipt` on `Expense` drives VAT reclaim eligibility in the projection.

**Tech Stack:** NestJS 11, Kysely (SQLite), Zod 4, Jest 30. Test command: `npx jest <path> --no-coverage`.

## Global Constraints

- SQLite cannot ALTER TABLE to change a CHECK constraint — always use the 12-step rebuild (rename → create new → copy → drop old → rename new).
- All amounts are integer cents (minor units). Dates are `YYYY-MM-DD`.
- Every migration ships paired with a `.spec.ts` (or piggybacks on service-layer tests for pure-seed migrations).
- ADR-0036 is the authoritative design doc: `docs/adr/0036-claimant-employee-director-expense-reimbursement.md`.
- Supplier on an Expense is ALWAYS the original vendor — never the Claimant.
- `vat_amount` on the Expense always reflects what is printed on the document and is never mutated.

---

## File Map

| Action | File |
|--------|------|
| Create | `packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.ts` |
| Create | `packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.spec.ts` |
| Create | `packages/server/src/database/migrations/055_add_document_claimant_id.ts` |
| Create | `packages/server/src/database/migrations/055_add_document_claimant_id.spec.ts` |
| Create | `packages/server/src/database/migrations/056_add_expense_claimant_fields.ts` |
| Create | `packages/server/src/database/migrations/057_seed_claimant_payable_account.ts` |
| Modify | `packages/server/src/database/migrations/index.ts` — register 054–057 |
| Modify | `packages/server/src/database/types.ts` — add `claimant_id` to DocumentTable + ExpenseTable, add `company_addressed_receipt` to ExpenseTable |
| Modify | `packages/server/src/entities/types.ts` — add `employee\|director` to EntityRole, `tg_user_id` to IdentifierKind, update `onboardEntitySchema` |
| Modify | `packages/server/src/entities/entities.service.ts` — `onboard()` branches on role for identifier creation |
| Modify | `packages/server/src/entities/entities.service.spec.ts` — add claimant onboarding tests |
| Modify | `packages/server/src/expenses/types.ts` — add `claimant_id` and `company_addressed_receipt` to `Expense` + `createExpenseSchema` |
| Modify | `packages/server/src/ledger/projection/types.ts` — add `claimantId?` and `companyAddressedReceipt?` to EconomicFacts |
| Modify | `packages/server/src/ledger/projection/voucher-projection.service.ts` — `purchaseLines()` switches credit leg |
| Modify | `packages/server/src/ledger/projection/voucher-projection.service.spec.ts` — new purchase tests |
| Modify | `packages/server/src/documents/documents.service.ts` — `upload()` accepts `claimantId?`, new `confirmPayment()` |
| Modify | `packages/server/src/documents/documents.service.spec.ts` — new upload + confirm-payment tests |
| Modify | `packages/server/src/documents/documents.controller.ts` — `claimant_id` body param + `confirm-payment` endpoint |
| Modify | `packages/server/src/intake-queue/intake-queue.worker.ts` — `claimNextPending` result carries `claimant_id` |
| Modify | `packages/server/src/intake-queue/intake-queue.worker.spec.ts` — assert claimant_id forwarded |
| Modify | `packages/server/src/ai/intake-workflow.service.ts` — `process(documentId, claimantId?)`, claimant → always needs_triage |
| Modify | `packages/server/src/ai/intake-workflow.service.spec.ts` — new claimant routing tests |
| Modify | `packages/server/src/ai/propose-draft.service.ts` — `proposeDraft()` carries `claimantId?` and `companyAddressedReceipt?` to CreateExpenseDto |

---

## Task 1: Migration 054 — widen entity.role + add tg_user_id identifier kind

**Files:**
- Create: `packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.ts`
- Create: `packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.spec.ts`
- Modify: `packages/server/src/database/migrations/index.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `entity.role` CHECK accepts `'employee' | 'director'`; `entity_identifier.kind` CHECK accepts `'tg_user_id'`

- [ ] **Step 1: Write the failing spec**

```typescript
// 054_widen_entity_role_add_tg_user_id.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 054: widen entity role + add tg_user_id identifier kind', () => {
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
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  it('allows employee and director roles', async () => {
    const now = Math.floor(Date.now() / 1000);
    const emp = await db
      .insertInto('entity')
      .values({ role: 'employee', country: 'EE', name: 'Alice', goods_vs_services: null, created_at: now, updated_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(emp.role).toBe('employee');

    const dir = await db
      .insertInto('entity')
      .values({ role: 'director', country: 'EE', name: 'Bob', goods_vs_services: null, created_at: now, updated_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(dir.role).toBe('director');
  });

  it('allows tg_user_id as identifier kind', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({ role: 'employee', country: 'EE', name: 'Alice', goods_vs_services: null, created_at: now, updated_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();

    const ident = await db
      .insertInto('entity_identifier')
      .values({ entity_id: entity.id, kind: 'tg_user_id', value: '123456789', confirmed: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(ident.kind).toBe('tg_user_id');
  });
});
```

- [ ] **Step 2: Run spec — verify it fails**

```bash
npx jest 054_widen_entity_role_add_tg_user_id.spec --no-coverage
```

Expected: FAIL — module not found or migration index missing 054.

- [ ] **Step 3: Write the migration**

```typescript
// 054_widen_entity_role_add_tg_user_id.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

const ENTITY_COLS = `id, role, country, name, goods_vs_services, created_at, updated_at`;
const IDENT_COLS = `id, entity_id, kind, value, confirmed`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  // 1. Widen entity.role
  await sql`
    CREATE TABLE entity_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('supplier', 'customer', 'employee', 'director')),
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      goods_vs_services TEXT CHECK (goods_vs_services IN ('goods', 'services', 'unknown')),
      created_at INTEGER,
      updated_at INTEGER
    )
  `.execute(db);
  await sql`INSERT INTO entity_new (${sql.raw(ENTITY_COLS)}) SELECT ${sql.raw(ENTITY_COLS)} FROM entity`.execute(db);
  await sql`DROP TABLE entity`.execute(db);
  await sql`ALTER TABLE entity_new RENAME TO entity`.execute(db);

  // 2. Add tg_user_id to entity_identifier.kind
  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias',
        'email', 'phone', 'address', 'tg_user_id'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);
  await sql`INSERT INTO entity_identifier_new (${sql.raw(IDENT_COLS)}) SELECT ${sql.raw(IDENT_COLS)} FROM entity_identifier`.execute(db);
  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('supplier', 'customer')),
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      goods_vs_services TEXT CHECK (goods_vs_services IN ('goods', 'services', 'unknown')),
      created_at INTEGER,
      updated_at INTEGER
    )
  `.execute(db);
  await sql`INSERT INTO entity_new (${sql.raw(ENTITY_COLS)}) SELECT ${sql.raw(ENTITY_COLS)} FROM entity WHERE role IN ('supplier', 'customer')`.execute(db);
  await sql`DROP TABLE entity`.execute(db);
  await sql`ALTER TABLE entity_new RENAME TO entity`.execute(db);

  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias',
        'email', 'phone', 'address'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);
  await sql`INSERT INTO entity_identifier_new (${sql.raw(IDENT_COLS)}) SELECT ${sql.raw(IDENT_COLS)} FROM entity_identifier WHERE kind IN ('registration_key', 'iban', 'merchant_descriptor', 'name_alias', 'email', 'phone', 'address')`.execute(db);
  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 4: Register migration in index.ts**

Open `packages/server/src/database/migrations/index.ts` and add:
```typescript
import * as m054 from './054_widen_entity_role_add_tg_user_id';
// in the migrations object:
'054_widen_entity_role_add_tg_user_id': m054,
```

- [ ] **Step 5: Run spec — verify it passes**

```bash
npx jest 054_widen_entity_role_add_tg_user_id.spec --no-coverage
```

Expected: PASS (2 tests)

- [ ] **Step 6: Run full unit suite — verify no regressions**

```bash
npm test -- --no-coverage
```

Expected: same pass count as before ± 2 new tests.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.ts \
        packages/server/src/database/migrations/054_widen_entity_role_add_tg_user_id.spec.ts \
        packages/server/src/database/migrations/index.ts
git commit -m "feat(claimant): migration 054 — entity role employee|director + tg_user_id identifier kind"
```

---

## Task 2: Migration 055 — document.claimant_id + DB types

**Files:**
- Create: `packages/server/src/database/migrations/055_add_document_claimant_id.ts`
- Create: `packages/server/src/database/migrations/055_add_document_claimant_id.spec.ts`
- Modify: `packages/server/src/database/migrations/index.ts`
- Modify: `packages/server/src/database/types.ts`

**Interfaces:**
- Consumes: migration 054 (entity with employee/director roles exists)
- Produces: `DocumentTable.claimant_id: number | null`; `documents.service.ts` can read/write it

- [ ] **Step 1: Write the failing spec**

```typescript
// 055_add_document_claimant_id.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 055: document.claimant_id', () => {
  it('adds nullable claimant_id defaulting to null', async () => {
    const db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();

    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({ hash: 'h1', filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 100, storage_path: null, status: 'pending', created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(doc.claimant_id).toBeNull();
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run spec — verify it fails**

```bash
npx jest 055_add_document_claimant_id.spec --no-coverage
```

Expected: FAIL — `doc.claimant_id` property does not exist.

- [ ] **Step 3: Write the migration**

```typescript
// 055_add_document_claimant_id.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE document ADD COLUMN claimant_id INTEGER REFERENCES entity(id)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite cannot DROP COLUMN with a FK — rebuild required.
  // In practice, down() is only used in dev; production rolls forward.
  const COLS = `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, created_at`;
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_triage_result TEXT,
      processing_since INTEGER,
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document`.execute(db);
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 4: Add to DB types**

In `packages/server/src/database/types.ts`, inside `DocumentTable`, add after `processing_attempts`:

```typescript
// Nullable FK → entity(id). Set at upload time when the sender is a known
// Claimant (role: employee | director). The IntakeQueueWorker reads this
// and passes it to IntakeWorkflowService so channel context is not lost.
claimant_id: number | null;
```

Note: use `number | null`, not `Generated<...>` — there is no DB default; the column is nullable and the app writes it explicitly.

- [ ] **Step 5: Register in index.ts**

```typescript
import * as m055 from './055_add_document_claimant_id';
// in the migrations object:
'055_add_document_claimant_id': m055,
```

- [ ] **Step 6: Run spec — verify it passes**

```bash
npx jest 055_add_document_claimant_id.spec --no-coverage
```

Expected: PASS (1 test)

- [ ] **Step 7: Run full suite**

```bash
npm test -- --no-coverage
```

Expected: all existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/database/migrations/055_add_document_claimant_id.ts \
        packages/server/src/database/migrations/055_add_document_claimant_id.spec.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts
git commit -m "feat(claimant): migration 055 — document.claimant_id nullable FK"
```

---

## Task 3: Migrations 056+057 — expense claimant fields + CLAIMANT_PAYABLE account

**Files:**
- Create: `packages/server/src/database/migrations/056_add_expense_claimant_fields.ts`
- Create: `packages/server/src/database/migrations/057_seed_claimant_payable_account.ts`
- Modify: `packages/server/src/database/migrations/index.ts`
- Modify: `packages/server/src/database/types.ts` — add to ExpenseTable
- Modify: `packages/server/src/expenses/types.ts` — add to Expense + createExpenseSchema

**Interfaces:**
- Produces: `expense.claimant_id: number | null`, `expense.company_addressed_receipt: number | null` (SQLite boolean), `CLAIMANT_PAYABLE` account row in DB

- [ ] **Step 1: Write migration 056**

```typescript
// 056_add_expense_claimant_fields.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE expense ADD COLUMN claimant_id INTEGER REFERENCES entity(id)`.execute(db);
  await sql`ALTER TABLE expense ADD COLUMN company_addressed_receipt INTEGER`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite: drop columns via rebuild; prod only rolls forward.
  const COLS = `id, document_id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status, voucher_id, document_vat_marking, supplier_invoice_number, asset_name, asset_useful_life_years, asset_residual_value_minor, created_at, updated_at`;
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE expense_new AS SELECT ${sql.raw(COLS)} FROM expense
  `.execute(db);
  await sql`DROP TABLE expense`.execute(db);
  await sql`ALTER TABLE expense_new RENAME TO expense`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 2: Write migration 057**

```typescript
// 057_seed_claimant_payable_account.ts
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('account')
    .values({
      code: 'CLAIMANT_PAYABLE',
      name: 'Claimant Payable',
      type: 'liability',
      currency: null,
      parent_id: null,
      is_system: 1,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('account').where('code', '=', 'CLAIMANT_PAYABLE').execute();
}
```

- [ ] **Step 3: Register both in index.ts**

```typescript
import * as m056 from './056_add_expense_claimant_fields';
import * as m057 from './057_seed_claimant_payable_account';
// in the migrations object:
'056_add_expense_claimant_fields': m056,
'057_seed_claimant_payable_account': m057,
```

- [ ] **Step 4: Update DB types**

In `packages/server/src/database/types.ts`, inside `ExpenseTable`, add after `asset_residual_value_minor`:

```typescript
// Set when the Expense was paid by a Claimant out of pocket (migration 056).
// null = normal AP expense; set → CLAIMANT_PAYABLE credit leg.
claimant_id: number | null;
// Whether the receipt is addressed to the Organisation (migration 056).
// true → normal VAT reclaim; false | null → NULL_VAT_CODE (conservative).
// Stored as INTEGER (0/1/null) per SQLite boolean convention.
company_addressed_receipt: number | null;
```

- [ ] **Step 5: Update expense app types**

In `packages/server/src/expenses/types.ts`:

Add to `Expense` interface after `supplier_invoice_number`:
```typescript
claimant_id: number | null;
company_addressed_receipt: boolean | null;
```

Add to `createExpenseSchema` after `supplier_invoice_number`:
```typescript
claimant_id: z.number().int().positive().nullable().optional(),
company_addressed_receipt: z.boolean().nullable().optional(),
```

- [ ] **Step 6: Run full suite**

```bash
npm test -- --no-coverage
```

Expected: all tests pass. The new nullable columns have no defaults, so existing tests still insert expenses without them (SQLite treats missing columns as NULL for nullable columns).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/migrations/056_add_expense_claimant_fields.ts \
        packages/server/src/database/migrations/057_seed_claimant_payable_account.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts \
        packages/server/src/expenses/types.ts
git commit -m "feat(claimant): migrations 056+057 — expense claimant fields + CLAIMANT_PAYABLE account"
```

---

## Task 4: Entity API — employee/director claimant onboarding

**Files:**
- Modify: `packages/server/src/entities/types.ts`
- Modify: `packages/server/src/entities/entities.service.ts`
- Modify: `packages/server/src/entities/entities.service.spec.ts`

**Interfaces:**
- Consumes: migration 054 (employee|director role + tg_user_id kind exist in DB)
- Produces: `POST /api/entities` with `{ role: 'employee', name: '...', country: '...', email: '...', tgUserId?: '...' }` creates an Entity with email + optional tg_user_id identifiers

- [ ] **Step 1: Write failing tests**

Add to `packages/server/src/entities/entities.service.spec.ts` (inside the existing `describe('EntitiesService')` block):

```typescript
describe('claimant onboarding (employee/director)', () => {
  it('creates an employee entity with email and tg_user_id identifiers', async () => {
    const result = await service.onboard({
      role: 'employee',
      country: 'EE',
      name: 'Alice Tamm',
      email: 'alice@acme.ee',
      tgUserId: '987654321',
    } as any);

    expect(result.role).toBe('employee');
    expect(result.identifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'email', value: 'alice@acme.ee' }),
        expect.objectContaining({ kind: 'tg_user_id', value: '987654321' }),
      ]),
    );
  });

  it('creates an employee entity with email only (tg_user_id optional)', async () => {
    const result = await service.onboard({
      role: 'director',
      country: 'EE',
      name: 'Bob Kask',
      email: 'bob@acme.ee',
    } as any);

    expect(result.role).toBe('director');
    expect(result.identifiers).toHaveLength(1);
    expect(result.identifiers[0]).toMatchObject({ kind: 'email', value: 'bob@acme.ee' });
  });

  it('resolves employee by tg_user_id', async () => {
    await service.onboard({
      role: 'employee',
      country: 'EE',
      name: 'Alice Tamm',
      email: 'alice@acme.ee',
      tgUserId: '111222333',
    } as any);

    const found = await service.resolveByIdentifier('tg_user_id', '111222333');
    expect(found).toBeDefined();
    expect(found!.role).toBe('employee');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx jest entities.service.spec --no-coverage
```

Expected: FAIL — `onboard()` throws because `registrationKey` is missing and schema rejects employee role.

- [ ] **Step 3: Update types.ts — discriminated union schema**

Replace `onboardEntitySchema` in `packages/server/src/entities/types.ts`:

```typescript
export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director';
export type IdentifierKind =
  | 'registration_key'
  | 'iban'
  | 'merchant_descriptor'
  | 'name_alias'
  | 'email'
  | 'phone'
  | 'address'
  | 'tg_user_id';

const onboardSupplierCustomerSchema = z.object({
  role: z.enum(['supplier', 'customer']),
  country: z.string(),
  name: z.string(),
  registrationKey: z.string(),
  goodsVsServices: z.enum(['goods', 'services', 'unknown']).optional(),
});

const onboardClaimantSchema = z.object({
  role: z.enum(['employee', 'director']),
  country: z.string(),
  name: z.string(),
  email: z.string().email(),
  tgUserId: z.string().optional(),
});

export const onboardEntitySchema = z.discriminatedUnion('role', [
  onboardSupplierCustomerSchema,
  onboardClaimantSchema,
]);

export type OnboardEntityInput = z.infer<typeof onboardEntitySchema>;
export class OnboardEntityDto extends createZodDto(onboardEntitySchema) {}
```

- [ ] **Step 4: Update entities.service.ts — branch in onboard()**

In `entities.service.ts`, replace the `onboard()` method body:

```typescript
async onboard(dto: OnboardEntityInput): Promise<EntityWithIdentifiers> {
  const now = Math.floor(Date.now() / 1000);

  const entity = await this.db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('entity')
      .values({
        role: dto.role,
        country: dto.country,
        name: dto.name,
        goods_vs_services: 'goodsVsServices' in dto ? (dto.goodsVsServices ?? null) : null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (dto.role === 'supplier' || dto.role === 'customer') {
      const regKey = normalizeIdentifier('registration_key', dto.registrationKey);
      await trx
        .insertInto('entity_identifier')
        .values({
          entity_id: row.id,
          kind: 'registration_key',
          value: regKey ?? dto.registrationKey,
          confirmed: 1,
        })
        .execute();
    } else {
      // employee | director: email is the primary lookup key; tg_user_id is optional
      const identifiers: Array<{ kind: string; value: string }> = [
        { kind: 'email', value: dto.email },
      ];
      if (dto.tgUserId) {
        identifiers.push({ kind: 'tg_user_id', value: dto.tgUserId });
      }
      await trx
        .insertInto('entity_identifier')
        .values(identifiers.map((i) => ({ entity_id: row.id, kind: i.kind, value: i.value, confirmed: 1 })))
        .execute();
    }

    return row;
  });

  const identifiers = await this.getIdentifiers(entity.id);
  return { ...this.mapEntity(entity), identifiers };
}
```

Also update the `OnboardEntityDto` import — it now comes from the new type:
```typescript
import { OnboardEntityInput, /* ... */ } from './types';
// change the parameter type:
async onboard(dto: OnboardEntityInput): Promise<EntityWithIdentifiers>
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
npx jest entities.service.spec --no-coverage
```

Expected: all existing + 3 new tests PASS.

- [ ] **Step 6: Run full suite**

```bash
npm test -- --no-coverage
```

Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/entities/types.ts \
        packages/server/src/entities/entities.service.ts \
        packages/server/src/entities/entities.service.spec.ts
git commit -m "feat(claimant): entity API accepts employee|director role with email+tg_user_id identifiers"
```

---

## Task 5: Documents API — claimant_id on upload + confirm-payment endpoint

**Files:**
- Modify: `packages/server/src/documents/documents.service.ts`
- Modify: `packages/server/src/documents/documents.service.spec.ts`
- Modify: `packages/server/src/documents/documents.controller.ts`

**Interfaces:**
- Consumes: `DocumentTable.claimant_id` (Task 2)
- Produces:
  - `DocumentsService.upload({ ..., claimantId?: number | null })` — persists claimant_id
  - `DocumentsService.confirmPayment(documentId: number, paidByClaimant: boolean): Promise<void>` — sets or clears claimant_id based on approver decision
  - `POST /api/documents` body gains optional `claimant_id: number`
  - `POST /api/documents/:id/confirm-payment` body `{ paid_by_claimant: boolean }`

- [ ] **Step 1: Write failing service tests**

Add to `packages/server/src/documents/documents.service.spec.ts`:

```typescript
describe('upload with claimant_id', () => {
  it('persists claimant_id on the document row when provided', async () => {
    // Assumes an entity with id=1 already exists in the test DB setup,
    // or mock the FK check. Check existing spec setup pattern.
    const { document } = await service.upload({
      buffer: Buffer.from('pdf'),
      filename: 'receipt.pdf',
      mimeType: 'application/pdf',
      channel: 'upload',
      sourceIdentifier: null,
      capturedAt: null,
      precheckJson: null,
      claimantId: 1,
    });
    expect(document.claimant_id).toBe(1);
  });

  it('defaults claimant_id to null when not provided', async () => {
    const { document } = await service.upload({
      buffer: Buffer.from('pdf2'),
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      channel: 'upload',
      sourceIdentifier: null,
      capturedAt: null,
      precheckJson: null,
    });
    expect(document.claimant_id).toBeNull();
  });
});

describe('confirmPayment', () => {
  it('clears claimant_id when paid_by_claimant is false', async () => {
    // create a doc with claimant_id set
    const { document: doc } = await service.upload({
      buffer: Buffer.from('r'),
      filename: 'r.pdf',
      mimeType: 'application/pdf',
      channel: 'upload',
      sourceIdentifier: null,
      capturedAt: null,
      precheckJson: null,
      claimantId: 1,
    });
    await service.confirmPayment(doc.id, false);
    const updated = await service.getById(doc.id);
    expect(updated.claimant_id).toBeNull();
  });

  it('keeps claimant_id when paid_by_claimant is true', async () => {
    const { document: doc } = await service.upload({
      buffer: Buffer.from('r2'),
      filename: 'r2.pdf',
      mimeType: 'application/pdf',
      channel: 'upload',
      sourceIdentifier: null,
      capturedAt: null,
      precheckJson: null,
      claimantId: 1,
    });
    await service.confirmPayment(doc.id, true);
    const updated = await service.getById(doc.id);
    expect(updated.claimant_id).toBe(1);
  });

  it('throws NotFoundException for unknown document', async () => {
    await expect(service.confirmPayment(9999, true)).rejects.toThrow('not found');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx jest documents.service.spec --no-coverage
```

Expected: FAIL — `claimantId` not accepted, `confirmPayment` not defined.

- [ ] **Step 3: Update Document type in documents/types.ts**

Add `claimant_id: number | null` to the `Document` interface (wherever it is defined; keep consistent with the DB shape).

- [ ] **Step 4: Update documents.service.ts**

Find the `upload(input: {...})` method and extend its input type:

```typescript
// Add to the upload input type:
claimantId?: number | null;

// In the insertInto('document').values({...}) call, add:
claimant_id: input.claimantId ?? null,
```

Add new method `confirmPayment`:

```typescript
async confirmPayment(documentId: number, paidByClaimant: boolean): Promise<void> {
  const doc = await this.db
    .selectFrom('document')
    .select('id')
    .where('id', '=', documentId)
    .executeTakeFirst();
  if (!doc) {
    throw new NotFoundException(`Document ${documentId} not found`);
  }

  if (!paidByClaimant) {
    await this.db
      .updateTable('document')
      .set({ claimant_id: null })
      .where('id', '=', documentId)
      .execute();
  }
  // paidByClaimant=true: claimant_id was already set at upload time; no change needed.
}
```

- [ ] **Step 5: Update documents.controller.ts**

Add `claimant_id` to the `@Body()` destructuring in `uploadDocument()`:

```typescript
body: {
  channel?: string;
  assetLocalId?: string;
  capturedAt?: string;
  precheck?: string;
  claimant_id?: string; // multipart form sends strings
},
```

Pass it to the service:
```typescript
const result = await this.documentsService.upload({
  // ... existing params ...
  claimantId: body.claimant_id ? Number(body.claimant_id) : null,
});
```

Add the confirm-payment endpoint:

```typescript
@Post(':id/confirm-payment')
@ApiOperation({
  summary: 'Confirm whether the claimant paid out of pocket',
  description: 'Approver action point: sets or clears claimant_id based on payment confirmation.',
})
@ApiParam({ name: 'id', description: 'Document id' })
@HttpCode(HttpStatus.NO_CONTENT)
async confirmPayment(
  @Param('id') id: string,
  @Body() body: { paid_by_claimant: boolean },
): Promise<void> {
  await this.documentsService.confirmPayment(Number(id), body.paid_by_claimant);
}
```

- [ ] **Step 6: Run tests — verify they pass**

```bash
npx jest documents.service.spec --no-coverage
```

Expected: all existing + new tests PASS.

- [ ] **Step 7: Run full suite**

```bash
npm test -- --no-coverage
```

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/documents/documents.service.ts \
        packages/server/src/documents/documents.service.spec.ts \
        packages/server/src/documents/documents.controller.ts \
        packages/server/src/documents/types.ts
git commit -m "feat(claimant): documents upload accepts claimant_id, add confirm-payment endpoint"
```

---

## Task 6: VoucherProjectionService — Cr CLAIMANT_PAYABLE + VAT suppression

**Files:**
- Modify: `packages/server/src/ledger/projection/types.ts`
- Modify: `packages/server/src/ledger/projection/voucher-projection.service.ts`
- Modify: `packages/server/src/ledger/projection/voucher-projection.service.spec.ts`

**Interfaces:**
- Consumes: `CLAIMANT_PAYABLE` account row (Task 3), `Expense.claimant_id` + `company_addressed_receipt` (Task 3)
- Produces: when `EconomicFacts.claimantId != null` → credit leg is `CLAIMANT_PAYABLE` instead of `AP`; when `EconomicFacts.companyAddressedReceipt` is `false | null` → no VAT_RECEIVABLE line (effective vatAmount = 0)

- [ ] **Step 1: Write failing tests**

Add to `packages/server/src/ledger/projection/voucher-projection.service.spec.ts`, inside the `describe('purchase direction (Expense)')` block:

```typescript
it('credits CLAIMANT_PAYABLE (not AP) when claimantId is set', async () => {
  const draft = await service.projectDraft(
    {
      category: 'meals',
      grossAmount: 2400,
      vatAmount: 400,
      currency: 'EUR',
      taxPointDate: '2026-06-01',
      claimantId: 7,
    },
    'purchase',
  );

  const credit = draft.lines.find((l) => !l.is_debit);
  expect(credit?.account_code).toBe('CLAIMANT_PAYABLE');
  const ap = draft.lines.find((l) => l.account_code === 'AP');
  expect(ap).toBeUndefined();
});

it('credits AP (not CLAIMANT_PAYABLE) when claimantId is null', async () => {
  const draft = await service.projectDraft(
    {
      category: 'software',
      grossAmount: 10000,
      vatAmount: 2300,
      currency: 'EUR',
      taxPointDate: '2026-06-01',
      claimantId: null,
    },
    'purchase',
  );

  const credit = draft.lines.find((l) => !l.is_debit);
  expect(credit?.account_code).toBe('AP');
});

it('omits VAT_RECEIVABLE when companyAddressedReceipt is false', async () => {
  const draft = await service.projectDraft(
    {
      category: 'meals',
      grossAmount: 1200,
      vatAmount: 200,
      currency: 'EUR',
      taxPointDate: '2026-06-01',
      claimantId: 3,
      companyAddressedReceipt: false,
    },
    'purchase',
  );

  const vatLine = draft.lines.find((l) => l.account_code === 'VAT_RECEIVABLE');
  expect(vatLine).toBeUndefined();

  // Full gross must be expensed (no VAT split)
  const expenseLine = draft.lines.find((l) => l.is_debit && l.account_code !== 'VAT_RECEIVABLE');
  expect(expenseLine?.amount).toBe(1200);
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx jest voucher-projection.service.spec --no-coverage
```

Expected: FAIL — `claimantId`/`companyAddressedReceipt` not in EconomicFacts, projection always uses AP.

- [ ] **Step 3: Update EconomicFacts**

In `packages/server/src/ledger/projection/types.ts`, add to `EconomicFacts`:

```typescript
/**
 * When set, the credit leg posts to CLAIMANT_PAYABLE instead of AP.
 * Null (or absent) → AP (normal supplier expense).
 */
claimantId?: number | null;
/**
 * Whether the receipt is addressed to the Organisation.
 * false | null → no VAT_RECEIVABLE line (conservative — no reclaim when uncertain).
 * Only meaningful for claimant-paid expenses; absent → treated as true.
 */
companyAddressedReceipt?: boolean | null;
```

- [ ] **Step 4: Update purchaseLines() in voucher-projection.service.ts**

Find the `purchaseLines()` private method. Replace the `Cr AP` line with a conditional:

```typescript
private purchaseLines(
  facts: EconomicFacts,
  netAmount: number,
  mapping: { accountCode: string; vatCode: string },
  fxRate: number,
  baseAmount: (amount: number) => number,
): DraftVoucherLine[] {
  // When the receipt is not company-addressed (or unknown), no VAT reclaim.
  const canReclaimVat = facts.companyAddressedReceipt !== false && facts.companyAddressedReceipt !== null;
  // If companyAddressedReceipt is undefined (not a claimant expense), default to true.
  const effectiveCanReclaim = facts.companyAddressedReceipt === undefined ? true : canReclaimVat;

  const effectiveVatAmount = effectiveCanReclaim ? facts.vatAmount : 0;
  const effectiveNetAmount = facts.grossAmount - effectiveVatAmount;

  const creditAccountCode = facts.claimantId != null ? 'CLAIMANT_PAYABLE' : 'AP';

  return [
    {
      account_code: mapping.accountCode,
      amount: effectiveNetAmount,
      currency: facts.currency,
      base_amount: baseAmount(effectiveNetAmount),
      fx_rate: fxRate,
      vat_code: mapping.vatCode,
      is_debit: true,
    },
    ...(effectiveVatAmount > 0
      ? [
          {
            account_code: 'VAT_RECEIVABLE',
            amount: effectiveVatAmount,
            currency: facts.currency,
            base_amount: baseAmount(effectiveVatAmount),
            fx_rate: fxRate,
            vat_code: mapping.vatCode,
            is_debit: true,
          },
        ]
      : []),
    {
      account_code: creditAccountCode,
      amount: facts.grossAmount,
      currency: facts.currency,
      base_amount: baseAmount(facts.grossAmount),
      fx_rate: fxRate,
      vat_code: null,
      is_debit: false,
    },
  ];
}
```

Note: `netAmount` parameter is now computed inside the method from `grossAmount - effectiveVatAmount`. Remove the `netAmount` parameter from the signature and recompute it internally, or keep it and override. Check what the caller passes.

Look up the `projectDraft()` call site for `purchaseLines()` and ensure `netAmount` computation (gross − vat) is done AFTER the effective-vat override. The safest refactor: compute `netAmount` inside `purchaseLines()` directly from `facts.grossAmount - effectiveVatAmount`.

- [ ] **Step 5: Update ExpensesService.generateDraftVoucher() to pass new fields**

In `packages/server/src/expenses/expenses.service.ts`, find where it builds `EconomicFacts` for projection, and add:

```typescript
claimantId: expense.claimant_id ?? null,
companyAddressedReceipt: expense.company_addressed_receipt === null
  ? null
  : expense.company_addressed_receipt === 1,
```

(SQLite stores booleans as `0 | 1 | null`; convert to TypeScript `boolean | null`.)

- [ ] **Step 6: Run tests — verify they pass**

```bash
npx jest voucher-projection.service.spec --no-coverage
```

Expected: all 11 existing + 3 new tests PASS.

- [ ] **Step 7: Run full suite**

```bash
npm test -- --no-coverage
```

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/ledger/projection/types.ts \
        packages/server/src/ledger/projection/voucher-projection.service.ts \
        packages/server/src/ledger/projection/voucher-projection.service.spec.ts \
        packages/server/src/expenses/expenses.service.ts
git commit -m "feat(claimant): VoucherProjection credits CLAIMANT_PAYABLE when claimant_id set, suppresses VAT reclaim when not company-addressed"
```

---

## Task 7: Intake propagation — Worker reads claimant_id, Service routes claimant docs to needs_triage

**Files:**
- Modify: `packages/server/src/documents/documents.service.ts` — `claimNextPending()` returns `{ id, claimant_id }`
- Modify: `packages/server/src/intake-queue/intake-queue.worker.ts` — pass claimant_id to process()
- Modify: `packages/server/src/intake-queue/intake-queue.worker.spec.ts`
- Modify: `packages/server/src/ai/intake-workflow.service.ts` — `process(id, claimantId?)` + always needs_triage for claimants
- Modify: `packages/server/src/ai/intake-workflow.service.spec.ts`

**Interfaces:**
- Consumes: `document.claimant_id` (Task 2)
- Produces:
  - `claimNextPending(staleSeconds, maxAttempts)` returns `{ id: number; claimant_id: number | null } | null`
  - `IntakeWorkflowService.process(documentId: number, claimantId?: number | null)` — when `claimantId != null`, runs Pass-1 + Pass-2 fully (to extract amounts, supplier, category, `company_addressed_receipt`), then **overrides the routing decision** to `needs_triage` after Pass-2 regardless of confidence

- [ ] **Step 1: Write failing worker test**

In `packages/server/src/intake-queue/intake-queue.worker.spec.ts`, add:

```typescript
it('passes claimant_id from the claimed document to workflow.process', async () => {
  const processedWith: Array<{ id: number; claimantId: number | null | undefined }> = [];

  const mockDocs = {
    claimNextPending: jest.fn()
      .mockResolvedValueOnce({ id: 42, claimant_id: 7 })
      .mockResolvedValue(null),
  } as any;

  const mockWorkflow = {
    process: jest.fn().mockImplementation((id: number, claimantId?: number | null) => {
      processedWith.push({ id, claimantId });
      return Promise.resolve({ kind: 'needs_triage' });
    }),
  } as any;

  const worker = new IntakeQueueWorker(mockDocs, mockWorkflow);
  await worker.drainLoop();

  expect(processedWith).toEqual([{ id: 42, claimantId: 7 }]);
});
```

- [ ] **Step 2: Write failing service test**

In `packages/server/src/ai/intake-workflow.service.spec.ts`, add a test describing the claimant routing shortcut:

```typescript
describe('claimant routing', () => {
  it('routes to needs_triage after Pass-2 completes when claimantId is set', async () => {
    // Set up a pending document
    const docId = await createTestDocument(db);

    // Call process with a claimantId — Pass-1 + Pass-2 run normally,
    // then routing is overridden to needs_triage regardless of confidence.
    const result = await service.process(docId, 5);

    expect(result.kind).toBe('needs_triage');
    // Verify the audit finding mentions the claimant
    const findings = await db.selectFrom('audit_finding').selectAll().execute();
    expect(findings.length).toBeGreaterThan(0);
  });
});
```

Look at existing tests in `intake-workflow.service.spec.ts` for the `createTestDocument` helper pattern to follow exactly.

- [ ] **Step 3: Run tests — verify they fail**

```bash
npx jest intake-queue.worker.spec intake-workflow.service.spec --no-coverage
```

Expected: FAIL — `claimNextPending` still returns `number | null`, `process` has no claimantId param.

- [ ] **Step 4: Update claimNextPending() return type**

In `packages/server/src/documents/documents.service.ts`, change `claimNextPending()` to return `{ id: number; claimant_id: number | null } | null`:

```typescript
async claimNextPending(
  staleSeconds: number,
  maxAttempts: number,
): Promise<{ id: number; claimant_id: number | null } | null> {
  // ... existing atomic claim logic ...
  // Change the SELECT to include claimant_id
  // Return { id: row.id, claimant_id: row.claimant_id } instead of just row.id
}
```

Find the existing implementation and update the select + return value. The WHERE/UPDATE logic stays identical — only the return shape changes.

- [ ] **Step 5: Update worker to pass claimant_id**

In `packages/server/src/intake-queue/intake-queue.worker.ts`:

```typescript
// Change:
let id: number | null;
while ((id = await this.documents.claimNextPending(...)) !== null) {
  await this.workflow.process(id);
}

// To:
let claimed: { id: number; claimant_id: number | null } | null;
while ((claimed = await this.documents.claimNextPending(STALE_SECONDS, MAX_ATTEMPTS)) !== null) {
  try {
    await this.workflow.process(claimed.id, claimed.claimant_id);
  } catch (err) {
    this.logger.error(
      `Intake processing failed for document ${claimed.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
```

Remove the inner try/catch from the old `id` variable — restructure to match.

- [ ] **Step 6: Update IntakeWorkflowService.process()**

In `packages/server/src/ai/intake-workflow.service.ts`:

```typescript
async process(documentId: number, claimantId?: number | null): Promise<IntakeWorkflowResult> {
  return this.gate.run(documentId, () => this.processInner(documentId, claimantId));
}

private async processInner(documentId: number, claimantId?: number | null): Promise<IntakeWorkflowResult> {
  // Run Pass-1 OCR and Pass-2 classification NORMALLY — do NOT skip for claimants.
  // Claimant docs need OCR artefacts so that:
  //   a) company_addressed_receipt is extracted (drives VAT reclaim eligibility)
  //   b) amounts/category are available when confirm-payment triggers Expense creation
  //   c) email-sync's recipient_match extraction can run
  //
  // ... existing Pass-1 + Pass-2 logic runs here unchanged ...

  // AFTER Pass-2: if a claimantId is set, override the routing decision to
  // needs_triage regardless of confidence — approver must confirm payment.
  // This is the ONLY change from the normal flow; extraction is unaffected.
  if (claimantId != null) {
    await this.auditFindings.create({
      document_id: documentId,
      severity: 'info',
      message: `Document submitted by Claimant (entity ${claimantId}) — approver must confirm payment.`,
    });
    await this.documents.updateStatus(documentId, 'needs_triage');
    return { kind: 'needs_triage', reason: 'claimant_payment_confirmation_required' };
  }

  // ... rest of existing routing logic (normal non-claimant path) unchanged ...
}
```

- [ ] **Step 7: Run tests — verify they pass**

```bash
npx jest intake-queue.worker.spec intake-workflow.service.spec --no-coverage
```

Expected: all existing + new tests PASS.

- [ ] **Step 8: Run full suite**

```bash
npm test -- --no-coverage
```

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/documents/documents.service.ts \
        packages/server/src/intake-queue/intake-queue.worker.ts \
        packages/server/src/intake-queue/intake-queue.worker.spec.ts \
        packages/server/src/ai/intake-workflow.service.ts \
        packages/server/src/ai/intake-workflow.service.spec.ts
git commit -m "feat(claimant): worker forwards claimant_id to intake, claimant docs always route to needs_triage"
```

---

## Task 8: ProposeDraftService — carry claimant_id + company_addressed_receipt to Expense

**Files:**
- Modify: `packages/server/src/ai/propose-draft.service.ts`
- Modify: `packages/server/src/ai/intake-workflow.service.spec.ts` (or propose-draft.service.spec.ts if it exists)

**Interfaces:**
- Consumes: `CreateExpenseDto.claimant_id` + `company_addressed_receipt` (Task 3), `EconomicFacts.claimantId` (Task 6)
- Produces: when a claimant expense is proposed via the manual-classify triage path (after confirm-payment), the resulting Expense row has `claimant_id` and `company_addressed_receipt` set from Pass 2 output

- [ ] **Step 1: Write failing test**

Find the existing `proposeDraft()` tests in `propose-draft.service.spec.ts` (or search in `intake-workflow.service.spec.ts`). Add:

```typescript
it('propagates claimant_id to the created Expense when provided', async () => {
  const triageResult = {
    kind: 'new_expense' as const,
    category: 'meals',
    grossAmount: 2400,
    vatAmount: 400,
    currency: 'EUR',
    taxPointDate: '2026-06-01',
    confidence: 0.95,
    supplierName: 'Café',
    supplierId: null,
    companyAddressedReceipt: true,
  };

  const result = await service.proposeDraft(triageResult, { documentId: 1, claimantId: 7 });

  const expense = await db
    .selectFrom('expense')
    .selectAll()
    .where('id', '=', result.expenseId)
    .executeTakeFirstOrThrow();

  expect(expense.claimant_id).toBe(7);
  expect(expense.company_addressed_receipt).toBe(1); // SQLite boolean
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx jest propose-draft.service.spec --no-coverage
```

- [ ] **Step 3: Update proposeDraft() signature and body**

In `packages/server/src/ai/propose-draft.service.ts`, find `proposeDraft()`. Its second parameter is `{ documentId?: number }` or similar. Extend it:

```typescript
async proposeDraft(
  triageResult: TriageResult,
  opts: { documentId?: number; claimantId?: number | null } = {},
): Promise<DraftProposalResult> {
  // ...
  const createExpenseDto: CreateExpenseDto = {
    document_id: opts.documentId ?? null,
    supplier_id: resolvedSupplierId,
    category: triageResult.category,
    gross_amount: triageResult.grossAmount,
    vat_amount: triageResult.vatAmount,
    currency: triageResult.currency,
    tax_point_date: triageResult.taxPointDate,
    document_vat_marking: triageResult.documentVatMarking ?? null,
    supplier_invoice_number: triageResult.supplierInvoiceNumber ?? null,
    // Claimant fields:
    claimant_id: opts.claimantId ?? null,
    company_addressed_receipt: triageResult.companyAddressedReceipt ?? null,
  };
  // ...
}
```

Also update the call sites in `IntakeWorkflowService` (the manual-classify path) to pass `claimantId` when it's available from the document row. In the manual-classify path, read `claimant_id` from the document row and forward it.

- [ ] **Step 4: Run test — verify it passes**

```bash
npx jest propose-draft.service.spec --no-coverage
```

- [ ] **Step 5: Run full suite**

```bash
npm test -- --no-coverage
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai/propose-draft.service.ts \
        packages/server/src/ai/propose-draft.service.spec.ts
git commit -m "feat(claimant): ProposeDraftService carries claimant_id and company_addressed_receipt to Expense"
```

---

## Self-Review

### Spec coverage

| ADR-0036 requirement | Covered by |
|---|---|
| `entity.role: employee\|director` | Task 1 (migration), Task 4 (API) |
| `entity_identifier.kind: tg_user_id` | Task 1 (migration), Task 4 (resolveByIdentifier test) |
| `document.claimant_id` persisted at upload | Task 2 (migration), Task 5 (service + controller) |
| `expense.claimant_id + company_addressed_receipt` | Task 3 (migration + types) |
| `CLAIMANT_PAYABLE` kernel account | Task 3 (migration 057) |
| `Cr CLAIMANT_PAYABLE` when claimant_id set | Task 6 (VoucherProjection) |
| `NULL_VAT_CODE` (no VAT_RECEIVABLE) when company_addressed_receipt false\|null | Task 6 (VoucherProjection) |
| All claimant docs → needs_triage | Task 7 (IntakeWorkflowService) |
| Worker passes claimant_id to process() | Task 7 (IntakeQueueWorker) |
| `POST /api/documents/:id/confirm-payment` | Task 5 (controller + service) |
| confirm-payment false → clear claimant_id | Task 5 (service) |
| ProposeDraftService carries claimant_id to Expense | Task 8 |
| `company_addressed_receipt` from Pass 2 → Expense | Task 8 |

### Out of Scope (not in this plan)

- Settlement: `Dr CLAIMANT_PAYABLE / Cr Bank` — v2
- CLAIMANT_ADVANCE — v2
- `hold_claimant_expenses` Policy config gate — the needs_triage shortcut in Task 7 is the conservative default; Policy gate can be layered on in a follow-up
- SPA dropdown UI rendering (REST contract delivered; UI is a separate frontend PR)
- iOS app changes
- Country plugin update for `company_addressed_receipt` (the projection handles it without plugin changes — `NULL_VAT_CODE` is achieved by zeroing effectiveVatAmount before the plugin mapping call)
- Pass 2 prompt update to detect `company_addressed_receipt` from document content
