# Wave 2 — Ledger Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hidden double-entry accounting kernel — the canonical chart of Accounts, the immutable Voucher/VoucherLine schema (with a reserved `previous_hash` column), structural double-entry validation, an atomic posting service, and API-layer immutability enforcement.

**Architecture:** A new `src/ledger/` domain holds four sub-modules — `account`, `voucher`, `validation`, `posting`. All schema lives in Kysely migrations under `src/database/migrations/` (G4); services read/write through the injected `Kysely<Database>` instance, exactly as `OrganizationService` does. `AccountService` resolves Account codes to ids; `LedgerValidationService` enforces structural invariants (balance, account existence, positive amounts, FX consistency); `PostingService` validates then writes voucher + lines inside a single better-sqlite3 transaction; `VoucherController` exposes read + post endpoints and rejects all mutating HTTP verbs on posted Vouchers with 405.

**Tech Stack:** NestJS, Kysely, better-sqlite3, Jest, TypeScript

---

## File Structure

### Migrations (G4 — schema lives ONLY here)
- `src/database/migrations/002_create_account.ts` — `account` table + canonical chart seed (≥20 rows).
- `src/database/migrations/003_create_voucher.ts` — `voucher` table incl. `previous_hash`.
- `src/database/migrations/004_create_voucher_line.ts` — `voucher_line` table with FK to `voucher` and `account`.
- `src/database/migrations/index.ts` — **modify**: register migrations 002, 003, 004.
- `src/database/types.ts` — **modify**: add `AccountTable`, `VoucherTable`, `VoucherLineTable` to the `Database` interface.

### Account (Task 6)
- `src/ledger/account/types.ts` — `Account`, `AccountType` domain types.
- `src/ledger/account/account.service.ts` — `getAccounts()`, `getAccountByCode()`.
- `src/ledger/account/account.controller.ts` — `GET /api/accounts`, `GET /api/accounts/:code`.
- `src/ledger/account/account.module.ts` — wires `DatabaseModule`, exports `AccountService`.
- `src/ledger/account/account.service.spec.ts` — real-DI integration test (in-memory SQLite).
- `src/ledger/account/account.controller.spec.ts` — controller unit test (mocked service).

### Voucher (Tasks 7, 10)
- `src/ledger/voucher/types.ts` — `Voucher`, `VoucherLine`, `DraftVoucher`, `DraftVoucherLine`, `PostedVoucher` domain types.
- `src/ledger/voucher/voucher.repository.ts` — `createVoucher()`, `getVoucherById()`, `getVouchers()`.
- `src/ledger/voucher/voucher-line.repository.ts` — `createVoucherLine()`, `getLinesByVoucherId()`.
- `src/ledger/voucher/voucher.controller.ts` — `GET /api/vouchers`, `GET /api/vouchers/:id`, `POST /api/vouchers`; 405 on PUT/PATCH/DELETE.
- `src/ledger/voucher/voucher.module.ts` — wires repositories, controller, posting service.
- `src/ledger/voucher/voucher.repository.spec.ts` — real-DI integration test.
- `src/ledger/voucher/voucher-line.repository.spec.ts` — real-DI integration test (incl. FK constraint).
- `src/ledger/voucher/voucher.controller.spec.ts` — immutability (405) unit tests.

### Validation (Task 8)
- `src/ledger/validation/types.ts` — `ValidationResult`.
- `src/ledger/validation/ledger-validation.service.ts` — `validateVoucherLines()`.
- `src/ledger/validation/ledger-validation.service.spec.ts` — exhaustive validation unit tests.

### Posting (Task 9)
- `src/ledger/posting/types.ts` — `ValidationError` class.
- `src/ledger/posting/posting.service.ts` — `postVoucher()` (atomic, transactional).
- `src/ledger/posting/posting.module.ts` — wires validation + voucher repos + account service.
- `src/ledger/posting/posting.service.spec.ts` — real-DI integration test (atomicity, rollback).
- `test/voucher.e2e-spec.ts` — end-to-end POST/GET + 405 over real HTTP.

### App wiring
- `src/app.module.ts` — **modify**: import `AccountModule` and `VoucherModule`.

---

## Conventions used throughout (read once)

- **Money is integer cents.** `amount`, `base_amount` are integers. `fx_rate` is a `REAL`. `base_amount = round(amount * fx_rate)` within ±1 cent tolerance.
- **Base currency is EUR** (Ireland default, ADR-0004). The home bank account is `BANK_EUR`. Example payloads use EUR. Never hardcode a currency in production code — read it via `CurrencyService` when a default is needed. (Wave 2 validation receives explicit per-line `currency` + `base_amount`, so no currency lookup is required inside the kernel here; the EUR rule governs the seed and the examples.)
- **Booleans in SQLite are integers** (`0`/`1`), as Wave 1 does for `vat_registered`. Domain types expose `boolean`; row mappers convert.
- **Timestamps are unix seconds** (`Math.floor(Date.now() / 1000)`), as Wave 1's `created_at`.
- **Integration-test harness** is copied verbatim from `src/currency/currency.resolution.spec.ts`: open `:memory:` SQLite, run `migrateToLatest` with the real `migrations`, provide the Kysely instance under `KYSELY_MODULE_CONNECTION_TOKEN()`, assemble the real services (G2).
- **Wave gate before every task's final commit (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` must be green.

---

## Task 6 — Account chart schema + canonical seed data

**Files:**
- Create: `src/database/migrations/002_create_account.ts`
- Modify: `src/database/migrations/index.ts`
- Modify: `src/database/types.ts`
- Create: `src/ledger/account/types.ts`
- Create: `src/ledger/account/account.service.ts`
- Create: `src/ledger/account/account.controller.ts`
- Create: `src/ledger/account/account.module.ts`
- Test: `src/ledger/account/account.service.spec.ts` (real-DI integration, G2)
- Test: `src/ledger/account/account.controller.spec.ts` (controller unit)
- Modify: `src/app.module.ts`

### Steps

- [ ] **6.1 Add the `AccountTable` interface to the Kysely Database type.** Edit `src/database/types.ts`. Add the import-less interface and register it on `Database`:

  Add to the `Database` interface:
  ```ts
    account: AccountTable;
  ```
  Append at end of file:
  ```ts
  export interface AccountTable {
    id: Generated<number>;
    code: string;
    name: string;
    // enum: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
    type: string;
    // Nullable: set only for foreign-currency accounts (e.g. BANK_USD).
    currency: string | null;
    // Self-referential FK for chart hierarchy; traversal is deferred (Wave 2
    // reserves the column only).
    parent_id: number | null;
    // SQLite boolean (0/1). System accounts cannot be edited/deleted via API.
    is_system: number;
  }
  ```

- [ ] **6.2 Write the failing migration-driven integration test for seeding.** Create `src/ledger/account/account.service.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../../database/types';
  import { migrations } from '../../database/migrations';
  import { AccountService } from './account.service';

  describe('AccountService (integration)', () => {
    let db: Kysely<Database>;
    let service: AccountService;

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });

      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
        ],
      }).compile();

      service = module.get(AccountService);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('seeds at least 20 canonical accounts', async () => {
      const accounts = await service.getAccounts();
      expect(accounts.length).toBeGreaterThanOrEqual(20);
    });

    it('seeds the EUR home bank account (BANK_EUR), not BANK_DKK', async () => {
      const codes = (await service.getAccounts()).map((a) => a.code);
      expect(codes).toContain('BANK_EUR');
      expect(codes).not.toContain('BANK_DKK');
    });

    it('seeds canonical accounts across all five types', async () => {
      const codes = (await service.getAccounts()).map((a) => a.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'CASH',
          'BANK_EUR',
          'BANK_USD',
          'AR',
          'AP',
          'VAT_PAYABLE',
          'EQUITY',
          'REVENUE',
          'EXPENSE_SOFTWARE',
          'FX_LOSS',
        ]),
      );
    });

    it('getAccountByCode returns the requested account (non-default lookup)', async () => {
      const account = await service.getAccountByCode('EXPENSE_TRANSPORT');
      expect(account).not.toBeNull();
      expect(account?.code).toBe('EXPENSE_TRANSPORT');
      expect(account?.type).toBe('expense');
    });

    it('getAccountByCode returns null for an unknown code', async () => {
      await expect(service.getAccountByCode('NOT_A_REAL_CODE')).resolves.toBeNull();
    });

    it('marks seeded accounts as system accounts', async () => {
      const cash = await service.getAccountByCode('CASH');
      expect(cash?.is_system).toBe(true);
    });

    it('tracks BANK_USD as a foreign-currency account', async () => {
      const bankUsd = await service.getAccountByCode('BANK_USD');
      expect(bankUsd?.currency).toBe('USD');
    });

    it('leaves base-currency accounts with a null currency', async () => {
      const cash = await service.getAccountByCode('CASH');
      expect(cash?.currency).toBeNull();
    });
  });
  ```

