# Wave 2 Ledger Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the load-bearing defects the Wave-2 review found — the ones Wave 3 builds directly on — so the ledger primitive is actually correct before the posting pipeline stacks on it.

**Architecture:** Push the ledger's core invariants down to the layer that can't be bypassed. Immutability becomes SQLite `BEFORE UPDATE/DELETE` triggers (gated on `posted_at`, so Wave-3's draft→post path still works); per-line shape becomes DB `CHECK` constraints; the cross-row balance + hash chain live in `PostingService`, which becomes the **sole writer** (repositories demoted to read-only). The voucher hash chain (ADR-0013), dropped in the original wave, is wired in. See ADR-0019 (write path), ADR-0013 (hash serialization), ADR-0004 (FX validation boundary), and CONTEXT.md (unsigned-magnitude model).

**Tech Stack:** NestJS 11, Kysely 0.29 over better-sqlite3, Jest 30, `node:crypto` (SHA-256). Tests use the real-DI + real-`Migrator` in-memory-SQLite harness already established in `src/currency/currency.resolution.spec.ts` and `src/ledger/posting/posting.service.spec.ts`.

**Repo baseline (as of `04400b7`):** TypeScript **strict mode is ON** (`tsconfig.json`: `strict`, `module: nodenext`) and the codebase has **zero `any` / `as` casts** — all migrations are now `Kysely<Database>` (not `Kysely<any>`), `account.service` uses a `validateAccountType` guard, e2e tests use `Reflect.get`/matchers instead of casts. Every new file in this plan must stay strict-clean: no `any`, no `as`, typed insert objects. `npm run lint` (typescript-eslint strict) enforces this and is part of the gate. Note: that commit retyped `database.module.spec.ts` but did **not** restore real migrations — H1 still applies.

**Branch:** Work on `wave-2-ledger` (not yet merged — this finishes Wave 2). Run the full gate `npm run build && npm run lint && npm run test && npm run test:e2e` at the end (Task H6).

**Out of scope (Wave-3 prologue, tracked in `.omo/plans/wave-3-pipeline.md`):** Zod `ValidationPipe` + 400/409 error contract, efficiency (codes-`IN` account query, batch line insert, FK index), `is_system` comment fix, `mapRow` dedup, account-currency-match is *in* scope here (cheap, shares files). These were the non-load-bearing findings.

---

## File Structure

**Migrations (edit in place — Wave 2 is unreleased, so no ALTER migrations):**
- `src/database/migrations/002_create_account.ts` — fix the FX seed row (`FX_LOSS` → `FX_GAIN_LOSS`).
- `src/database/migrations/003_create_voucher.ts` — add posted-voucher immutability triggers.
- `src/database/migrations/004_create_voucher_line.ts` — add per-line `CHECK` constraints + posted-voucher-line immutability triggers.

**Ledger source:**
- `src/ledger/validation/types.ts` — add `account_currency` to `ValidatableLine`.
- `src/ledger/validation/ledger-validation.service.ts` — validate `base_amount` (positive + integer), `fx_rate > 0`, account-currency match.
- `src/ledger/posting/voucher-hash.ts` *(new)* — `GENESIS_HASH` + `computeVoucherHash()`.
- `src/ledger/posting/posting.service.ts` — populate `account_currency`, drop the `?? 0` sentinel, compute & store `previous_hash` in the transaction.
- `src/ledger/voucher/voucher.repository.ts` — delete `createVoucher` (read-only now).
- `src/ledger/voucher/voucher-line.repository.ts` — delete `createVoucherLine` (read-only now).
- `src/ledger/voucher/types.ts` — delete the now-unused `NewVoucher` / `NewVoucherLine` interfaces.

**Tests:**
- `src/database/database.module.spec.ts` — restore real migrations (stop hand-building the table).
- `src/ledger/account/account.service.spec.ts` — add `foreign_keys = ON`; update FX code expectation.
- `src/database/migrations/voucher-line-constraints.spec.ts` *(new)* — DB-rejection tests for the CHECK constraints + immutability triggers.
- `src/ledger/posting/voucher-hash.spec.ts` *(new)* — hash determinism + sensitivity.
- `src/ledger/validation/ledger-validation.service.spec.ts` — new cases for base_amount / fx_rate / currency-match.
- `src/ledger/posting/posting.service.spec.ts` — hash-chain assertions; negative-`fx_rate` attack.
- `src/ledger/voucher/voucher.repository.spec.ts` — rewrite to seed via raw inserts + keep the UNIQUE proof.
- `src/ledger/voucher/voucher-line.repository.spec.ts` — rewrite to seed via raw inserts + keep the FK proof.

---

## Task H1: Restore test fidelity (do this first)

Trustworthy DB-invariant tests are the precondition for everything below. The DatabaseModule spec currently hand-builds the `organization` table instead of running migrations, and the AccountService spec runs without FK enforcement.

**Files:**
- Modify: `src/database/database.module.spec.ts`
- Modify: `src/ledger/account/account.service.spec.ts:14-17`

- [ ] **Step 1: Rewrite `database.module.spec.ts` to run the real migrations**

Replace the entire file with:

```typescript
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from './types';
import { migrations } from './migrations';

describe('DatabaseModule migrations', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates all kernel tables', async () => {
    const tables = await db
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'table')
      .execute();
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['organization', 'account', 'voucher', 'voucher_line']),
    );
  });

  it('seeds exactly one Irish organization (id=1, no override)', async () => {
    const orgs = await db.selectFrom('organization').selectAll().execute();
    expect(orgs).toHaveLength(1);
    expect(orgs[0].id).toBe(1);
    expect(orgs[0].country).toBe('IE');
    expect(orgs[0].base_currency).toBeNull();
  });

  it('rejects a second organization row (DB-level singleton, CHECK id=1)', async () => {
    await expect(
      db
        .insertInto('organization')
        .values({
          id: 2,
          country: 'DE',
          base_currency: 'USD',
          vat_registered: 0,
          created_at: 1700000000,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('proves the singleton CHECK against the SHIPPING migration, not a hand-built copy', async () => {
    const ddl = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='organization'
    `.execute(db);
    expect(ddl.rows[0].sql).toContain('id = 1');
  });
});
```

- [ ] **Step 2: Run it — expect PASS**

Run: `npx jest src/database/database.module.spec.ts --runInBand --no-cache`
Expected: PASS (4 tests). The migration seeds the org, so the "second row" insert hits the real `CHECK (id = 1)`.

- [ ] **Step 3: Add `foreign_keys = ON` to `account.service.spec.ts`**

Replace lines 14-17 (the `beforeEach` db construction):

```typescript
  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest src/ledger/account/account.service.spec.ts --runInBand --no-cache`
Expected: PASS (all existing tests still green; FK enforcement now matches production).

- [ ] **Step 5: Commit**

```bash
git add src/database/database.module.spec.ts src/ledger/account/account.service.spec.ts
git commit -m "test(wave-2): restore real-migration fidelity + FK pragma in ledger specs"
```

---

## Task H2: Per-line CHECK constraints + FX single account

Promote the per-line sign/integer rules to DB constraints (CONTEXT.md structural invariants; ADR-0019), and fix the incoherent FX seed (ADR-0004: single net `FX_GAIN_LOSS`).

**Files:**
- Modify: `src/database/migrations/004_create_voucher_line.ts`
- Modify: `src/database/migrations/002_create_account.ts:130`
- Modify: `src/ledger/account/account.service.spec.ts:65`
- Test: `src/database/migrations/voucher-line-constraints.spec.ts` (new)

- [ ] **Step 1: Write the failing constraint test**

Create `src/database/migrations/voucher-line-constraints.spec.ts`:

```typescript
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('voucher_line DB constraints', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  // Seeds a parent voucher + returns CASH account id, so line inserts satisfy FKs.
  async function seed(): Promise<{ voucherId: number; accountId: number }> {
    const v = await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-CONSTRAINT', tax_point_date: '2026-03-15', posted_at: 1740000000 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const a = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'CASH')
      .executeTakeFirstOrThrow();
    return { voucherId: v.id, accountId: a.id };
  }

  // Typed (strict mode bans `any` / loose records). Matches InsertObject<voucher_line>.
  interface LineInsert {
    voucher_id: number;
    account_id: number;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    is_debit: number;
  }

  function line(
    over: Partial<LineInsert>,
    ids: { voucherId: number; accountId: number },
  ): LineInsert {
    return {
      voucher_id: ids.voucherId,
      account_id: ids.accountId,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      vat_code: null,
      is_debit: 1,
      ...over,
    };
  }

  it('rejects amount <= 0', async () => {
    const ids = await seed();
    await expect(db.insertInto('voucher_line').values(line({ amount: 0 }, ids)).execute()).rejects.toThrow();
    await expect(db.insertInto('voucher_line').values(line({ amount: -1 }, ids)).execute()).rejects.toThrow();
  });

  it('rejects base_amount <= 0', async () => {
    const ids = await seed();
    await expect(db.insertInto('voucher_line').values(line({ base_amount: 0 }, ids)).execute()).rejects.toThrow();
  });

  it('rejects fx_rate <= 0 (blocks the negative-rate attack)', async () => {
    const ids = await seed();
    await expect(db.insertInto('voucher_line').values(line({ fx_rate: 0 }, ids)).execute()).rejects.toThrow();
    await expect(db.insertInto('voucher_line').values(line({ fx_rate: -1, base_amount: 10000 }, ids)).execute()).rejects.toThrow();
  });

  it('rejects is_debit outside {0,1}', async () => {
    const ids = await seed();
    await expect(db.insertInto('voucher_line').values(line({ is_debit: 2 }, ids)).execute()).rejects.toThrow();
  });

  it('accepts a well-formed line', async () => {
    const ids = await seed();
    await expect(db.insertInto('voucher_line').values(line({}, ids)).execute()).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/database/migrations/voucher-line-constraints.spec.ts --runInBand --no-cache`
Expected: FAIL — the "rejects …" tests fail because no CHECK constraints exist yet (the bad rows insert successfully).

- [ ] **Step 3: Add the CHECK constraints to migration 004**

Replace the full body of `src/database/migrations/004_create_voucher_line.ts` with:

```typescript
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher_line')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    .addColumn('account_id', 'integer', (col) =>
      col.notNull().references('account.id'),
    )
    .addColumn('amount', 'integer', (col) => col.notNull().check(sql`amount > 0`))
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('base_amount', 'integer', (col) =>
      col.notNull().check(sql`base_amount > 0`),
    )
    .addColumn('fx_rate', 'real', (col) => col.notNull().check(sql`fx_rate > 0`))
    .addColumn('vat_code', 'text')
    .addColumn('is_debit', 'integer', (col) =>
      col.notNull().check(sql`is_debit IN (0, 1)`),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher_line').ifExists().execute();
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest src/database/migrations/voucher-line-constraints.spec.ts --runInBand --no-cache`
Expected: PASS (5 tests).

- [ ] **Step 5: Fix the FX seed row + its test expectation**

In `src/database/migrations/002_create_account.ts`, replace line 130:

```typescript
  { code: 'FX_GAIN_LOSS', name: 'Foreign Exchange Gain/Loss', type: 'expense', currency: null },
```

In `src/ledger/account/account.service.spec.ts`, change the FX assertion (line 65) from `'FX_LOSS'` to `'FX_GAIN_LOSS'`.

- [ ] **Step 6: Run the account spec — expect PASS**

Run: `npx jest src/ledger/account/account.service.spec.ts --runInBand --no-cache`
Expected: PASS (the chart now seeds `FX_GAIN_LOSS`).

- [ ] **Step 7: Commit**

```bash
git add src/database/migrations/004_create_voucher_line.ts src/database/migrations/002_create_account.ts src/database/migrations/voucher-line-constraints.spec.ts src/ledger/account/account.service.spec.ts
git commit -m "feat(wave-2): per-line CHECK constraints + single net FX_GAIN_LOSS (ADR-0019, ADR-0004)"
```

---

## Task H3: Posted-voucher immutability triggers

Immutability must hold below the HTTP 405 (ADR-0019). Triggers fire **only when the voucher is posted** (`posted_at IS NOT NULL`), so Wave-3's unposted-draft → posted transition (carry-forward seam #5) is still allowed.

**Files:**
- Modify: `src/database/migrations/003_create_voucher.ts`
- Modify: `src/database/migrations/004_create_voucher_line.ts`
- Test: `src/database/migrations/voucher-line-constraints.spec.ts` (append)

- [ ] **Step 1: Write the failing immutability tests (append to the constraints spec)**

Append these `it` blocks inside the `describe` in `src/database/migrations/voucher-line-constraints.spec.ts`:

```typescript
  it('blocks UPDATE of a posted voucher', async () => {
    const { voucherId } = await seed(); // seeded voucher has posted_at set
    await expect(
      db.updateTable('voucher').set({ reason: 'tamper' }).where('id', '=', voucherId).execute(),
    ).rejects.toThrow();
  });

  it('blocks DELETE of a posted voucher', async () => {
    const { voucherId } = await seed();
    await expect(
      db.deleteFrom('voucher').where('id', '=', voucherId).execute(),
    ).rejects.toThrow();
  });

  it('blocks UPDATE/DELETE of a posted voucher line', async () => {
    const ids = await seed();
    const ln = await db.insertInto('voucher_line').values(line({}, ids)).returningAll().executeTakeFirstOrThrow();
    await expect(
      db.updateTable('voucher_line').set({ amount: 1 }).where('id', '=', ln.id).execute(),
    ).rejects.toThrow();
    await expect(
      db.deleteFrom('voucher_line').where('id', '=', ln.id).execute(),
    ).rejects.toThrow();
  });

  it('ALLOWS updating an UNPOSTED voucher (Wave-3 Policy-hold draft path)', async () => {
    const draft = await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-DRAFT', tax_point_date: '2026-03-15', posted_at: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    // setting posted_at: OLD.posted_at is NULL, so the trigger must not fire
    await expect(
      db.updateTable('voucher').set({ posted_at: 1740000000 }).where('id', '=', draft.id).execute(),
    ).resolves.toBeDefined();
  });
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/database/migrations/voucher-line-constraints.spec.ts --runInBand --no-cache`
Expected: FAIL — the three "blocks …" tests fail (no triggers yet; updates/deletes succeed).

- [ ] **Step 3: Add the voucher triggers to migration 003**

Replace the full body of `src/database/migrations/003_create_voucher.ts` with:

```typescript
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('voucher_number', 'text', (col) => col.notNull().unique())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('posted_at', 'integer')
    .addColumn('previous_hash', 'text')
    .addColumn('reverses_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('corrects_object_type', 'text')
    .addColumn('corrects_object_id', 'integer')
    .addColumn('reason', 'text')
    .execute();

  // Immutability backstop (ADR-0019): a posted voucher can never be updated or
  // deleted by ANY write path. Gated on OLD.posted_at so the Wave-3 Policy-hold
  // path (insert unposted -> later set posted_at) is still allowed.
  await sql`
    CREATE TRIGGER voucher_block_update_when_posted
    BEFORE UPDATE ON voucher
    WHEN OLD.posted_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher is immutable (ADR-0019)');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER voucher_block_delete_when_posted
    BEFORE DELETE ON voucher
    WHEN OLD.posted_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher is immutable (ADR-0019)');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher').ifExists().execute();
}
```

- [ ] **Step 4: Add the voucher_line triggers to migration 004**

In `src/database/migrations/004_create_voucher_line.ts`, add these two `sql` trigger blocks at the end of `up()` (after the `createTable(...).execute()` call):

```typescript
  // A line of a POSTED voucher is immutable (ADR-0019). The parent's posted_at
  // is looked up via the line's voucher_id.
  await sql`
    CREATE TRIGGER voucher_line_block_update_when_posted
    BEFORE UPDATE ON voucher_line
    WHEN (SELECT posted_at FROM voucher WHERE id = OLD.voucher_id) IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher line is immutable (ADR-0019)');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER voucher_line_block_delete_when_posted
    BEFORE DELETE ON voucher_line
    WHEN (SELECT posted_at FROM voucher WHERE id = OLD.voucher_id) IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher line is immutable (ADR-0019)');
    END;
  `.execute(db);
```

- [ ] **Step 5: Run it — expect PASS**

Run: `npx jest src/database/migrations/voucher-line-constraints.spec.ts --runInBand --no-cache`
Expected: PASS (all constraint + immutability + "allow unposted" tests green).

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations/003_create_voucher.ts src/database/migrations/004_create_voucher_line.ts src/database/migrations/voucher-line-constraints.spec.ts
git commit -m "feat(wave-2): DB-level posted-voucher immutability triggers (ADR-0019)"
```

---

## Task H4: Validation — base_amount, fx_rate, account-currency match

Close the negative-`fx_rate` / negative-`base_amount` hole at the service layer too (defense in depth), and add the account-currency-match rule (ADR-0004).

**Files:**
- Modify: `src/ledger/validation/types.ts`
- Modify: `src/ledger/validation/ledger-validation.service.ts`
- Test: `src/ledger/validation/ledger-validation.service.spec.ts` (append)

- [ ] **Step 1: Write the failing validation tests (append to the spec's `describe`)**

Append to `src/ledger/validation/ledger-validation.service.spec.ts`. These construct lines directly against `LedgerValidationService`. Use a valid account id set `new Set([1, 2])`:

```typescript
  it('rejects a non-positive base_amount even when amount is positive', () => {
    const result = service.validateVoucherLines(
      [
        { account_id: 1, amount: 10000, currency: 'EUR', base_amount: -10000, fx_rate: 1, is_debit: true, account_currency: null },
        { account_id: 2, amount: 10000, currency: 'EUR', base_amount: -10000, fx_rate: 1, is_debit: false, account_currency: null },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('base_amount must be positive');
  });

  it('rejects a non-integer base_amount', () => {
    const result = service.validateVoucherLines(
      [
        { account_id: 1, amount: 10000, currency: 'EUR', base_amount: 9200.5, fx_rate: 0.92, is_debit: true, account_currency: null },
        { account_id: 2, amount: 9200, currency: 'EUR', base_amount: 9200, fx_rate: 1, is_debit: false, account_currency: null },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('base_amount must be an integer (cents)');
  });

  it('rejects a non-positive fx_rate (negative-rate attack)', () => {
    const result = service.validateVoucherLines(
      [
        { account_id: 1, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: -1, is_debit: true, account_currency: null },
        { account_id: 2, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: false, account_currency: null },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('fx_rate must be positive');
  });

  it('rejects a line whose currency does not match its account currency', () => {
    const result = service.validateVoucherLines(
      [
        { account_id: 1, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: true, account_currency: 'USD' },
        { account_id: 2, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: false, account_currency: null },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Line currency does not match account currency');
  });

  it('accepts a line whose currency matches a foreign-currency account', () => {
    const result = service.validateVoucherLines(
      [
        { account_id: 1, amount: 10000, currency: 'USD', base_amount: 9200, fx_rate: 0.92, is_debit: true, account_currency: 'USD' },
        { account_id: 2, amount: 9200, currency: 'EUR', base_amount: 9200, fx_rate: 1, is_debit: false, account_currency: null },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(true);
  });
```

> Note: existing tests in this file construct `ValidatableLine` without `account_currency`. After Step 2 adds the field as required, update those literals by adding `account_currency: null` (TypeScript will flag each). This is mechanical; do it when the compiler points at them in Step 3's run.

- [ ] **Step 2: Add `account_currency` to `ValidatableLine`**

Replace `src/ledger/validation/types.ts` with:

```typescript
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ValidatableLine {
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  is_debit: boolean;
  // The pinned currency of the line's account (null for base-currency accounts).
  // ADR-0004: a line on a foreign-currency account must carry that currency.
  account_currency: string | null;
}
```

- [ ] **Step 3: Add the new checks to the validation service**

In `src/ledger/validation/ledger-validation.service.ts`, add four flag declarations alongside the existing `saw*` flags:

```typescript
    let sawNonPositiveBase = false;
    let sawNonIntegerBase = false;
    let sawNonPositiveFx = false;
    let sawCurrencyMismatch = false;
```

Inside the `for (const line of lines)` loop, after the existing `expectedBase` check, add:

```typescript
      if (line.base_amount <= 0) {
        sawNonPositiveBase = true;
      }
      if (!Number.isInteger(line.base_amount)) {
        sawNonIntegerBase = true;
      }
      if (line.fx_rate <= 0) {
        sawNonPositiveFx = true;
      }
      if (
        line.account_currency !== null &&
        line.currency !== line.account_currency
      ) {
        sawCurrencyMismatch = true;
      }
```

After the existing `if (sawFxMismatch) ...` push, add:

```typescript
    if (sawNonPositiveBase) errors.push('base_amount must be positive');
    if (sawNonIntegerBase)
      errors.push('base_amount must be an integer (cents)');
    if (sawNonPositiveFx) errors.push('fx_rate must be positive');
    if (sawCurrencyMismatch)
      errors.push('Line currency does not match account currency');
```

- [ ] **Step 4: Fix existing test literals, then run — expect PASS**

Add `account_currency: null` to every `ValidatableLine` literal the compiler flags in the existing spec, then:

Run: `npx jest src/ledger/validation/ledger-validation.service.spec.ts --runInBand --no-cache`
Expected: PASS (existing + 5 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/ledger/validation/types.ts src/ledger/validation/ledger-validation.service.ts src/ledger/validation/ledger-validation.service.spec.ts
git commit -m "feat(wave-2): validate base_amount/fx_rate sign + account-currency match (ADR-0004)"
```

---

## Task H5: Single writer — demote repositories to read-only

`PostingService` is the only validated write path (ADR-0019). Delete the dead, unvalidated, null-hash `create*` methods; keep the read queries.

**Files:**
- Modify: `src/ledger/voucher/voucher.repository.ts`
- Modify: `src/ledger/voucher/voucher-line.repository.ts`
- Modify: `src/ledger/voucher/types.ts`
- Modify: `src/ledger/voucher/voucher.repository.spec.ts`
- Modify: `src/ledger/voucher/voucher-line.repository.spec.ts`

- [ ] **Step 1: Rewrite `voucher.repository.spec.ts` to seed via raw inserts (read-only repo)**

Replace the four create-based tests. The repo keeps only reads; seed through `db` directly, and keep the UNIQUE proof as a raw-insert DB-invariant test:

```typescript
  it('getVoucherById returns the persisted voucher', async () => {
    await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-2026-002', tax_point_date: '2026-03-16', posted_at: null })
      .execute();
    const all = await repo.getVouchers();
    const fetched = await repo.getVoucherById(all[0].id);
    expect(fetched?.voucher_number).toBe('V-2026-002');
  });

  it('getVoucherById returns null for an unknown id', async () => {
    await expect(repo.getVoucherById(9999)).resolves.toBeNull();
  });

  it('getVouchers is empty on a fresh DB and reflects inserts', async () => {
    expect(await repo.getVouchers()).toEqual([]);
    await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-2026-003', tax_point_date: '2026-03-17', posted_at: null })
      .execute();
    expect(await repo.getVouchers()).toHaveLength(1);
  });

  it('enforces voucher_number UNIQUE at the DB level (G6)', async () => {
    await db
      .insertInto('voucher')
      .values({ voucher_number: 'V-2026-DUP', tax_point_date: '2026-03-18', posted_at: null })
      .execute();
    await expect(
      db
        .insertInto('voucher')
        .values({ voucher_number: 'V-2026-DUP', tax_point_date: '2026-03-19', posted_at: null })
        .execute(),
    ).rejects.toThrow();
  });
```

(Delete the `createVoucher inserts a row …` test entirely.)

- [ ] **Step 2: Rewrite `voucher-line.repository.spec.ts` to seed via raw inserts**

Replace the create-based tests; keep the FK proof as a raw-insert test. Helper to seed a parent voucher + resolve an account id:

```typescript
  async function seedVoucher(number: string): Promise<number> {
    const v = await db
      .insertInto('voucher')
      .values({ voucher_number: number, tax_point_date: '2026-03-15', posted_at: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return v.id;
  }

  it('getLinesByVoucherId returns all lines for a voucher', async () => {
    const voucherId = await seedVoucher('V-LINE-002');
    const expense = await accounts.getAccountByCode('EXPENSE_SOFTWARE');
    const cash = await accounts.getAccountByCode('CASH');
    await db.insertInto('voucher_line').values([
      { voucher_id: voucherId, account_id: expense!.id, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 1 },
      { voucher_id: voucherId, account_id: cash!.id, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 0 },
    ]).execute();
    const lines = await lineRepo.getLinesByVoucherId(voucherId);
    expect(lines).toHaveLength(2);
    expect(lines[0].is_debit).toBe(true);
  });

  it('rejects a line whose voucher_id has no parent voucher (FK, G6)', async () => {
    const cash = await accounts.getAccountByCode('CASH');
    await expect(
      db.insertInto('voucher_line').values({
        voucher_id: 999999, account_id: cash!.id, amount: 10000, currency: 'EUR',
        base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: 1,
      }).execute(),
    ).rejects.toThrow();
  });
```

(Delete the `createVoucherLine inserts a line …` test.)

- [ ] **Step 3: Run both repo specs — expect FAIL to COMPILE**

Run: `npx jest src/ledger/voucher/voucher.repository.spec.ts src/ledger/voucher/voucher-line.repository.spec.ts --runInBand --no-cache`
Expected: FAIL — repos still expose `createVoucher`/`createVoucherLine` (tests pass) but we haven't removed them yet; this step just confirms the rewritten reads pass. If green, proceed; the deletions in Step 4 are what make the repos read-only.

- [ ] **Step 4: Delete the create methods**

In `src/ledger/voucher/voucher.repository.ts`: delete the `createVoucher` method (lines 11-27) and remove `NewVoucher` from the import on line 5 (becomes `import { Voucher } from './types';`).

In `src/ledger/voucher/voucher-line.repository.ts`: delete the `createVoucherLine` method (lines 11-27) and remove `NewVoucherLine` from the import on line 5 (becomes `import { VoucherLine } from './types';`).

In `src/ledger/voucher/types.ts`: delete the `NewVoucher` (lines 45-49) and `NewVoucherLine` (lines 51-60) interfaces.

- [ ] **Step 5: Run the repo specs + posting spec — expect PASS**

Run: `npx jest src/ledger/voucher src/ledger/posting/posting.service.spec.ts --runInBand --no-cache`
Expected: PASS. `posting.service.spec.ts` uses the repos only for reads (`getVouchers`, `getLinesByVoucherId`), so it is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/voucher/voucher.repository.ts src/ledger/voucher/voucher-line.repository.ts src/ledger/voucher/types.ts src/ledger/voucher/voucher.repository.spec.ts src/ledger/voucher/voucher-line.repository.spec.ts
git commit -m "refactor(wave-2): demote voucher repositories to read-only; posting is sole writer (ADR-0019)"
```

---

## Task H6: Wire the hash chain

The append-only ledger becomes tamper-evident (ADR-0013). `previous_hash` of voucher N = the hash of the previous posted voucher; genesis uses a fixed sentinel.

**Files:**
- Create: `src/ledger/posting/voucher-hash.ts`
- Test: `src/ledger/posting/voucher-hash.spec.ts` (new)
- Modify: `src/ledger/posting/posting.service.ts`
- Modify: `src/ledger/posting/posting.service.spec.ts` (append)

- [ ] **Step 1: Write the failing hash-util test**

Create `src/ledger/posting/voucher-hash.spec.ts`:

```typescript
import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

describe('voucher-hash', () => {
  const voucher = {
    voucher_number: 'V-1',
    tax_point_date: '2026-03-15',
    posted_at: 1740000000,
    previous_hash: GENESIS_HASH,
  };
  const lines = [
    { account_id: 1, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: true },
    { account_id: 2, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: false },
  ];

  it('GENESIS_HASH is 64 hex chars of zero', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(computeVoucherHash(voucher, lines)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(computeVoucherHash(voucher, lines)).toBe(computeVoucherHash(voucher, lines));
  });

  it('changes if ANY field changes (tamper sensitivity)', () => {
    const base = computeVoucherHash(voucher, lines);
    expect(computeVoucherHash({ ...voucher, previous_hash: 'deadbeef' }, lines)).not.toBe(base);
    expect(computeVoucherHash(voucher, [{ ...lines[0], amount: 10001 }, lines[1]])).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/ledger/posting/voucher-hash.spec.ts --runInBand --no-cache`
Expected: FAIL — `./voucher-hash` does not exist.

- [ ] **Step 3: Implement the hash util**

Create `src/ledger/posting/voucher-hash.ts`:

```typescript
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

interface HashableVoucher {
  voucher_number: string;
  tax_point_date: string;
  posted_at: number | null;
  previous_hash: string | null;
}

interface HashableLine {
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  is_debit: boolean;
}

/**
 * H(N) = SHA-256(canonical(N)), where canonical folds in the previous voucher's
 * hash via `previous_hash`. The field list + ordering is a forever-contract
 * (ADR-0013); changing it requires a new ADR + migration story.
 */
export function computeVoucherHash(
  voucher: HashableVoucher,
  lines: HashableLine[],
): string {
  const canonical = JSON.stringify({
    voucher_number: voucher.voucher_number,
    tax_point_date: voucher.tax_point_date,
    posted_at: voucher.posted_at,
    previous_hash: voucher.previous_hash,
    lines: lines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit ? 1 : 0,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest src/ledger/posting/voucher-hash.spec.ts --runInBand --no-cache`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `previous_hash` into `PostingService` (also: account_currency + drop `?? 0`)**

Replace the body of `src/ledger/posting/posting.service.ts` with:

```typescript
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { ValidatableLine } from '../validation/types';
import { DraftVoucher, PostedVoucher, VoucherLine } from '../voucher/types';
import { ValidationError } from './types';
import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

@Injectable()
export class PostingService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly accountService: AccountService,
    private readonly validation: LedgerValidationService,
  ) {}

  async postVoucher(draft: DraftVoucher): Promise<PostedVoucher> {
    const accounts = await this.accountService.getAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const validIds = new Set(accounts.map((a) => a.id));

    const resolved: ValidatableLine[] = draft.lines.map((l) => {
      const account = byCode.get(l.account_code);
      return {
        account_id: account?.id ?? -1, // -1 = unknown code; fails the existence check
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
        account_currency: account?.currency ?? null,
      };
    });

    const result = this.validation.validateVoucherLines(resolved, validIds);
    if (!result.isValid) {
      throw new ValidationError(result.errors);
    }

    const postedAt = Math.floor(Date.now() / 1000);

    return this.db.transaction().execute(async (trx) => {
      const previousHash = await this.chainHead(trx);

      const voucher = await trx
        .insertInto('voucher')
        .values({
          voucher_number: draft.voucher_number,
          tax_point_date: draft.tax_point_date,
          posted_at: postedAt,
          previous_hash: previousHash,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const lines: VoucherLine[] = [];
      for (let i = 0; i < draft.lines.length; i++) {
        const draftLine = draft.lines[i];
        const inserted = await trx
          .insertInto('voucher_line')
          .values({
            voucher_id: voucher.id,
            account_id: resolved[i].account_id,
            amount: draftLine.amount,
            currency: draftLine.currency,
            base_amount: draftLine.base_amount,
            fx_rate: draftLine.fx_rate,
            vat_code: draftLine.vat_code ?? null,
            is_debit: draftLine.is_debit ? 1 : 0,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        lines.push({
          id: inserted.id,
          voucher_id: inserted.voucher_id,
          account_id: inserted.account_id,
          amount: inserted.amount,
          currency: inserted.currency,
          base_amount: inserted.base_amount,
          fx_rate: inserted.fx_rate,
          vat_code: inserted.vat_code,
          is_debit: inserted.is_debit === 1,
        });
      }

      return { ...voucher, lines };
    });
  }

  /**
   * The hash of the latest posted voucher, or GENESIS_HASH if the ledger is
   * empty. ADR-0013: the new voucher's previous_hash links to this.
   */
  private async chainHead(
    trx: Kysely<Database>,
  ): Promise<string> {
    const prev = await trx
      .selectFrom('voucher')
      .selectAll()
      .where('posted_at', 'is not', null)
      .orderBy('id desc')
      .limit(1)
      .executeTakeFirst();
    if (!prev) return GENESIS_HASH;

    const prevLines = await trx
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', prev.id)
      .orderBy('id')
      .execute();

    return computeVoucherHash(prev, prevLines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount,
      currency: l.currency,
      base_amount: l.base_amount,
      fx_rate: l.fx_rate,
      is_debit: l.is_debit === 1,
    })));
  }
}
```

> Note: `trx` inside `db.transaction().execute()` is typed `Transaction<Database>`, which is assignable to the `Kysely<Database>` parameter of `chainHead`. The `{ ...voucher, lines }` return matches the controller's existing `getVoucher` shape (replaces the manual field-by-field rebuild).

- [ ] **Step 6: Append the chain assertions to `posting.service.spec.ts`**

Add inside the `describe` in `src/ledger/posting/posting.service.spec.ts` (it already imports `computeVoucherHash`? — add `import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';` at the top):

```typescript
  it('sets previous_hash to GENESIS_HASH for the first voucher', async () => {
    const result = await posting.postVoucher(balanced('V-2026-200'));
    expect(result.previous_hash).toBe(GENESIS_HASH);
  });

  it('links each voucher to the hash of the prior one', async () => {
    const first = await posting.postVoucher(balanced('V-2026-201'));
    const firstLines = await lineRepo.getLinesByVoucherId(first.id);
    const second = await posting.postVoucher(balanced('V-2026-202'));
    expect(second.previous_hash).toBe(computeVoucherHash(first, firstLines));
  });

  it('rejects a negative-fx_rate voucher that would otherwise "balance" (writes nothing)', async () => {
    const attack: DraftVoucher = {
      voucher_number: 'V-2026-203',
      tax_point_date: '2026-03-15',
      lines: [
        { account_code: 'EXPENSE_SOFTWARE', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: -1, is_debit: true },
        { account_code: 'CASH', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: -1, is_debit: false },
      ],
    };
    await expect(posting.postVoucher(attack)).rejects.toThrow(ValidationError);
    expect(await voucherRepo.getVouchers()).toHaveLength(0);
  });
```

- [ ] **Step 7: Run the posting spec — expect PASS**

Run: `npx jest src/ledger/posting/posting.service.spec.ts --runInBand --no-cache`
Expected: PASS (existing + 3 new). The FX voucher test (`V-2026-104`, fx_rate 0.92) still passes — positive rate, currency matches `BANK_USD`.

- [ ] **Step 8: Commit**

```bash
git add src/ledger/posting/voucher-hash.ts src/ledger/posting/voucher-hash.spec.ts src/ledger/posting/posting.service.ts src/ledger/posting/posting.service.spec.ts
git commit -m "feat(wave-2): wire hash chain into posting; previous_hash links the ledger (ADR-0013)"
```

---

## Task H7: Full gate + e2e + evidence

**Files:**
- Verify: `test/voucher.e2e-spec.ts` (no change expected — uses repos for reads, posts via controller)

- [ ] **Step 1: Run the full gate exactly as CI does**

Run: `npm run build && npm run lint && npm run test && npm run test:e2e`
Expected: all green. The e2e suite posts a genesis voucher (previous_hash = GENESIS_HASH), the unbalanced case still 400s, and the 405 immutability tests still pass (now backed by triggers underneath).

- [ ] **Step 2: If e2e reveals the immutability trigger interacts with a posted-then-read flow, confirm reads are unaffected**

The triggers fire only on UPDATE/DELETE; the e2e GET path is unaffected. If any e2e fails, do NOT weaken the trigger — fix the calling code. Re-run Step 1.

- [ ] **Step 3: Capture evidence**

```bash
sqlite3 :memory: < /dev/null # (smoke)
npm run test 2>&1 | tail -20 > .omo/evidence/wave-2-hardening-test.txt
npm run test:e2e 2>&1 | tail -20 > .omo/evidence/wave-2-hardening-e2e.txt
```

- [ ] **Step 4: Grep guards (engineering-guardrails G4/G5)**

Run: `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v migrations`
Expected: no output (schema only in migrations).
Run: `grep -rn "previous_hash: null" src --include=*.ts`
Expected: no output (the null-hash write is gone).
Run: `grep -rnE ": *any\b|\bas [A-Z]" src --include=*.ts | grep -v ".spec.ts"`
Expected: no NEW matches in files this plan added/changed (strict-mode invariant from `04400b7`; `npm run lint` is the authority).

- [ ] **Step 5: Final commit**

```bash
git add .omo/evidence/wave-2-hardening-test.txt .omo/evidence/wave-2-hardening-e2e.txt
git commit -m "chore(wave-2): hardening gate green + evidence (ADR-0013/0019, ADR-0004)"
```

---

## Self-Review

**Spec coverage** (against the 7 grill resolutions + load-bearing findings):
- Immutability at DB → H3 (triggers, gated on posted_at). ✓
- Hash chain → H6 (compute + store + genesis sentinel + tamper test). ✓
- Money model / per-line CHECKs / base_amount validation → H2 (DB) + H4 (service). ✓
- Single write path → H5 (repos read-only, create methods deleted). ✓
- FX trust + account-currency match → H4. ✓
- FX single account → H2. ✓
- Test fidelity (real migrations + FK pragma) → H1. ✓
- Error contract / Zod, efficiency, cosmetics → explicitly Wave-3 prologue (out of scope here). ✓

**Placeholder scan:** every code step shows full code; every run step shows the command + expected result. No TODO/TBD.

**Type consistency:** `ValidatableLine` gains `account_currency` (H4) and is populated in `PostingService` (H6); `computeVoucherHash` signature is identical in `voucher-hash.ts`, its spec, and the posting spec; `chainHead` returns `string`; deleted `NewVoucher`/`NewVoucherLine` are no longer referenced after H5.

**Known interaction:** H3 triggers must precede H6 in execution order only loosely — but H6's `chainHead` reads, never updates, so no conflict. H5 (read-only repos) must land before H6's spec edits, since H6 references `lineRepo.getLinesByVoucherId` (a read, retained). Execute in numeric order H1→H7.