- [ ] **6.3 Run it — expect FAIL (no migration, no service).** Command:
  ```
  npx jest src/ledger/account/account.service.spec.ts
  ```
  Expected FAIL: `Cannot find module './account.service'` (and once that exists, `no such table: account`).

- [ ] **6.4 Write the migration with the canonical seed.** Create `src/database/migrations/002_create_account.ts`:
  ```ts
  import { Kysely, sql } from 'kysely';

  // Canonical, country-agnostic chart of Accounts (ADR-0001, ADR-0002, CONTEXT).
  // type ∈ {asset, liability, equity, revenue, expense}. currency is set only
  // for foreign-currency accounts; the base-currency (EUR) accounts leave it
  // NULL. The home bank account is BANK_EUR (Ireland default, ADR-0004) — NOT
  // BANK_DKK. All seeded accounts are system accounts (is_system = 1).
  const SEED: Array<{
    code: string;
    name: string;
    type: string;
    currency: string | null;
  }> = [
    // Assets
    { code: 'CASH', name: 'Cash', type: 'asset', currency: null },
    { code: 'BANK_EUR', name: 'Bank (EUR)', type: 'asset', currency: null },
    { code: 'BANK_USD', name: 'Bank (USD)', type: 'asset', currency: 'USD' },
    { code: 'AR', name: 'Accounts Receivable', type: 'asset', currency: null },
    { code: 'VAT_RECEIVABLE', name: 'VAT Receivable (input VAT)', type: 'asset', currency: null },
    { code: 'SUPPLIER_PREPAYMENTS', name: 'Supplier Prepayments', type: 'asset', currency: null },
    { code: 'RECEIVABLE_FROM_OWNER', name: 'Receivable from Owner', type: 'asset', currency: null },
    // Liabilities
    { code: 'AP', name: 'Accounts Payable', type: 'liability', currency: null },
    { code: 'CUSTOMER_PREPAYMENTS', name: 'Customer Prepayments', type: 'liability', currency: null },
    { code: 'VAT_PAYABLE', name: 'VAT Payable (output VAT)', type: 'liability', currency: null },
    // Equity
    { code: 'EQUITY', name: 'Equity', type: 'equity', currency: null },
    { code: 'OWNERS_DRAWINGS', name: "Owner's Drawings", type: 'equity', currency: null },
    // Revenue
    { code: 'REVENUE', name: 'Revenue', type: 'revenue', currency: null },
    // Expenses
    { code: 'EXPENSE_SOFTWARE', name: 'Software Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_TRANSPORT', name: 'Transport Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_TRAVEL', name: 'Travel Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_MARKETING', name: 'Marketing Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_SALARY', name: 'Salary Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_CONTRACTOR', name: 'Contractor Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_RENT', name: 'Rent Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_TAX', name: 'Tax Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_BANK_FEE', name: 'Bank Fee Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_MEALS', name: 'Meals Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_INSURANCE', name: 'Insurance Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_EDUCATION', name: 'Education Expense', type: 'expense', currency: null },
    { code: 'EXPENSE_OTHER', name: 'Other Expense', type: 'expense', currency: null },
    { code: 'FX_LOSS', name: 'FX Gain/Loss', type: 'expense', currency: null },
    { code: 'BAD_DEBT_EXPENSE', name: 'Bad Debt Expense', type: 'expense', currency: null },
  ];

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('account')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      // code is the stable, human-readable key VoucherLines resolve against.
      // UNIQUE is a real DB invariant (G6) — a duplicate code must be rejected
      // by the DB, not only by application code.
      .addColumn('code', 'text', (col) => col.notNull().unique())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('type', 'text', (col) =>
        col
          .notNull()
          .check(
            sql`type IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
          ),
      )
      // NULL for base-currency accounts; a currency code for FX accounts.
      .addColumn('currency', 'text')
      // Self-referential FK; hierarchy traversal deferred (schema only).
      .addColumn('parent_id', 'integer', (col) =>
        col.references('account.id'),
      )
      .addColumn('is_system', 'integer', (col) => col.notNull().defaultTo(0))
      .execute();

    for (const a of SEED) {
      await db
        .insertInto('account')
        .values({
          code: a.code,
          name: a.name,
          type: a.type,
          currency: a.currency,
          parent_id: null,
          is_system: 1,
        })
        .execute();
    }
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('account').ifExists().execute();
  }
  ```

- [ ] **6.5 Register migration 002 in the index.** Edit `src/database/migrations/index.ts`:
  ```ts
  import { Migration } from 'kysely/migration';
  import * as m001 from './001_create_organization';
  import * as m002 from './002_create_account';

  export const migrations: Record<string, Migration> = {
    '001_create_organization': m001,
    '002_create_account': m002,
  };
  ```

- [ ] **6.6 Write the Account domain types.** Create `src/ledger/account/types.ts`:
  ```ts
  export type AccountType =
    | 'asset'
    | 'liability'
    | 'equity'
    | 'revenue'
    | 'expense';

  export interface Account {
    id: number;
    code: string;
    name: string;
    type: AccountType;
    // Set only for foreign-currency accounts (e.g. BANK_USD); null otherwise.
    currency: string | null;
    parent_id: number | null;
    is_system: boolean;
  }
  ```

- [ ] **6.7 Write the AccountService.** Create `src/ledger/account/account.service.ts`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../../database/types';
  import { Account, AccountType } from './types';

  @Injectable()
  export class AccountService {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async getAccounts(): Promise<Account[]> {
      const rows = await this.db
        .selectFrom('account')
        .selectAll()
        .orderBy('code')
        .execute();
      return rows.map((r) => this.mapRow(r));
    }

    async getAccountByCode(code: string): Promise<Account | null> {
      const row = await this.db
        .selectFrom('account')
        .selectAll()
        .where('code', '=', code)
        .executeTakeFirst();
      return row ? this.mapRow(row) : null;
    }

    private mapRow(row: {
      id: number;
      code: string;
      name: string;
      type: string;
      currency: string | null;
      parent_id: number | null;
      is_system: number;
    }): Account {
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type as AccountType,
        currency: row.currency,
        parent_id: row.parent_id,
        is_system: row.is_system === 1,
      };
    }
  }
  ```

- [ ] **6.8 Run the integration test — expect PASS.** Command:
  ```
  npx jest src/ledger/account/account.service.spec.ts
  ```
  Expected PASS: all 8 tests green.

- [ ] **6.9 Write the failing controller test.** Create `src/ledger/account/account.controller.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { NotFoundException } from '@nestjs/common';
  import { AccountController } from './account.controller';
  import { AccountService } from './account.service';
  import { Account } from './types';

  describe('AccountController', () => {
    let controller: AccountController;

    const cash: Account = {
      id: 1,
      code: 'CASH',
      name: 'Cash',
      type: 'asset',
      currency: null,
      parent_id: null,
      is_system: true,
    };

    const mockService = {
      getAccounts: jest.fn(),
      getAccountByCode: jest.fn(),
    };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [AccountController],
        providers: [{ provide: AccountService, useValue: mockService }],
      }).compile();

      controller = module.get<AccountController>(AccountController);
      jest.clearAllMocks();
    });

    it('GET /api/accounts wraps the list under an accounts key', async () => {
      mockService.getAccounts.mockResolvedValue([cash]);
      const result = await controller.getAccounts();
      expect(result.accounts).toEqual([cash]);
      expect(mockService.getAccounts).toHaveBeenCalledTimes(1);
    });

    it('GET /api/accounts/:code returns the requested account', async () => {
      mockService.getAccountByCode.mockResolvedValue(cash);
      const result = await controller.getAccount('CASH');
      expect(result.code).toBe('CASH');
      expect(mockService.getAccountByCode).toHaveBeenCalledWith('CASH');
    });

    it('GET /api/accounts/:code throws NotFoundException for unknown code', async () => {
      mockService.getAccountByCode.mockResolvedValue(null);
      await expect(controller.getAccount('NOPE')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  ```

- [ ] **6.10 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/account/account.controller.spec.ts
  ```
  Expected FAIL: `Cannot find module './account.controller'`.

- [ ] **6.11 Write the AccountController.** Create `src/ledger/account/account.controller.ts`:
  ```ts
  import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
  import { AccountService } from './account.service';
  import { Account } from './types';

  @Controller('api/accounts')
  export class AccountController {
    constructor(private readonly accountService: AccountService) {}

    @Get()
    async getAccounts(): Promise<{ accounts: Account[] }> {
      return { accounts: await this.accountService.getAccounts() };
    }

    @Get(':code')
    async getAccount(@Param('code') code: string): Promise<Account> {
      const account = await this.accountService.getAccountByCode(code);
      if (!account) {
        throw new NotFoundException(`Account '${code}' not found`);
      }
      return account;
    }
  }
  ```

- [ ] **6.12 Write the AccountModule.** Create `src/ledger/account/account.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../../database/database.module';
  import { AccountController } from './account.controller';
  import { AccountService } from './account.service';

  @Module({
    imports: [DatabaseModule],
    controllers: [AccountController],
    providers: [AccountService],
    exports: [AccountService],
  })
  export class AccountModule {}
  ```

- [ ] **6.13 Wire AccountModule into the app.** Edit `src/app.module.ts` — add the import and list it:
  ```ts
  import { AccountModule } from './ledger/account/account.module';
  ```
  and add `AccountModule,` to the `imports` array.

- [ ] **6.14 Run both Task-6 specs — expect PASS.** Command:
  ```
  npx jest src/ledger/account
  ```
  Expected PASS: integration + controller tests all green.

- [ ] **6.15 Wave gate (G1).** Command:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  Expected: all four green.

- [ ] **6.16 Commit.** Commands:
  ```
  git add src/database/migrations/002_create_account.ts src/database/migrations/index.ts src/database/types.ts src/ledger/account/ src/app.module.ts
  git commit -m "feat(ledger): canonical account chart schema + seed data"
  ```

---

## Task 7 — Voucher + VoucherLine schema + repository

**Files:**
- Create: `src/database/migrations/003_create_voucher.ts`
- Create: `src/database/migrations/004_create_voucher_line.ts`
- Modify: `src/database/migrations/index.ts`
- Modify: `src/database/types.ts`
- Create: `src/ledger/voucher/types.ts`
- Create: `src/ledger/voucher/voucher.repository.ts`
- Create: `src/ledger/voucher/voucher-line.repository.ts`
- Test: `src/ledger/voucher/voucher.repository.spec.ts` (real-DI integration, G2)
- Test: `src/ledger/voucher/voucher-line.repository.spec.ts` (real-DI integration, G2/G6 FK)

### Steps

- [ ] **7.1 Add VoucherTable + VoucherLineTable to the Kysely Database type.** Edit `src/database/types.ts`. Add to the `Database` interface:
  ```ts
    voucher: VoucherTable;
    voucher_line: VoucherLineTable;
  ```
  Append at end of file:
  ```ts
  export interface VoucherTable {
    id: Generated<number>;
    voucher_number: string;
    // ISO date string; drives Reporting-period membership (CONTEXT: tax-point).
    tax_point_date: string;
    // Unix seconds, set when the voucher is posted; null while unposted.
    posted_at: number | null;
    // Reserved for the hash chain (ADR-0013). Wave 2 never writes it.
    previous_hash: string | null;
    // FK to another voucher; set by the reversal flow (Task 18), null here.
    reverses_id: number | null;
    corrects_object_type: string | null;
    corrects_object_id: number | null;
    reason: string | null;
  }

  export interface VoucherLineTable {
    id: Generated<number>;
    voucher_id: number;
    account_id: number;
    // Cents in the original currency.
    amount: number;
    currency: string;
    // Cents in base currency (EUR).
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    // SQLite boolean (0/1): 1 = debit, 0 = credit.
    is_debit: number;
  }
  ```

- [ ] **7.2 Write the failing voucher.repository integration test.** Create `src/ledger/voucher/voucher.repository.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../../database/types';
  import { migrations } from '../../database/migrations';
  import { VoucherRepository } from './voucher.repository';

  describe('VoucherRepository (integration)', () => {
    let db: Kysely<Database>;
    let repo: VoucherRepository;

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          VoucherRepository,
        ],
      }).compile();

      repo = module.get(VoucherRepository);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('createVoucher inserts a row and returns it with an id', async () => {
      const v = await repo.createVoucher({
        voucher_number: 'V-2026-001',
        tax_point_date: '2026-03-15',
        posted_at: 1740000000,
      });
      expect(v.id).toBeGreaterThan(0);
      expect(v.voucher_number).toBe('V-2026-001');
      expect(v.tax_point_date).toBe('2026-03-15');
      expect(v.posted_at).toBe(1740000000);
      // previous_hash exists but is reserved (null) in Wave 2.
      expect(v.previous_hash).toBeNull();
    });

    it('getVoucherById returns the persisted voucher', async () => {
      const created = await repo.createVoucher({
        voucher_number: 'V-2026-002',
        tax_point_date: '2026-03-16',
        posted_at: null,
      });
      const fetched = await repo.getVoucherById(created.id);
      expect(fetched?.voucher_number).toBe('V-2026-002');
    });

    it('getVoucherById returns null for an unknown id', async () => {
      await expect(repo.getVoucherById(9999)).resolves.toBeNull();
    });

    it('getVouchers is empty on a fresh DB and reflects inserts', async () => {
      expect(await repo.getVouchers()).toEqual([]);
      await repo.createVoucher({
        voucher_number: 'V-2026-003',
        tax_point_date: '2026-03-17',
        posted_at: null,
      });
      expect(await repo.getVouchers()).toHaveLength(1);
    });

    it('enforces voucher_number UNIQUE at the DB level (G6)', async () => {
      await repo.createVoucher({
        voucher_number: 'V-2026-DUP',
        tax_point_date: '2026-03-18',
        posted_at: null,
      });
      await expect(
        repo.createVoucher({
          voucher_number: 'V-2026-DUP',
          tax_point_date: '2026-03-19',
          posted_at: null,
        }),
      ).rejects.toThrow();
    });
  });
  ```

- [ ] **7.3 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/voucher/voucher.repository.spec.ts
  ```
  Expected FAIL: `Cannot find module './voucher.repository'`.

- [ ] **7.4 Write the voucher migration.** Create `src/database/migrations/003_create_voucher.ts`:
  ```ts
  import { Kysely } from 'kysely';

  // A Voucher is an immutable, balanced accounting document (ADR-0001). Wave 2
  // creates the schema; posting (Task 9) writes posted_at, and the hash chain
  // (previous_hash, ADR-0013) and reversal/correction columns are reserved only.
  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('voucher')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      // voucher_number is a real UNIQUE DB invariant (G6).
      .addColumn('voucher_number', 'text', (col) => col.notNull().unique())
      .addColumn('tax_point_date', 'text', (col) => col.notNull())
      .addColumn('posted_at', 'integer')
      // Reserved for the hash chain; never written in Wave 2.
      .addColumn('previous_hash', 'text')
      // Reversal / correction references; populated by Task 18.
      .addColumn('reverses_id', 'integer', (col) =>
        col.references('voucher.id'),
      )
      .addColumn('corrects_object_type', 'text')
      .addColumn('corrects_object_id', 'integer')
      .addColumn('reason', 'text')
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('voucher').ifExists().execute();
  }
  ```

- [ ] **7.5 Write the voucher_line migration.** Create `src/database/migrations/004_create_voucher_line.ts`:
  ```ts
  import { Kysely } from 'kysely';

  // A VoucherLine is a single debit/credit against an Account within a Voucher
  // (ADR-0001). Carries original amount+currency, base-currency amount, and the
  // FX rate (ADR-0004). FKs to voucher and account are real DB invariants (G6).
  export async function up(db: Kysely<any>): Promise<void> {
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
      // Cents in the original currency.
      .addColumn('amount', 'integer', (col) => col.notNull())
      .addColumn('currency', 'text', (col) => col.notNull())
      // Cents in base currency (EUR).
      .addColumn('base_amount', 'integer', (col) => col.notNull())
      .addColumn('fx_rate', 'real', (col) => col.notNull())
      .addColumn('vat_code', 'text')
      // SQLite boolean (0/1): 1 = debit, 0 = credit.
      .addColumn('is_debit', 'integer', (col) => col.notNull())
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('voucher_line').ifExists().execute();
  }
  ```

- [ ] **7.6 Register migrations 003 + 004.** Edit `src/database/migrations/index.ts`:
  ```ts
  import { Migration } from 'kysely/migration';
  import * as m001 from './001_create_organization';
  import * as m002 from './002_create_account';
  import * as m003 from './003_create_voucher';
  import * as m004 from './004_create_voucher_line';

  export const migrations: Record<string, Migration> = {
    '001_create_organization': m001,
    '002_create_account': m002,
    '003_create_voucher': m003,
    '004_create_voucher_line': m004,
  };
  ```

  > **Note (G6 — FK enforcement in SQLite):** better-sqlite3 does not enforce foreign keys unless `PRAGMA foreign_keys = ON`. To make the `voucher_line.voucher_id → voucher.id` FK a *real* rejected write, enable the pragma. The cleanest place is the connection — but Wave 2's test harness creates its own `SqliteDb(':memory:')`. So enable it inside migration 004 as the final statement (it persists for the connection) **and** rely on the same in the runtime dialect. Add this line at the end of `up()` in `004_create_voucher_line.ts`:
  ```ts
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  ```
  and add `sql` to the import: `import { Kysely, sql } from 'kysely';`. The FK-violation test in step 7.8 proves the constraint actually rejects.

- [ ] **7.7 Write the Voucher domain types.** Create `src/ledger/voucher/types.ts`:
  ```ts
  export interface VoucherLine {
    id: number;
    voucher_id: number;
    account_id: number;
    // Cents in original currency.
    amount: number;
    currency: string;
    // Cents in base currency (EUR).
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    is_debit: boolean;
  }

  export interface Voucher {
    id: number;
    voucher_number: string;
    tax_point_date: string;
    posted_at: number | null;
    previous_hash: string | null;
    reverses_id: number | null;
    corrects_object_type: string | null;
    corrects_object_id: number | null;
    reason: string | null;
  }

  // Input shapes for posting (Task 9). account_code is resolved to account_id
  // by the posting service; base_amount + fx_rate are supplied by the caller.
  export interface DraftVoucherLine {
    account_code: string;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    vat_code?: string | null;
    is_debit: boolean;
  }

  export interface DraftVoucher {
    voucher_number: string;
    tax_point_date: string;
    lines: DraftVoucherLine[];
  }

  export interface PostedVoucher extends Voucher {
    lines: VoucherLine[];
  }

  // What the repository needs to insert a voucher row.
  export interface NewVoucher {
    voucher_number: string;
    tax_point_date: string;
    posted_at: number | null;
  }

  // What the repository needs to insert a line row. Already resolved to
  // account_id and validated by the time it reaches the repository.
  export interface NewVoucherLine {
    voucher_id: number;
    account_id: number;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    is_debit: boolean;
  }
  ```

- [ ] **7.8 Write the failing voucher-line.repository integration test (incl. FK).** Create `src/ledger/voucher/voucher-line.repository.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../../database/types';
  import { migrations } from '../../database/migrations';
  import { VoucherRepository } from './voucher.repository';
  import { VoucherLineRepository } from './voucher-line.repository';
  import { AccountService } from '../account/account.service';

  describe('VoucherLineRepository (integration)', () => {
    let db: Kysely<Database>;
    let voucherRepo: VoucherRepository;
    let lineRepo: VoucherLineRepository;
    let accounts: AccountService;

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          VoucherRepository,
          VoucherLineRepository,
          AccountService,
        ],
      }).compile();

      voucherRepo = module.get(VoucherRepository);
      lineRepo = module.get(VoucherLineRepository);
      accounts = module.get(AccountService);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('createVoucherLine inserts a line linked to a voucher', async () => {
      const voucher = await voucherRepo.createVoucher({
        voucher_number: 'V-LINE-001',
        tax_point_date: '2026-03-15',
        posted_at: null,
      });
      const cash = await accounts.getAccountByCode('CASH');
      const line = await lineRepo.createVoucherLine({
        voucher_id: voucher.id,
        account_id: cash!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      });
      expect(line.id).toBeGreaterThan(0);
      expect(line.voucher_id).toBe(voucher.id);
      expect(line.is_debit).toBe(true);
    });

    it('getLinesByVoucherId returns all lines for a voucher', async () => {
      const voucher = await voucherRepo.createVoucher({
        voucher_number: 'V-LINE-002',
        tax_point_date: '2026-03-15',
        posted_at: null,
      });
      const expense = await accounts.getAccountByCode('EXPENSE_SOFTWARE');
      const cash = await accounts.getAccountByCode('CASH');
      await lineRepo.createVoucherLine({
        voucher_id: voucher.id,
        account_id: expense!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      });
      await lineRepo.createVoucherLine({
        voucher_id: voucher.id,
        account_id: cash!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      });
      const lines = await lineRepo.getLinesByVoucherId(voucher.id);
      expect(lines).toHaveLength(2);
    });

    it('rejects a line whose voucher_id has no parent voucher (FK, G6)', async () => {
      const cash = await accounts.getAccountByCode('CASH');
      await expect(
        lineRepo.createVoucherLine({
          voucher_id: 999999,
          account_id: cash!.id,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: null,
          is_debit: true,
        }),
      ).rejects.toThrow();
    });
  });
  ```

- [ ] **7.9 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/voucher/voucher-line.repository.spec.ts
  ```
  Expected FAIL: `Cannot find module './voucher-line.repository'`.

- [ ] **7.10 Write the VoucherRepository.** Create `src/ledger/voucher/voucher.repository.ts`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../../database/types';
  import { NewVoucher, Voucher } from './types';

  @Injectable()
  export class VoucherRepository {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async createVoucher(input: NewVoucher): Promise<Voucher> {
      const inserted = await this.db
        .insertInto('voucher')
        .values({
          voucher_number: input.voucher_number,
          tax_point_date: input.tax_point_date,
          posted_at: input.posted_at,
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.mapRow(inserted);
    }

    async getVoucherById(id: number): Promise<Voucher | null> {
      const row = await this.db
        .selectFrom('voucher')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? this.mapRow(row) : null;
    }

    async getVouchers(): Promise<Voucher[]> {
      const rows = await this.db
        .selectFrom('voucher')
        .selectAll()
        .orderBy('id')
        .execute();
      return rows.map((r) => this.mapRow(r));
    }

    private mapRow(row: {
      id: number;
      voucher_number: string;
      tax_point_date: string;
      posted_at: number | null;
      previous_hash: string | null;
      reverses_id: number | null;
      corrects_object_type: string | null;
      corrects_object_id: number | null;
      reason: string | null;
    }): Voucher {
      return {
        id: row.id,
        voucher_number: row.voucher_number,
        tax_point_date: row.tax_point_date,
        posted_at: row.posted_at,
        previous_hash: row.previous_hash,
        reverses_id: row.reverses_id,
        corrects_object_type: row.corrects_object_type,
        corrects_object_id: row.corrects_object_id,
        reason: row.reason,
      };
    }
  }
  ```

- [ ] **7.11 Write the VoucherLineRepository.** Create `src/ledger/voucher/voucher-line.repository.ts`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../../database/types';
  import { NewVoucherLine, VoucherLine } from './types';

  @Injectable()
  export class VoucherLineRepository {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async createVoucherLine(input: NewVoucherLine): Promise<VoucherLine> {
      const inserted = await this.db
        .insertInto('voucher_line')
        .values({
          voucher_id: input.voucher_id,
          account_id: input.account_id,
          amount: input.amount,
          currency: input.currency,
          base_amount: input.base_amount,
          fx_rate: input.fx_rate,
          vat_code: input.vat_code,
          is_debit: input.is_debit ? 1 : 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.mapRow(inserted);
    }

    async getLinesByVoucherId(voucherId: number): Promise<VoucherLine[]> {
      const rows = await this.db
        .selectFrom('voucher_line')
        .selectAll()
        .where('voucher_id', '=', voucherId)
        .orderBy('id')
        .execute();
      return rows.map((r) => this.mapRow(r));
    }

    private mapRow(row: {
      id: number;
      voucher_id: number;
      account_id: number;
      amount: number;
      currency: string;
      base_amount: number;
      fx_rate: number;
      vat_code: string | null;
      is_debit: number;
    }): VoucherLine {
      return {
        id: row.id,
        voucher_id: row.voucher_id,
        account_id: row.account_id,
        amount: row.amount,
        currency: row.currency,
        base_amount: row.base_amount,
        fx_rate: row.fx_rate,
        vat_code: row.vat_code,
        is_debit: row.is_debit === 1,
      };
    }
  }
  ```

- [ ] **7.12 Run both Task-7 repository specs — expect PASS.** Command:
  ```
  npx jest src/ledger/voucher/voucher.repository.spec.ts src/ledger/voucher/voucher-line.repository.spec.ts
  ```
  Expected PASS: all tests green, including the UNIQUE and FK rejection tests.

  > If the FK-violation test does NOT throw, `PRAGMA foreign_keys = ON` did not take. Verify the pragma line in `004_create_voucher_line.ts` runs as part of the same connection (it does — the migrator and the test share one `db`). Do not weaken the test.

- [ ] **7.13 Wave gate (G1).** Command:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  Expected: all four green.

- [ ] **7.14 Commit.** Commands:
  ```
  git add src/database/migrations/003_create_voucher.ts src/database/migrations/004_create_voucher_line.ts src/database/migrations/index.ts src/database/types.ts src/ledger/voucher/types.ts src/ledger/voucher/voucher.repository.ts src/ledger/voucher/voucher-line.repository.ts src/ledger/voucher/voucher.repository.spec.ts src/ledger/voucher/voucher-line.repository.spec.ts
  git commit -m "feat(ledger): voucher + voucher_line schema + repository"
  ```

---

## Task 8 — Double-entry validation service

> Structural-invariant layer only (ADR-0005): pure arithmetic + account existence. NO period locking, NO VAT-code semantics, NO posting. These are Task 13 / Task 9.

**Files:**
- Create: `src/ledger/validation/types.ts`
- Create: `src/ledger/validation/ledger-validation.service.ts`
- Test: `src/ledger/validation/ledger-validation.service.spec.ts`

### Steps

- [ ] **8.1 Write the ValidationResult type.** Create `src/ledger/validation/types.ts`:
  ```ts
  export interface ValidationResult {
    isValid: boolean;
    errors: string[];
  }

  // The minimal line shape the structural validator needs. account_id must
  // already be resolved (the posting service resolves account_code → id before
  // validating, and supplies the set of valid ids).
  export interface ValidatableLine {
    account_id: number;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    is_debit: boolean;
  }
  ```

- [ ] **8.2 Write the exhaustive failing validation test.** Create `src/ledger/validation/ledger-validation.service.spec.ts`:
  ```ts
  import { LedgerValidationService } from './ledger-validation.service';
  import { ValidatableLine } from './types';

  describe('LedgerValidationService', () => {
    let service: LedgerValidationService;
    // Account ids that exist for the purposes of these tests.
    const validIds = new Set([1, 2]);

    const line = (over: Partial<ValidatableLine>): ValidatableLine => ({
      account_id: 1,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      is_debit: true,
      ...over,
    });

    beforeEach(() => {
      service = new LedgerValidationService();
    });

    it('passes a balanced voucher (Dr 100 / Cr 100)', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, is_debit: true }),
          line({ account_id: 2, is_debit: false }),
        ],
        validIds,
      );
      expect(result).toEqual({ isValid: true, errors: [] });
    });

    it('passes a balanced multi-line voucher with non-default amounts', () => {
      // 7000 + 3000 debit == 10000 credit (G3: non-default discriminating case)
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, amount: 7000, base_amount: 7000, is_debit: true }),
          line({ account_id: 2, amount: 3000, base_amount: 3000, is_debit: true }),
          line({ account_id: 1, amount: 10000, base_amount: 10000, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(true);
    });

    it('fails an unbalanced voucher (Dr 100 / Cr 99)', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, amount: 10000, base_amount: 10000, is_debit: true }),
          line({ account_id: 2, amount: 9900, base_amount: 9900, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Voucher lines do not balance');
    });

    it('balances on base_amount, not original amount', () => {
      // Original amounts differ (USD vs EUR) but base amounts balance.
      const result = service.validateVoucherLines(
        [
          line({
            account_id: 1,
            amount: 10000,
            currency: 'USD',
            base_amount: 9200,
            fx_rate: 0.92,
            is_debit: true,
          }),
          line({
            account_id: 2,
            amount: 9200,
            currency: 'EUR',
            base_amount: 9200,
            fx_rate: 1,
            is_debit: false,
          }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(true);
    });

    it('fails when a line references a non-existent account', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, is_debit: true }),
          line({ account_id: 42, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Account does not exist');
    });

    it('fails when an amount is not positive', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, amount: -10000, base_amount: -10000, is_debit: true }),
          line({ account_id: 2, amount: 10000, base_amount: 10000, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Amount must be positive');
    });

    it('fails when an amount is not an integer', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, amount: 100.5, base_amount: 100.5, is_debit: true }),
          line({ account_id: 2, amount: 100.5, base_amount: 100.5, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Amount must be an integer (cents)');
    });

    it('fails when currency is empty', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 1, currency: '', is_debit: true }),
          line({ account_id: 2, currency: 'EUR', is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Currency must not be empty');
    });

    it('fails on FX mismatch (amount=100, rate=7.14, base_amount=500)', () => {
      const result = service.validateVoucherLines(
        [
          line({
            account_id: 1,
            amount: 100,
            currency: 'USD',
            base_amount: 500,
            fx_rate: 7.14,
            is_debit: true,
          }),
          line({ account_id: 2, amount: 500, base_amount: 500, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('base_amount does not match amount * fx_rate');
    });

    it('tolerates ±1 cent rounding in the FX check', () => {
      // 333 * 0.301 = 100.233 → expected base 100; supplied 100 is within 1 cent.
      const result = service.validateVoucherLines(
        [
          line({
            account_id: 1,
            amount: 333,
            currency: 'USD',
            base_amount: 100,
            fx_rate: 0.301,
            is_debit: true,
          }),
          line({ account_id: 2, amount: 100, base_amount: 100, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(true);
    });

    it('fails an empty voucher (no lines)', () => {
      const result = service.validateVoucherLines([], validIds);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Voucher must have at least two lines');
    });

    it('accumulates multiple distinct errors', () => {
      const result = service.validateVoucherLines(
        [
          line({ account_id: 99, amount: -5, base_amount: -5, currency: '', is_debit: true }),
          line({ account_id: 2, amount: 10000, base_amount: 10000, is_debit: false }),
        ],
        validIds,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
  ```

- [ ] **8.3 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/validation/ledger-validation.service.spec.ts
  ```
  Expected FAIL: `Cannot find module './ledger-validation.service'`.

- [ ] **8.4 Write the LedgerValidationService.** Create `src/ledger/validation/ledger-validation.service.ts`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { ValidatableLine, ValidationResult } from './types';

  // Structural invariants only (ADR-0005): balance to zero, accounts exist,
  // amounts are positive integer cents, currency present, base_amount consistent
  // with amount * fx_rate. These can never be overridden. NO period/VAT rules.
  @Injectable()
  export class LedgerValidationService {
    private static readonly FX_TOLERANCE_CENTS = 1;

    validateVoucherLines(
      lines: ValidatableLine[],
      validAccountIds: Set<number>,
    ): ValidationResult {
      const errors: string[] = [];

      if (lines.length < 2) {
        errors.push('Voucher must have at least two lines');
      }

      let debitTotal = 0;
      let creditTotal = 0;
      let sawNonExistentAccount = false;
      let sawNonPositive = false;
      let sawNonInteger = false;
      let sawEmptyCurrency = false;
      let sawFxMismatch = false;

      for (const line of lines) {
        if (!validAccountIds.has(line.account_id)) {
          sawNonExistentAccount = true;
        }
        if (line.amount <= 0) {
          sawNonPositive = true;
        }
        if (!Number.isInteger(line.amount)) {
          sawNonInteger = true;
        }
        if (line.currency.length === 0) {
          sawEmptyCurrency = true;
        }
        const expectedBase = Math.round(line.amount * line.fx_rate);
        if (
          Math.abs(expectedBase - line.base_amount) >
          LedgerValidationService.FX_TOLERANCE_CENTS
        ) {
          sawFxMismatch = true;
        }
        if (line.is_debit) {
          debitTotal += line.base_amount;
        } else {
          creditTotal += line.base_amount;
        }
      }

      if (sawNonExistentAccount) errors.push('Account does not exist');
      if (sawNonPositive) errors.push('Amount must be positive');
      if (sawNonInteger) errors.push('Amount must be an integer (cents)');
      if (sawEmptyCurrency) errors.push('Currency must not be empty');
      if (sawFxMismatch)
        errors.push('base_amount does not match amount * fx_rate');
      if (debitTotal !== creditTotal)
        errors.push('Voucher lines do not balance');

      return { isValid: errors.length === 0, errors };
    }
  }
  ```

- [ ] **8.5 Run it — expect PASS.** Command:
  ```
  npx jest src/ledger/validation/ledger-validation.service.spec.ts
  ```
  Expected PASS: all validation cases green.

- [ ] **8.6 Wave gate (G1).** Command:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  Expected: all four green.

- [ ] **8.7 Commit.** Commands:
  ```
  git add src/ledger/validation/
  git commit -m "feat(ledger): double-entry validation service"
  ```

---

## Task 9 — Posting service (atomic voucher creation)

> Atomic post: resolve account codes → ids, validate, then write voucher + lines inside ONE better-sqlite3 transaction (ADR-0005). Invalid posts throw and leave NO partial rows. NO period/VAT rules, NO reversal, NO `previous_hash`.

**Files:**
- Create: `src/ledger/posting/types.ts`
- Create: `src/ledger/posting/posting.service.ts`
- Create: `src/ledger/posting/posting.module.ts`
- Create: `src/ledger/voucher/voucher.controller.ts`
- Create: `src/ledger/voucher/voucher.module.ts`
- Modify: `src/app.module.ts`
- Test: `src/ledger/posting/posting.service.spec.ts` (real-DI integration, G2)
- Test: `test/voucher.e2e-spec.ts` (e2e)

### Steps

- [ ] **9.1 Write the ValidationError type.** Create `src/ledger/posting/types.ts`:
  ```ts
  // Thrown by PostingService when structural validation fails. Carries the list
  // of structural errors so the controller can map it to HTTP 400.
  export class ValidationError extends Error {
    constructor(public readonly errors: string[]) {
      super(`Voucher validation failed: ${errors.join('; ')}`);
      this.name = 'ValidationError';
    }
  }
  ```

- [ ] **9.2 Write the failing posting integration test (atomicity).** Create `src/ledger/posting/posting.service.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../../database/types';
  import { migrations } from '../../database/migrations';
  import { AccountService } from '../account/account.service';
  import { VoucherRepository } from '../voucher/voucher.repository';
  import { VoucherLineRepository } from '../voucher/voucher-line.repository';
  import { LedgerValidationService } from '../validation/ledger-validation.service';
  import { PostingService } from './posting.service';
  import { ValidationError } from './types';
  import { DraftVoucher } from '../voucher/types';

  describe('PostingService (integration)', () => {
    let db: Kysely<Database>;
    let posting: PostingService;
    let voucherRepo: VoucherRepository;
    let lineRepo: VoucherLineRepository;

    const balanced = (number: string): DraftVoucher => ({
      voucher_number: number,
      tax_point_date: '2026-03-15',
      lines: [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CASH',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    });

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          VoucherRepository,
          VoucherLineRepository,
          LedgerValidationService,
          PostingService,
        ],
      }).compile();

      posting = module.get(PostingService);
      voucherRepo = module.get(VoucherRepository);
      lineRepo = module.get(VoucherLineRepository);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('posts a valid voucher with posted_at set and both lines persisted', async () => {
      const result = await posting.postVoucher(balanced('V-2026-100'));
      expect(result.id).toBeGreaterThan(0);
      expect(result.posted_at).not.toBeNull();
      expect(result.lines).toHaveLength(2);

      const persisted = await lineRepo.getLinesByVoucherId(result.id);
      expect(persisted).toHaveLength(2);
    });

    it('resolves account_code to the correct account_id', async () => {
      const result = await posting.postVoucher(balanced('V-2026-101'));
      const debit = result.lines.find((l) => l.is_debit);
      expect(debit?.account_id).toBeGreaterThan(0);
    });

    it('throws ValidationError and writes NOTHING for an unbalanced voucher', async () => {
      const unbalanced: DraftVoucher = {
        voucher_number: 'V-2026-102',
        tax_point_date: '2026-03-15',
        lines: [
          {
            account_code: 'EXPENSE_SOFTWARE',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'CASH',
            amount: 9900,
            currency: 'EUR',
            base_amount: 9900,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      };
      await expect(posting.postVoucher(unbalanced)).rejects.toThrow(
        ValidationError,
      );
      // Atomicity: no voucher row, no line row leaked.
      expect(await voucherRepo.getVouchers()).toHaveLength(0);
    });

    it('throws ValidationError for an unknown account_code and writes nothing', async () => {
      const draft: DraftVoucher = {
        voucher_number: 'V-2026-103',
        tax_point_date: '2026-03-15',
        lines: [
          {
            account_code: 'NOT_A_REAL_ACCOUNT',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            is_debit: true,
          },
          {
            account_code: 'CASH',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      };
      await expect(posting.postVoucher(draft)).rejects.toThrow(ValidationError);
      expect(await voucherRepo.getVouchers()).toHaveLength(0);
    });

    it('posts an FX voucher balancing on base_amount (non-default values, G3)', async () => {
      const draft: DraftVoucher = {
        voucher_number: 'V-2026-104',
        tax_point_date: '2026-03-15',
        lines: [
          {
            account_code: 'BANK_USD',
            amount: 10000,
            currency: 'USD',
            base_amount: 9200,
            fx_rate: 0.92,
            is_debit: true,
          },
          {
            account_code: 'REVENUE',
            amount: 9200,
            currency: 'EUR',
            base_amount: 9200,
            fx_rate: 1,
            is_debit: false,
          },
        ],
      };
      const result = await posting.postVoucher(draft);
      expect(result.lines).toHaveLength(2);
      const usdLine = result.lines.find((l) => l.currency === 'USD');
      expect(usdLine?.base_amount).toBe(9200);
    });
  });
  ```

- [ ] **9.3 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/posting/posting.service.spec.ts
  ```
  Expected FAIL: `Cannot find module './posting.service'`.

- [ ] **9.4 Write the PostingService.** Create `src/ledger/posting/posting.service.ts`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../../database/types';
  import { AccountService } from '../account/account.service';
  import { LedgerValidationService } from '../validation/ledger-validation.service';
  import { ValidatableLine } from '../validation/types';
  import { DraftVoucher, PostedVoucher, VoucherLine } from '../voucher/types';
  import { ValidationError } from './types';

  // Atomically posts a Voucher (ADR-0005): resolve account codes, validate
  // structural invariants, then write the voucher + all lines inside a single
  // SQLite transaction. An invalid draft throws ValidationError and writes
  // nothing. Wave 2 does NOT set previous_hash, check periods, or apply VAT.
  @Injectable()
  export class PostingService {
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly accountService: AccountService,
      private readonly validation: LedgerValidationService,
    ) {}

    async postVoucher(draft: DraftVoucher): Promise<PostedVoucher> {
      // Resolve each line's account_code → account_id. Unknown codes are
      // surfaced as a structural "Account does not exist" error rather than a
      // crash, keeping all failures on the ValidationError path.
      const accounts = await this.accountService.getAccounts();
      const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
      const validIds = new Set(accounts.map((a) => a.id));

      // Sentinel id (0) for unknown codes — never a real account id, so the
      // validator reports it as non-existent.
      const resolved: ValidatableLine[] = draft.lines.map((l) => ({
        account_id: idByCode.get(l.account_code) ?? 0,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
      }));

      const result = this.validation.validateVoucherLines(resolved, validIds);
      if (!result.isValid) {
        throw new ValidationError(result.errors);
      }

      const postedAt = Math.floor(Date.now() / 1000);

      return this.db.transaction().execute(async (trx) => {
        const voucher = await trx
          .insertInto('voucher')
          .values({
            voucher_number: draft.voucher_number,
            tax_point_date: draft.tax_point_date,
            posted_at: postedAt,
            previous_hash: null,
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

        return {
          id: voucher.id,
          voucher_number: voucher.voucher_number,
          tax_point_date: voucher.tax_point_date,
          posted_at: voucher.posted_at,
          previous_hash: voucher.previous_hash,
          reverses_id: voucher.reverses_id,
          corrects_object_type: voucher.corrects_object_type,
          corrects_object_id: voucher.corrects_object_id,
          reason: voucher.reason,
          lines,
        };
      });
    }
  }
  ```

- [ ] **9.5 Run the posting integration test — expect PASS.** Command:
  ```
  npx jest src/ledger/posting/posting.service.spec.ts
  ```
  Expected PASS: all posting/atomicity tests green, including "writes NOTHING" on failure.

- [ ] **9.6 Write the VoucherController (read + post; mutating verbs added in Task 10).** Create `src/ledger/voucher/voucher.controller.ts`:
  ```ts
  import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    NotFoundException,
    BadRequestException,
  } from '@nestjs/common';
  import { PostingService } from '../posting/posting.service';
  import { ValidationError } from '../posting/types';
  import { VoucherRepository } from './voucher.repository';
  import { VoucherLineRepository } from './voucher-line.repository';
  import { DraftVoucher, PostedVoucher, Voucher } from './types';

  @Controller('api/vouchers')
  export class VoucherController {
    constructor(
      private readonly postingService: PostingService,
      private readonly voucherRepo: VoucherRepository,
      private readonly lineRepo: VoucherLineRepository,
    ) {}

    @Get()
    async getVouchers(): Promise<{ vouchers: Voucher[] }> {
      return { vouchers: await this.voucherRepo.getVouchers() };
    }

    @Get(':id')
    async getVoucher(@Param('id') id: string): Promise<PostedVoucher> {
      const voucher = await this.voucherRepo.getVoucherById(Number(id));
      if (!voucher) {
        throw new NotFoundException(`Voucher ${id} not found`);
      }
      const lines = await this.lineRepo.getLinesByVoucherId(voucher.id);
      return { ...voucher, lines };
    }

    @Post()
    async postVoucher(@Body() draft: DraftVoucher): Promise<PostedVoucher> {
      try {
        return await this.postingService.postVoucher(draft);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new BadRequestException(err.errors);
        }
        throw err;
      }
    }
  }
  ```

- [ ] **9.7 Write the PostingModule.** Create `src/ledger/posting/posting.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../../database/database.module';
  import { AccountModule } from '../account/account.module';
  import { LedgerValidationService } from '../validation/ledger-validation.service';
  import { PostingService } from './posting.service';

  @Module({
    imports: [DatabaseModule, AccountModule],
    providers: [LedgerValidationService, PostingService],
    exports: [PostingService],
  })
  export class PostingModule {}
  ```

- [ ] **9.8 Write the VoucherModule.** Create `src/ledger/voucher/voucher.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../../database/database.module';
  import { PostingModule } from '../posting/posting.module';
  import { VoucherController } from './voucher.controller';
  import { VoucherRepository } from './voucher.repository';
  import { VoucherLineRepository } from './voucher-line.repository';

  @Module({
    imports: [DatabaseModule, PostingModule],
    controllers: [VoucherController],
    providers: [VoucherRepository, VoucherLineRepository],
    exports: [VoucherRepository, VoucherLineRepository],
  })
  export class VoucherModule {}
  ```

- [ ] **9.9 Wire VoucherModule into the app.** Edit `src/app.module.ts` — add the import and list it:
  ```ts
  import { VoucherModule } from './ledger/voucher/voucher.module';
  ```
  and add `VoucherModule,` to the `imports` array.

- [ ] **9.10 Write the failing voucher e2e test.** Create `test/voucher.e2e-spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { INestApplication } from '@nestjs/common';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import request from 'supertest';
  import { App } from 'supertest/types';
  import { Database } from './../src/database/types';
  import { migrations } from './../src/database/migrations';
  import { AccountService } from './../src/ledger/account/account.service';
  import { LedgerValidationService } from './../src/ledger/validation/ledger-validation.service';
  import { PostingService } from './../src/ledger/posting/posting.service';
  import { VoucherRepository } from './../src/ledger/voucher/voucher.repository';
  import { VoucherLineRepository } from './../src/ledger/voucher/voucher-line.repository';
  import { VoucherController } from './../src/ledger/voucher/voucher.controller';

  describe('Voucher (e2e)', () => {
    let app: INestApplication<App>;
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
      if (error)
        throw error instanceof Error ? error : new Error('Migration failed');

      const moduleFixture: TestingModule = await Test.createTestingModule({
        controllers: [VoucherController],
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          LedgerValidationService,
          PostingService,
          VoucherRepository,
          VoucherLineRepository,
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
      await db.destroy();
    });

    const balanced = {
      voucher_number: 'V-2026-E2E-1',
      tax_point_date: '2026-01-15',
      lines: [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CASH',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    };

    it('POST /api/vouchers posts a valid voucher (201) with posted_at', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send(balanced)
        .expect(201);
      expect(res.body.posted_at).not.toBeNull();
      expect(res.body.lines).toHaveLength(2);
    });

    it('POST /api/vouchers rejects an unbalanced voucher (400) atomically', async () => {
      const unbalanced = {
        ...balanced,
        voucher_number: 'V-2026-E2E-2',
        lines: [
          { ...balanced.lines[0] },
          { ...balanced.lines[1], amount: 9900, base_amount: 9900 },
        ],
      };
      await request(app.getHttpServer())
        .post('/api/vouchers')
        .send(unbalanced)
        .expect(400);

      const list = await request(app.getHttpServer())
        .get('/api/vouchers')
        .expect(200);
      expect(
        list.body.vouchers.find(
          (v: { voucher_number: string }) =>
            v.voucher_number === 'V-2026-E2E-2',
        ),
      ).toBeUndefined();
    });

    it('GET /api/vouchers/:id returns the posted voucher with lines', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send({ ...balanced, voucher_number: 'V-2026-E2E-3' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .get(`/api/vouchers/${created.body.id}`)
        .expect(200);
      expect(res.body.voucher_number).toBe('V-2026-E2E-3');
      expect(res.body.lines).toHaveLength(2);
    });
  });
  ```

- [ ] **9.11 Run the e2e test — expect PASS.** Command:
  ```
  npx jest --config ./test/jest-e2e.json voucher
  ```
  Expected PASS: post-valid (201), reject-atomic (400 + not listed), get-by-id all green.

- [ ] **9.12 Wave gate (G1).** Command:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  Expected: all four green.

- [ ] **9.13 Commit.** Commands:
  ```
  git add src/ledger/posting/ src/ledger/voucher/voucher.controller.ts src/ledger/voucher/voucher.module.ts src/app.module.ts test/voucher.e2e-spec.ts
  git commit -m "feat(ledger): atomic posting service"
  ```

---

## Task 10 — Immutability enforcement at API layer

> Posted Vouchers are immutable (ADR-0001, ADR-0006): PUT/PATCH/DELETE → 405; GET stays 200. Corrections are reversals (Task 18), never edits. NO draft editing (drafts don't exist in Wave 2).

**Files:**
- Modify: `src/ledger/voucher/voucher.controller.ts`
- Test: `src/ledger/voucher/voucher.controller.spec.ts`
- Modify: `test/voucher.e2e-spec.ts`

### Steps

- [ ] **10.1 Write the failing controller unit test for 405 + GET.** Create `src/ledger/voucher/voucher.controller.spec.ts`:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { MethodNotAllowedException } from '@nestjs/common';
  import { VoucherController } from './voucher.controller';
  import { PostingService } from '../posting/posting.service';
  import { VoucherRepository } from './voucher.repository';
  import { VoucherLineRepository } from './voucher-line.repository';
  import { Voucher } from './types';

  describe('VoucherController (immutability)', () => {
    let controller: VoucherController;

    const posted: Voucher = {
      id: 1,
      voucher_number: 'V-2026-001',
      tax_point_date: '2026-01-15',
      posted_at: 1740000000,
      previous_hash: null,
      reverses_id: null,
      corrects_object_type: null,
      corrects_object_id: null,
      reason: null,
    };

    const mockPosting = { postVoucher: jest.fn() };
    const mockVoucherRepo = {
      getVouchers: jest.fn(),
      getVoucherById: jest.fn(),
    };
    const mockLineRepo = { getLinesByVoucherId: jest.fn() };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [VoucherController],
        providers: [
          { provide: PostingService, useValue: mockPosting },
          { provide: VoucherRepository, useValue: mockVoucherRepo },
          { provide: VoucherLineRepository, useValue: mockLineRepo },
        ],
      }).compile();

      controller = module.get<VoucherController>(VoucherController);
      jest.clearAllMocks();
    });

    it('PUT /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
      expect(() => controller.updateVoucher('1')).toThrow(
        MethodNotAllowedException,
      );
      expect(() => controller.updateVoucher('1')).toThrow(
        'Posted vouchers are immutable',
      );
    });

    it('PATCH /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
      expect(() => controller.patchVoucher('1')).toThrow(
        MethodNotAllowedException,
      );
    });

    it('DELETE /api/vouchers/:id throws MethodNotAllowedException (405)', () => {
      expect(() => controller.deleteVoucher('1')).toThrow(
        MethodNotAllowedException,
      );
    });

    it('GET /api/vouchers/:id still returns the voucher with lines', async () => {
      mockVoucherRepo.getVoucherById.mockResolvedValue(posted);
      mockLineRepo.getLinesByVoucherId.mockResolvedValue([]);
      const result = await controller.getVoucher('1');
      expect(result.voucher_number).toBe('V-2026-001');
      expect(mockVoucherRepo.getVoucherById).toHaveBeenCalledWith(1);
    });
  });
  ```

- [ ] **10.2 Run it — expect FAIL.** Command:
  ```
  npx jest src/ledger/voucher/voucher.controller.spec.ts
  ```
  Expected FAIL: `controller.updateVoucher is not a function`.

- [ ] **10.3 Add the immutability handlers to the controller.** Edit `src/ledger/voucher/voucher.controller.ts`. Update the imports line to add the new decorators and exception:
  ```ts
  import {
    Controller,
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Param,
    Body,
    NotFoundException,
    BadRequestException,
    MethodNotAllowedException,
  } from '@nestjs/common';
  ```
  Then add these three handlers inside the class (after `postVoucher`):
  ```ts
    // Posted vouchers are immutable (ADR-0001, ADR-0006): every mutating verb is
    // rejected at the API boundary with 405. Corrections happen via reversal
    // counter-vouchers (Task 18), never by editing the original.
    @Put(':id')
    updateVoucher(@Param('id') _id: string): never {
      throw new MethodNotAllowedException('Posted vouchers are immutable');
    }

    @Patch(':id')
    patchVoucher(@Param('id') _id: string): never {
      throw new MethodNotAllowedException('Posted vouchers are immutable');
    }

    @Delete(':id')
    deleteVoucher(@Param('id') _id: string): never {
      throw new MethodNotAllowedException('Posted vouchers are immutable');
    }
  ```

- [ ] **10.4 Run the controller unit test — expect PASS.** Command:
  ```
  npx jest src/ledger/voucher/voucher.controller.spec.ts
  ```
  Expected PASS: all 405 + GET tests green.

- [ ] **10.5 Add e2e coverage for 405 over real HTTP.** Edit `test/voucher.e2e-spec.ts` — append these tests inside the `describe` block (after the GET-by-id test):
  ```ts
    it('PUT /api/vouchers/:id is rejected with 405', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send({ ...balanced, voucher_number: 'V-2026-E2E-PUT' })
        .expect(201);
      await request(app.getHttpServer())
        .put(`/api/vouchers/${created.body.id}`)
        .send({ reason: 'tampering' })
        .expect(405);
    });

    it('DELETE /api/vouchers/:id is rejected with 405', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send({ ...balanced, voucher_number: 'V-2026-E2E-DEL' })
        .expect(201);
      await request(app.getHttpServer())
        .delete(`/api/vouchers/${created.body.id}`)
        .expect(405);
    });

    it('PATCH /api/vouchers/:id is rejected with 405', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send({ ...balanced, voucher_number: 'V-2026-E2E-PATCH' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/vouchers/${created.body.id}`)
        .send({ reason: 'tampering' })
        .expect(405);
    });

    it('GET /api/vouchers/:id remains 200 for a posted voucher', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/vouchers')
        .send({ ...balanced, voucher_number: 'V-2026-E2E-GET' })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/vouchers/${created.body.id}`)
        .expect(200);
    });
  ```

- [ ] **10.6 Run the e2e test — expect PASS.** Command:
  ```
  npx jest --config ./test/jest-e2e.json voucher
  ```
  Expected PASS: PUT/DELETE/PATCH → 405, GET → 200, plus the Task-9 tests still green.

- [ ] **10.7 Wave gate (G1).** Command:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  Expected: all four green.

- [ ] **10.8 Commit.** Commands:
  ```
  git add src/ledger/voucher/voucher.controller.ts src/ledger/voucher/voucher.controller.spec.ts test/voucher.e2e-spec.ts
  git commit -m "feat(ledger): immutability enforcement on posted vouchers"
  ```

---

## Wave 2 verification pass (G8 — run before declaring the wave done)

- [ ] **V.1 Plan-compliance:** every Task 6–10 AC has a passing test. Run the full suite:
  ```
  npm run build && npm run lint && npm run test && npm run test:e2e
  ```
  All four green.

- [ ] **V.2 Scope-fidelity — G4 grep (schema only in migrations) must be EMPTY:**
  ```
  grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"
  ```
  Expected: no output.

- [ ] **V.3 Must-NOT-do greps (G5) — all must be EMPTY:**
  ```
  grep -rn "previous_hash" src --include=*.ts | grep -v "// " | grep -i "= .*hash\|sha256\|createHash"
  grep -rni "country.*specific\|DK_\|getVATCode" src/ledger --include=*.ts
  grep -rni "reverses_id =\|corrects_object" src/ledger --include=*.ts
  ```
  Expected: no output. (Hash chain is reserved-only; no country-specific accounts in the kernel; no reversal/correction logic in Wave 2.)

- [ ] **V.4 Code-quality (G1):** no `as any` slop, empty catches, or dead code introduced. Confirm `npm run lint` is clean (it is run-with-`--fix`, so re-run and diff stays empty):
  ```
  npm run lint
  git diff --stat
  ```
  Expected: lint clean; no unexpected reformatting.

- [ ] **V.5 EUR check:** confirm the seed uses `BANK_EUR` and not `BANK_DKK`, and all example payloads are EUR:
  ```
  grep -rn "BANK_DKK\|DKK" src test --include=*.ts
  ```
  Expected: no output.

- [ ] **V.6 G6 invariant proof:** confirm these tests exist and pass — `account.code` UNIQUE (none required by spec for account, but `voucher_number` UNIQUE in 7.2), FK `voucher_line.voucher_id → voucher.id` (7.8), immutability 405 (10.5). All covered above.
