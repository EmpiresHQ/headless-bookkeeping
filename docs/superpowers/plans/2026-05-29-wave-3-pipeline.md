# Wave 3 — Posting Pipeline (Business Objects, Rules, Policy) Implementation Plan

> **For omo executors:** This is the step-by-step "how" for the omo wave spec [`.omo/plans/wave-3-pipeline.md`](../../../.omo/plans/wave-3-pipeline.md), which carries each task's **Recommended Agent Profile** (`quick`/`oracle`/`deep`) and QA scenarios. Execute task-by-task: dispatch one agent per task per its profile, follow the red→green→commit TDD loop below, and pass the wave gate (`npm run build && npm run lint && npm run test && npm run test:e2e`, all green) before each commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full kernel intelligence layer — Expense and SalesInvoice business objects that generate draft Vouchers via the CountryPlugin, a three-tier Rules engine (structural / hard / semantic), a configurable Policy gate with logged Overrides, and an end-to-end pipeline that turns a business object into a posted, immutable Voucher.

**Architecture:** Business objects (Expense, SalesInvoice) are the source of fact (ADR-0006); each generates a balanced draft Voucher whose account + vat_code come from `CountryPlugin.resolveCategoryMapping` (ADR-0002), never hardcoded. The pipeline is AI-suggest → Rules validate (deterministic; structural/hard inviolable, semantic overridable) → Policy decide (configurable risk gate) → post (atomic, immutable) (ADR-0005). Schema lives only in migrations; every cross-module wiring is covered by a real-DI integration test on in-memory SQLite.

**Tech Stack:** NestJS, Kysely, better-sqlite3, Jest, TypeScript

---

## Wave 2 dependencies (assumed implemented)

This wave builds on Wave 2. The following are assumed to exist and are referenced verbatim:

- **Migrations** `002_create_account.ts`, `003_create_voucher.ts`, `004_create_voucher_line.ts`, all registered in `src/database/migrations/index.ts`. Wave 3 migrations therefore start at `005`.
- **Kysely `Database` interface** (`src/database/types.ts`) already has `account`, `voucher`, `voucher_line` tables. Wave 3 adds `expense`, `sales_invoice`, `policy_config`, `override`.
- **`AccountService`** (`src/ledger/account/account.service.ts`): `getAccountByCode(code: string): Promise<{ id: number; code: string; type: string } | undefined>`.
- **`LedgerValidationService`** (`src/ledger/validation/ledger-validation.service.ts`): `validateVoucherLines(lines: DraftVoucherLine[]): { isValid: boolean; errors: string[] }` — pure structural arithmetic (balance, account-id present, positive integer amounts, currency non-empty, base_amount ≈ amount×fx_rate).
- **`PostingService`** (`src/ledger/posting/posting.service.ts`): `postVoucher(draft: DraftVoucher): Promise<PostedVoucher>` — validates, then inserts voucher (`posted_at = now`) + lines inside one SQLite transaction.
- **Ledger types** (`src/ledger/voucher/types.ts`):
  ```ts
  export interface DraftVoucherLine {
    account_id: number;
    amount: number;        // cents, original currency
    currency: string;
    base_amount: number;   // cents, base currency
    fx_rate: number;
    vat_code: string | null;
    is_debit: boolean;
  }
  export interface DraftVoucher {
    voucher_number: string;
    tax_point_date: string;       // ISO date
    lines: DraftVoucherLine[];
    corrects_object_type?: string | null;
    corrects_object_id?: number | null;
  }
  export interface PostedVoucherLine extends DraftVoucherLine { id: number; voucher_id: number; }
  export interface PostedVoucher {
    id: number;
    voucher_number: string;
    tax_point_date: string;
    posted_at: number | null;
    lines: PostedVoucherLine[];
  }
  ```
- **`CurrencyService`** (`src/currency/currency.service.ts`): `getBaseCurrency(): Promise<string>` resolves the org override or plugin default (EUR for the seeded Irish org).
- **`PluginLoader`** (`src/plugins/plugin-loader.service.ts`): `resolve(country).resolveCategoryMapping(category, ctx): { account, vatCode }` and `validateVATCode(code, ctx): boolean`.

If any Wave 2 symbol differs from the above, adapt the call sites in this plan to the real signature before writing tests — do NOT change the test's *intent*.

---

## File Structure

### Migrations (schema only — G4)
- `src/database/migrations/005_create_expense.ts` — `expense` table + status CHECK constraint.
- `src/database/migrations/006_create_sales_invoice.ts` — `sales_invoice` table + UNIQUE `invoice_number` + status CHECK.
- `src/database/migrations/007_create_policy_config.ts` — `policy_config` singleton (`id = 1` CHECK) + seed defaults.
- `src/database/migrations/008_create_override.ts` — `override` table + FK to voucher.
- `src/database/migrations/index.ts` — **MODIFY**: register 005–008.
- `src/database/types.ts` — **MODIFY**: add `ExpenseTable`, `SalesInvoiceTable`, `PolicyConfigTable`, `OverrideTable` to `Database`.

### Expenses module (Task 11, 15)
- `src/expenses/types.ts` — `Expense`, `CreateExpenseDto`, `ExpenseStatus`.
- `src/expenses/expenses.service.ts` — CRUD + `generateDraft` + `postExpense` (pipeline).
- `src/expenses/expenses.controller.ts` — REST endpoints incl. `/generate-draft` and `/post`.
- `src/expenses/expenses.module.ts` — wires DB + plugins + ledger + rules + policy.
- `src/expenses/expenses.service.spec.ts` — real-DI integration tests.
- `src/expenses/expenses.controller.spec.ts` — controller tests.

### Sales invoices module (Task 12, 15)
- `src/sales-invoices/types.ts` — `SalesInvoice`, `CreateSalesInvoiceDto`, `SalesInvoiceStatus`.
- `src/sales-invoices/sales-invoices.service.ts` — CRUD + `generateDraft` + `send` + `postInvoice`.
- `src/sales-invoices/sales-invoices.controller.ts` — REST endpoints incl. `/generate-draft`, `/send`, `/post`.
- `src/sales-invoices/sales-invoices.module.ts` — module wiring.
- `src/sales-invoices/sales-invoices.service.spec.ts` — real-DI integration tests.
- `src/sales-invoices/sales-invoices.controller.spec.ts` — controller tests.

### Rules module (Task 13)
- `src/rules/types.ts` — `RuleType`, `RuleResult`, `OverrideInput`.
- `src/rules/rules.service.ts` — `validate(draft, type, override?)` over structural/hard/semantic.
- `src/rules/rules.module.ts` — wires LedgerValidation + plugins.
- `src/rules/rules.service.spec.ts` — real-DI integration tests for all three tiers + override.

### Policy & Override module (Task 14)
- `src/policy/types.ts` — `PolicyDecision`, `PolicyConfig`, `OverrideRecord`, `CreateOverrideDto`.
- `src/policy/policy.service.ts` — `decide(draft, ruleResults)` against config thresholds.
- `src/policy/override.service.ts` — logs/lists overrides (semantic only).
- `src/policy/override.controller.ts` — `POST /api/overrides`, `GET /api/overrides`.
- `src/policy/policy.module.ts` — module wiring.
- `src/policy/policy.service.spec.ts` — real-DI integration tests.
- `src/policy/override.controller.spec.ts` — override logging tests.

### App wiring & e2e
- `src/app.module.ts` — **MODIFY**: import `ExpensesModule`, `SalesInvoicesModule`, `RulesModule`, `PolicyModule`.
- `test/pipeline.e2e-spec.ts` — full pipeline e2e (auto-post / hold / reject paths).

---

## Conventions used by every task

- **Money is integer cents.** All `*_amount` columns are `integer`.
- **Timestamps** are unix seconds: `Math.floor(Date.now() / 1000)`.
- **Status enums** are enforced as DB `CHECK` constraints (G6), not just TypeScript unions.
- **Currency is never hardcoded.** Where a draft line needs base currency, resolve via `CurrencyService.getBaseCurrency()`. Example payloads use `"currency":"EUR"` because the seeded org is Ireland; v1 assumes line currency == base currency, so `base_amount = amount`, `fx_rate = 1` (multi-currency on a business object is out of Wave 3 scope).
- **Accounts/vat_code on a draft come from the plugin** (`resolveCategoryMapping`), except the canonical counter-accounts the kernel owns by name (CASH, AR, VAT_PAYABLE, REVENUE) which are looked up by code via `AccountService.getAccountByCode`.
- **Final commit per task is gated by G1:** `npm run build && npm run lint && npm run test && npm run test:e2e` must all be green before committing.
- Run a single new spec with: `npx jest <path-to-spec>`. Run a single e2e with: `npx jest --config ./test/jest-e2e.json <path>`.

---

## Task 11 — Expense business object + draft voucher generation

**Files:**
- Create: `src/database/migrations/005_create_expense.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`, `src/app.module.ts`
- Create: `src/expenses/types.ts`, `src/expenses/expenses.service.ts`, `src/expenses/expenses.controller.ts`, `src/expenses/expenses.module.ts`
- Test: `src/expenses/expenses.service.spec.ts`, `src/expenses/expenses.controller.spec.ts`

Honors **Must NOT do**: never auto-posts (only draft); `supplier_id` and `document_id` are nullable and unused (no matching/attachment).

### Steps

- [ ] **Write the migration (schema only — G4, G6).** Create `src/database/migrations/005_create_expense.ts`:
  ```ts
  import { Kysely, sql } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('expense')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('document_id', 'integer')
      .addColumn('supplier_id', 'integer')
      .addColumn('category', 'text', (col) => col.notNull())
      .addColumn('gross_amount', 'integer', (col) => col.notNull())
      .addColumn('vat_amount', 'integer', (col) => col.notNull())
      .addColumn('currency', 'text', (col) => col.notNull())
      .addColumn('tax_point_date', 'text', (col) => col.notNull())
      // status enum is a real DB CHECK constraint (G6), not just a TS union.
      .addColumn('status', 'text', (col) =>
        col
          .notNull()
          .defaultTo('draft')
          .check(sql`status IN ('draft','pending','posted','reversed')`),
      )
      .addColumn('voucher_id', 'integer', (col) =>
        col.references('voucher.id'),
      )
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .addColumn('updated_at', 'integer', (col) => col.notNull())
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('expense').ifExists().execute();
  }
  ```

- [ ] **Register the migration.** In `src/database/migrations/index.ts` add the import and map entry:
  ```ts
  import * as m005 from './005_create_expense';
  // ...
  '005_create_expense': m005,
  ```

- [ ] **Add the Kysely table type.** In `src/database/types.ts` add to `Database`:
  ```ts
  expense: ExpenseTable;
  ```
  and append:
  ```ts
  export interface ExpenseTable {
    id: Generated<number>;
    document_id: number | null;
    supplier_id: number | null;
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    status: string;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }
  ```

- [ ] **Write the FULL failing integration test** `src/expenses/expenses.service.spec.ts` (real DI + in-memory SQLite, copying the `currency.resolution.spec.ts` harness). Note: AC tested with a NON-default category `transport` and NON-default amount `33000`/`6000` (G3), so a hardcoded `software`→`EXPENSE_SOFTWARE` stub cannot pass by coincidence:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { OrganizationService } from '../organization/organization.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { CurrencyService } from '../currency/currency.service';
  import { AccountService } from '../ledger/account/account.service';
  import { ExpensesService } from './expenses.service';

  describe('ExpensesService (integration)', () => {
    let db: Kysely<Database>;
    let expenses: ExpensesService;

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          OrganizationService,
          NullCountryPlugin,
          PluginLoader,
          CurrencyService,
          AccountService,
          ExpensesService,
        ],
      }).compile();

      expenses = module.get(ExpensesService);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('creates an expense in draft status', async () => {
      const e = await expenses.create({
        category: 'transport',
        gross_amount: 33000,
        vat_amount: 6000,
        currency: 'EUR',
        tax_point_date: '2024-03-10',
      });
      expect(e.id).toBeGreaterThan(0);
      expect(e.status).toBe('draft');
      expect(e.voucher_id).toBeNull();
    });

    it('generates a balanced draft voucher: Dr plugin-resolved expense account, Cr CASH, not posted', async () => {
      const e = await expenses.create({
        category: 'transport',
        gross_amount: 33000,
        vat_amount: 6000,
        currency: 'EUR',
        tax_point_date: '2024-03-10',
      });
      const draft = await expenses.generateDraft(e.id);

      // Plugin resolves category -> account (NullCountryPlugin: EXPENSE_TRANSPORT).
      const debit = draft.lines.find((l) => l.is_debit);
      const credit = draft.lines.find((l) => !l.is_debit);
      const expenseAccount = await db
        .selectFrom('account').selectAll()
        .where('code', '=', 'EXPENSE_TRANSPORT').executeTakeFirstOrThrow();
      const cashAccount = await db
        .selectFrom('account').selectAll()
        .where('code', '=', 'CASH').executeTakeFirstOrThrow();

      expect(draft.lines).toHaveLength(2);
      expect(debit!.account_id).toBe(expenseAccount.id);
      expect(debit!.amount).toBe(33000);
      expect(debit!.vat_code).toBe('NULL_STANDARD'); // from plugin, never hardcoded
      expect(credit!.account_id).toBe(cashAccount.id);
      expect(credit!.amount).toBe(33000);
      // base currency resolved via CurrencyService -> EUR for the Irish org.
      expect(debit!.currency).toBe('EUR');
      expect(debit!.base_amount).toBe(33000);
      // Draft only: nothing posted.
      expect(draft.posted_at ?? null).toBeNull();
    });

    it('rejects generate-draft for a missing expense', async () => {
      await expect(expenses.generateDraft(999)).rejects.toThrow();
    });
  });
  ```

- [ ] **Run the test — expect FAIL** (module not implemented): `npx jest src/expenses/expenses.service.spec.ts` → expected `Cannot find module './expenses.service'`.

- [ ] **Write the types** `src/expenses/types.ts`:
  ```ts
  import { DraftVoucher } from '../ledger/voucher/types';

  export type ExpenseStatus = 'draft' | 'pending' | 'posted' | 'reversed';

  export interface Expense {
    id: number;
    document_id: number | null;
    supplier_id: number | null;
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    status: ExpenseStatus;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }

  export interface CreateExpenseDto {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    document_id?: number | null;
    supplier_id?: number | null;
  }

  // A draft voucher annotated with posted_at for symmetry with PostedVoucher.
  export type ExpenseDraftVoucher = DraftVoucher & { posted_at: number | null };
  ```

- [ ] **Write the minimal service** `src/expenses/expenses.service.ts`. Draft generation resolves the expense account + vat_code from the plugin and the CASH counter-account by code; base currency comes from `CurrencyService` (never hardcoded):
  ```ts
  import { Injectable, NotFoundException } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { CurrencyService } from '../currency/currency.service';
  import { AccountService } from '../ledger/account/account.service';
  import { DraftVoucherLine } from '../ledger/voucher/types';
  import { CreateExpenseDto, Expense, ExpenseDraftVoucher, ExpenseStatus } from './types';

  @Injectable()
  export class ExpensesService {
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly organization: OrganizationService,
      private readonly pluginLoader: PluginLoader,
      private readonly currency: CurrencyService,
      private readonly accounts: AccountService,
    ) {}

    async create(dto: CreateExpenseDto): Promise<Expense> {
      const now = Math.floor(Date.now() / 1000);
      const row = await this.db
        .insertInto('expense')
        .values({
          document_id: dto.document_id ?? null,
          supplier_id: dto.supplier_id ?? null,
          category: dto.category,
          gross_amount: dto.gross_amount,
          vat_amount: dto.vat_amount,
          currency: dto.currency,
          tax_point_date: dto.tax_point_date,
          status: 'draft',
          voucher_id: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.mapRow(row);
    }

    async list(): Promise<Expense[]> {
      const rows = await this.db.selectFrom('expense').selectAll().execute();
      return rows.map((r) => this.mapRow(r));
    }

    async getById(id: number): Promise<Expense> {
      const row = await this.db
        .selectFrom('expense').selectAll().where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundException(`Expense ${id} not found`);
      return this.mapRow(row);
    }

    /**
     * Generates a balanced DRAFT voucher from the expense. NEVER posts.
     * Dr <plugin-resolved expense account>, Cr CASH (v1 assumes cash payment).
     */
    async generateDraft(id: number): Promise<ExpenseDraftVoucher> {
      const expense = await this.getById(id);
      const org = await this.organization.getOrganization();
      const base = await this.currency.getBaseCurrency();

      const mapping = this.pluginLoader
        .resolve(org.country)
        .resolveCategoryMapping(expense.category, { supplier_id: expense.supplier_id });

      const expenseAccount = await this.accounts.getAccountByCode(mapping.account);
      if (!expenseAccount)
        throw new NotFoundException(`Account ${mapping.account} not found`);
      const cashAccount = await this.accounts.getAccountByCode('CASH');
      if (!cashAccount) throw new NotFoundException('Account CASH not found');

      const lines: DraftVoucherLine[] = [
        {
          account_id: expenseAccount.id,
          amount: expense.gross_amount,
          currency: base,
          base_amount: expense.gross_amount, // v1: line currency == base currency
          fx_rate: 1,
          vat_code: mapping.vatCode,
          is_debit: true,
        },
        {
          account_id: cashAccount.id,
          amount: expense.gross_amount,
          currency: base,
          base_amount: expense.gross_amount,
          fx_rate: 1,
          vat_code: null,
          is_debit: false,
        },
      ];

      return {
        voucher_number: `EXP-${expense.id}`,
        tax_point_date: expense.tax_point_date,
        lines,
        posted_at: null,
      };
    }

    async setStatus(id: number, status: ExpenseStatus, voucherId: number | null): Promise<Expense> {
      await this.db
        .updateTable('expense')
        .set({ status, voucher_id: voucherId, updated_at: Math.floor(Date.now() / 1000) })
        .where('id', '=', id)
        .execute();
      return this.getById(id);
    }

    private mapRow(row: {
      id: number; document_id: number | null; supplier_id: number | null;
      category: string; gross_amount: number; vat_amount: number; currency: string;
      tax_point_date: string; status: string; voucher_id: number | null;
      created_at: number; updated_at: number;
    }): Expense {
      return { ...row, status: row.status as ExpenseStatus };
    }
  }
  ```

- [ ] **Write the controller** `src/expenses/expenses.controller.ts` (the `/post` pipeline endpoint is added in Task 15; here only CRUD + generate-draft):
  ```ts
  import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
  import { ExpensesService } from './expenses.service';
  import { CreateExpenseDto, Expense, ExpenseDraftVoucher } from './types';

  @Controller('api/expenses')
  export class ExpensesController {
    constructor(private readonly expenses: ExpensesService) {}

    @Post()
    async create(@Body() dto: CreateExpenseDto): Promise<Expense> {
      return this.expenses.create(dto);
    }

    @Get()
    async list(): Promise<Expense[]> {
      return this.expenses.list();
    }

    @Get(':id')
    async getOne(@Param('id', ParseIntPipe) id: number): Promise<Expense> {
      return this.expenses.getById(id);
    }

    @Post(':id/generate-draft')
    async generateDraft(
      @Param('id', ParseIntPipe) id: number,
    ): Promise<ExpenseDraftVoucher> {
      return this.expenses.generateDraft(id);
    }
  }
  ```

- [ ] **Write the module** `src/expenses/expenses.module.ts` (imports the ledger/plugin/currency providers it depends on). Replace `LedgerModule` with the actual Wave 2 module name(s) that export `AccountService`, `PostingService`, `LedgerValidationService`:
  ```ts
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { OrganizationModule } from '../organization/organization.module';
  import { PluginsModule } from '../plugins/plugins.module';
  import { CurrencyModule } from '../currency/currency.module';
  import { LedgerModule } from '../ledger/ledger.module';
  import { RulesModule } from '../rules/rules.module';
  import { PolicyModule } from '../policy/policy.module';
  import { ExpensesService } from './expenses.service';
  import { ExpensesController } from './expenses.controller';

  @Module({
    imports: [
      DatabaseModule,
      OrganizationModule,
      PluginsModule,
      CurrencyModule,
      LedgerModule,
      RulesModule,
      PolicyModule,
    ],
    controllers: [ExpensesController],
    providers: [ExpensesService],
    exports: [ExpensesService],
  })
  export class ExpensesModule {}
  ```
  > Note: `RulesModule`/`PolicyModule` are only *used* in Task 15. Importing them now is harmless and avoids a second edit; if they don't exist yet when implementing Task 11 first, omit those two imports until Task 15.

- [ ] **Write the controller spec** `src/expenses/expenses.controller.spec.ts` (thin — service mocked; integration coverage lives in the service spec, satisfying G2):
  ```ts
  import { Test } from '@nestjs/testing';
  import { ExpensesController } from './expenses.controller';
  import { ExpensesService } from './expenses.service';

  describe('ExpensesController', () => {
    let controller: ExpensesController;
    const service = {
      create: jest.fn().mockResolvedValue({ id: 1, status: 'draft', voucher_id: null }),
      generateDraft: jest.fn().mockResolvedValue({ voucher_number: 'EXP-1', lines: [], posted_at: null }),
    };

    beforeEach(async () => {
      const mod = await Test.createTestingModule({
        controllers: [ExpensesController],
        providers: [{ provide: ExpensesService, useValue: service }],
      }).compile();
      controller = mod.get(ExpensesController);
    });

    it('creates a draft expense', async () => {
      const e = await controller.create({
        category: 'transport', gross_amount: 33000, vat_amount: 6000,
        currency: 'EUR', tax_point_date: '2024-03-10',
      });
      expect(e.status).toBe('draft');
    });

    it('returns an unposted draft voucher', async () => {
      const v = await controller.generateDraft(1);
      expect(v.posted_at).toBeNull();
    });
  });
  ```

- [ ] **Register the module** in `src/app.module.ts` imports: add `ExpensesModule`.

- [ ] **Run the tests — expect PASS:** `npx jest src/expenses/`.

- [ ] **Run the wave gate (G1) — expect all green:** `npm run build && npm run lint && npm run test && npm run test:e2e`.

- [ ] **Commit:**
  ```bash
  git add src/expenses src/database/migrations/005_create_expense.ts src/database/migrations/index.ts src/database/types.ts src/app.module.ts
  git commit -m "feat(expenses): expense business object + draft voucher generation"
  ```

---

## Task 12 — SalesInvoice business object + draft voucher generation

**Files:**
- Create: `src/database/migrations/006_create_sales_invoice.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`, `src/app.module.ts`
- Create: `src/sales-invoices/types.ts`, `src/sales-invoices/sales-invoices.service.ts`, `src/sales-invoices/sales-invoices.controller.ts`, `src/sales-invoices/sales-invoices.module.ts`
- Test: `src/sales-invoices/sales-invoices.service.spec.ts`, `src/sales-invoices/sales-invoices.controller.spec.ts`

Honors **Must NOT do**: never auto-posts; `/send` is a status change only (no email); `customer_id` nullable, no matching.

### Steps

- [ ] **Write the migration (G4, G6).** `src/database/migrations/006_create_sales_invoice.ts` — `invoice_number` is a real `UNIQUE` constraint (G6); status CHECK includes `sent`:
  ```ts
  import { Kysely, sql } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('sales_invoice')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('customer_id', 'integer')
      .addColumn('invoice_number', 'text', (col) => col.notNull().unique())
      .addColumn('gross_amount', 'integer', (col) => col.notNull())
      .addColumn('vat_amount', 'integer', (col) => col.notNull())
      .addColumn('currency', 'text', (col) => col.notNull())
      .addColumn('tax_point_date', 'text', (col) => col.notNull())
      .addColumn('due_date', 'text')
      .addColumn('status', 'text', (col) =>
        col
          .notNull()
          .defaultTo('draft')
          .check(sql`status IN ('draft','pending','posted','reversed','sent')`),
      )
      .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .addColumn('updated_at', 'integer', (col) => col.notNull())
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('sales_invoice').ifExists().execute();
  }
  ```

- [ ] **Register the migration** in `src/database/migrations/index.ts`:
  ```ts
  import * as m006 from './006_create_sales_invoice';
  '006_create_sales_invoice': m006,
  ```

- [ ] **Add the Kysely table type** to `src/database/types.ts` (`sales_invoice: SalesInvoiceTable;` on `Database`, plus):
  ```ts
  export interface SalesInvoiceTable {
    id: Generated<number>;
    customer_id: number | null;
    invoice_number: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    due_date: string | null;
    status: string;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }
  ```

- [ ] **Write the FULL failing integration test** `src/sales-invoices/sales-invoices.service.spec.ts`. AC tested with NON-default amounts (`gross 24600`, `vat 4600` → revenue 20000) (G3) and proves the UNIQUE constraint is a real DB constraint (G6):
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { OrganizationService } from '../organization/organization.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { CurrencyService } from '../currency/currency.service';
  import { AccountService } from '../ledger/account/account.service';
  import { SalesInvoicesService } from './sales-invoices.service';

  describe('SalesInvoicesService (integration)', () => {
    let db: Kysely<Database>;
    let invoices: SalesInvoicesService;

    beforeEach(async () => {
      db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const migrator = new Migrator({
        db, provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          OrganizationService, NullCountryPlugin, PluginLoader,
          CurrencyService, AccountService, SalesInvoicesService,
        ],
      }).compile();
      invoices = module.get(SalesInvoicesService);
    });

    afterEach(async () => { await db.destroy(); });

    it('creates an invoice in draft status', async () => {
      const inv = await invoices.create({
        invoice_number: 'INV-2024-009', gross_amount: 24600, vat_amount: 4600,
        currency: 'EUR', tax_point_date: '2024-04-01', due_date: '2024-05-01',
      });
      expect(inv.status).toBe('draft');
      expect(inv.voucher_id).toBeNull();
    });

    it('generates a 3-line balanced draft: Dr AR, Cr REVENUE, Cr VAT_PAYABLE', async () => {
      const inv = await invoices.create({
        invoice_number: 'INV-2024-009', gross_amount: 24600, vat_amount: 4600,
        currency: 'EUR', tax_point_date: '2024-04-01',
      });
      const draft = await invoices.generateDraft(inv.id);

      const ar = await db.selectFrom('account').selectAll().where('code', '=', 'AR').executeTakeFirstOrThrow();
      const rev = await db.selectFrom('account').selectAll().where('code', '=', 'REVENUE').executeTakeFirstOrThrow();
      const vat = await db.selectFrom('account').selectAll().where('code', '=', 'VAT_PAYABLE').executeTakeFirstOrThrow();

      expect(draft.lines).toHaveLength(3);
      const drAR = draft.lines.find((l) => l.is_debit)!;
      expect(drAR.account_id).toBe(ar.id);
      expect(drAR.amount).toBe(24600);
      const crRev = draft.lines.find((l) => !l.is_debit && l.account_id === rev.id)!;
      expect(crRev.amount).toBe(20000); // gross - vat
      const crVat = draft.lines.find((l) => !l.is_debit && l.account_id === vat.id)!;
      expect(crVat.amount).toBe(4600);
      // balances: 24600 debit == 20000 + 4600 credit
      const dr = draft.lines.filter((l) => l.is_debit).reduce((s, l) => s + l.base_amount, 0);
      const cr = draft.lines.filter((l) => !l.is_debit).reduce((s, l) => s + l.base_amount, 0);
      expect(dr).toBe(cr);
    });

    it('send() changes status to sent', async () => {
      const inv = await invoices.create({
        invoice_number: 'INV-2024-009', gross_amount: 24600, vat_amount: 4600,
        currency: 'EUR', tax_point_date: '2024-04-01',
      });
      const sent = await invoices.send(inv.id);
      expect(sent.status).toBe('sent');
    });

    it('enforces UNIQUE invoice_number at the DB level (G6)', async () => {
      await invoices.create({
        invoice_number: 'INV-DUP', gross_amount: 100, vat_amount: 0,
        currency: 'EUR', tax_point_date: '2024-04-01',
      });
      await expect(
        invoices.create({
          invoice_number: 'INV-DUP', gross_amount: 200, vat_amount: 0,
          currency: 'EUR', tax_point_date: '2024-04-02',
        }),
      ).rejects.toThrow();
    });
  });
  ```

- [ ] **Run the test — expect FAIL:** `npx jest src/sales-invoices/sales-invoices.service.spec.ts` → `Cannot find module './sales-invoices.service'`.

- [ ] **Write the types** `src/sales-invoices/types.ts`:
  ```ts
  import { DraftVoucher } from '../ledger/voucher/types';

  export type SalesInvoiceStatus = 'draft' | 'pending' | 'posted' | 'reversed' | 'sent';

  export interface SalesInvoice {
    id: number;
    customer_id: number | null;
    invoice_number: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    due_date: string | null;
    status: SalesInvoiceStatus;
    voucher_id: number | null;
    created_at: number;
    updated_at: number;
  }

  export interface CreateSalesInvoiceDto {
    invoice_number: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    due_date?: string | null;
    customer_id?: number | null;
  }

  export type SalesInvoiceDraftVoucher = DraftVoucher & { posted_at: number | null };
  ```

- [ ] **Write the service** `src/sales-invoices/sales-invoices.service.ts`. Draft: Dr AR (gross), Cr REVENUE (gross−vat), Cr VAT_PAYABLE (vat). VAT code on the revenue line comes from the plugin (`resolveCategoryMapping('revenue', …).vatCode`), per ADR-0002; counter-accounts looked up by code; base currency via `CurrencyService`:
  ```ts
  import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { CurrencyService } from '../currency/currency.service';
  import { AccountService } from '../ledger/account/account.service';
  import { DraftVoucherLine } from '../ledger/voucher/types';
  import {
    CreateSalesInvoiceDto, SalesInvoice, SalesInvoiceDraftVoucher, SalesInvoiceStatus,
  } from './types';

  @Injectable()
  export class SalesInvoicesService {
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly organization: OrganizationService,
      private readonly pluginLoader: PluginLoader,
      private readonly currency: CurrencyService,
      private readonly accounts: AccountService,
    ) {}

    async create(dto: CreateSalesInvoiceDto): Promise<SalesInvoice> {
      const now = Math.floor(Date.now() / 1000);
      try {
        const row = await this.db
          .insertInto('sales_invoice')
          .values({
            customer_id: dto.customer_id ?? null,
            invoice_number: dto.invoice_number,
            gross_amount: dto.gross_amount,
            vat_amount: dto.vat_amount,
            currency: dto.currency,
            tax_point_date: dto.tax_point_date,
            due_date: dto.due_date ?? null,
            status: 'draft',
            voucher_id: null,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return this.mapRow(row);
      } catch (err) {
        // Surface the real DB UNIQUE violation as a 409 (constraint is the
        // source of truth — G6).
        if (err instanceof Error && /UNIQUE/i.test(err.message)) {
          throw new ConflictException(
            `Invoice number ${dto.invoice_number} already exists`,
          );
        }
        throw err;
      }
    }

    async list(): Promise<SalesInvoice[]> {
      const rows = await this.db.selectFrom('sales_invoice').selectAll().execute();
      return rows.map((r) => this.mapRow(r));
    }

    async getById(id: number): Promise<SalesInvoice> {
      const row = await this.db
        .selectFrom('sales_invoice').selectAll().where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundException(`SalesInvoice ${id} not found`);
      return this.mapRow(row);
    }

    /** Generates a balanced DRAFT voucher: Dr AR / Cr REVENUE / Cr VAT_PAYABLE. NEVER posts. */
    async generateDraft(id: number): Promise<SalesInvoiceDraftVoucher> {
      const inv = await this.getById(id);
      const org = await this.organization.getOrganization();
      const base = await this.currency.getBaseCurrency();
      const revenueVatCode = this.pluginLoader
        .resolve(org.country)
        .resolveCategoryMapping('revenue', { customer_id: inv.customer_id }).vatCode;

      const ar = await this.accounts.getAccountByCode('AR');
      const revenue = await this.accounts.getAccountByCode('REVENUE');
      const vatPayable = await this.accounts.getAccountByCode('VAT_PAYABLE');
      if (!ar || !revenue || !vatPayable)
        throw new NotFoundException('Required canonical account missing (AR/REVENUE/VAT_PAYABLE)');

      const net = inv.gross_amount - inv.vat_amount;
      const lines: DraftVoucherLine[] = [
        { account_id: ar.id, amount: inv.gross_amount, currency: base, base_amount: inv.gross_amount, fx_rate: 1, vat_code: null, is_debit: true },
        { account_id: revenue.id, amount: net, currency: base, base_amount: net, fx_rate: 1, vat_code: revenueVatCode, is_debit: false },
        { account_id: vatPayable.id, amount: inv.vat_amount, currency: base, base_amount: inv.vat_amount, fx_rate: 1, vat_code: revenueVatCode, is_debit: false },
      ];

      return {
        voucher_number: `SI-${inv.id}`,
        tax_point_date: inv.tax_point_date,
        lines,
        posted_at: null,
      };
    }

    /** Status change only — no real email is sent (Must NOT do). */
    async send(id: number): Promise<SalesInvoice> {
      await this.getById(id);
      return this.setStatus(id, 'sent', null);
    }

    async setStatus(id: number, status: SalesInvoiceStatus, voucherId: number | null): Promise<SalesInvoice> {
      const current = await this.getById(id);
      await this.db
        .updateTable('sales_invoice')
        .set({
          status,
          voucher_id: voucherId ?? current.voucher_id,
          updated_at: Math.floor(Date.now() / 1000),
        })
        .where('id', '=', id)
        .execute();
      return this.getById(id);
    }

    private mapRow(row: {
      id: number; customer_id: number | null; invoice_number: string;
      gross_amount: number; vat_amount: number; currency: string;
      tax_point_date: string; due_date: string | null; status: string;
      voucher_id: number | null; created_at: number; updated_at: number;
    }): SalesInvoice {
      return { ...row, status: row.status as SalesInvoiceStatus };
    }
  }
  ```
  > Assumes `NullCountryPlugin.resolveCategoryMapping('revenue', …)` returns a valid vat code. If the Wave 2 null plugin only maps expense categories, add a `'revenue'` branch to the null plugin returning `{ account: 'REVENUE', vatCode: 'NULL_STANDARD' }` (a one-line plugin extension, NOT new schema) — note this in the PR.

- [ ] **Write the controller** `src/sales-invoices/sales-invoices.controller.ts` (the `/post` endpoint is added in Task 15):
  ```ts
  import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
  import { SalesInvoicesService } from './sales-invoices.service';
  import { CreateSalesInvoiceDto, SalesInvoice, SalesInvoiceDraftVoucher } from './types';

  @Controller('api/sales-invoices')
  export class SalesInvoicesController {
    constructor(private readonly invoices: SalesInvoicesService) {}

    @Post()
    async create(@Body() dto: CreateSalesInvoiceDto): Promise<SalesInvoice> {
      return this.invoices.create(dto);
    }

    @Get()
    async list(): Promise<SalesInvoice[]> {
      return this.invoices.list();
    }

    @Get(':id')
    async getOne(@Param('id', ParseIntPipe) id: number): Promise<SalesInvoice> {
      return this.invoices.getById(id);
    }

    @Post(':id/generate-draft')
    async generateDraft(
      @Param('id', ParseIntPipe) id: number,
    ): Promise<SalesInvoiceDraftVoucher> {
      return this.invoices.generateDraft(id);
    }

    @Post(':id/send')
    async send(@Param('id', ParseIntPipe) id: number): Promise<SalesInvoice> {
      return this.invoices.send(id);
    }
  }
  ```

- [ ] **Write the module** `src/sales-invoices/sales-invoices.module.ts` (mirror `ExpensesModule`, swap the service/controller names).

- [ ] **Write the controller spec** `src/sales-invoices/sales-invoices.controller.spec.ts` (thin, service mocked):
  ```ts
  import { Test } from '@nestjs/testing';
  import { SalesInvoicesController } from './sales-invoices.controller';
  import { SalesInvoicesService } from './sales-invoices.service';

  describe('SalesInvoicesController', () => {
    let controller: SalesInvoicesController;
    const service = {
      create: jest.fn().mockResolvedValue({ id: 1, status: 'draft' }),
      generateDraft: jest.fn().mockResolvedValue({ voucher_number: 'SI-1', lines: [1, 2, 3], posted_at: null }),
      send: jest.fn().mockResolvedValue({ id: 1, status: 'sent' }),
    };

    beforeEach(async () => {
      const mod = await Test.createTestingModule({
        controllers: [SalesInvoicesController],
        providers: [{ provide: SalesInvoicesService, useValue: service }],
      }).compile();
      controller = mod.get(SalesInvoicesController);
    });

    it('creates a draft invoice', async () => {
      const inv = await controller.create({
        invoice_number: 'INV-2024-009', gross_amount: 24600, vat_amount: 4600,
        currency: 'EUR', tax_point_date: '2024-04-01',
      });
      expect(inv.status).toBe('draft');
    });

    it('send() returns status sent', async () => {
      const inv = await controller.send(1);
      expect(inv.status).toBe('sent');
    });
  });
  ```

- [ ] **Register the module** in `src/app.module.ts`: add `SalesInvoicesModule`.

- [ ] **Run the tests — expect PASS:** `npx jest src/sales-invoices/`.

- [ ] **Run the wave gate (G1) — expect all green:** `npm run build && npm run lint && npm run test && npm run test:e2e`.

- [ ] **Commit:**
  ```bash
  git add src/sales-invoices src/database/migrations/006_create_sales_invoice.ts src/database/migrations/index.ts src/database/types.ts src/app.module.ts
  git commit -m "feat(sales-invoices): sales invoice business object + draft generation"
  ```

---

## Task 13 — Rules engine (structural, hard, semantic)

**Files:**
- Create: `src/rules/types.ts`, `src/rules/rules.service.ts`, `src/rules/rules.module.ts`
- Test: `src/rules/rules.service.spec.ts`

Honors **Must NOT do**: structural/hard rules are NEVER overrideable (enforced in code); period-lock is a stub that always passes (Wave 6); deductibility uses the plugin's safe defaults — no real logic.

### Steps

- [ ] **Write the types** `src/rules/types.ts`:
  ```ts
  import { DraftVoucher } from '../ledger/voucher/types';

  export type RuleType = 'structural' | 'hard' | 'semantic';

  export interface RuleResult {
    passed: boolean;
    ruleType: RuleType;
    message: string;
    overrideable: boolean;
  }

  // A human-authored Override applies ONLY to a failed semantic rule.
  export interface OverrideInput {
    ruleType: RuleType;
    reason: string;
  }

  export type RulesDraft = DraftVoucher;
  ```

- [ ] **Write the FULL failing integration test** `src/rules/rules.service.spec.ts` (real DI + in-memory SQLite so the semantic VAT-code check goes through the real `PluginLoader`, satisfying G2). Covers all six ACs incl. the override-cannot-touch-structural invariant:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { OrganizationService } from '../organization/organization.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
  import { RulesService } from './rules.service';
  import { DraftVoucher } from '../ledger/voucher/types';

  const balanced = (vatCode: string | null): DraftVoucher => ({
    voucher_number: 'T-1',
    tax_point_date: '2024-03-10',
    lines: [
      { account_id: 1, amount: 33000, currency: 'EUR', base_amount: 33000, fx_rate: 1, vat_code: vatCode, is_debit: true },
      { account_id: 2, amount: 33000, currency: 'EUR', base_amount: 33000, fx_rate: 1, vat_code: null, is_debit: false },
    ],
  });

  const unbalanced = (): DraftVoucher => ({
    voucher_number: 'T-2',
    tax_point_date: '2024-03-10',
    lines: [
      { account_id: 1, amount: 33000, currency: 'EUR', base_amount: 33000, fx_rate: 1, vat_code: null, is_debit: true },
      { account_id: 2, amount: 32000, currency: 'EUR', base_amount: 32000, fx_rate: 1, vat_code: null, is_debit: false },
    ],
  });

  describe('RulesService (integration)', () => {
    let db: Kysely<Database>;
    let rules: RulesService;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          OrganizationService, NullCountryPlugin, PluginLoader,
          LedgerValidationService, RulesService,
        ],
      }).compile();
      rules = module.get(RulesService);
    });

    afterEach(async () => { await db.destroy(); });

    it('structural failure (unbalanced) => passed:false, overrideable:false', async () => {
      const r = await rules.validate(unbalanced(), 'structural');
      expect(r.passed).toBe(false);
      expect(r.overrideable).toBe(false);
    });

    it('structural pass (balanced) => passed:true', async () => {
      const r = await rules.validate(balanced('NULL_STANDARD'), 'structural');
      expect(r.passed).toBe(true);
    });

    it('hard rule (period lock stub) always passes for now, never overrideable', async () => {
      const r = await rules.validate(balanced('NULL_STANDARD'), 'hard');
      expect(r.passed).toBe(true);
      expect(r.overrideable).toBe(false);
    });

    it('semantic failure (invalid VAT code) => passed:false, overrideable:true', async () => {
      const r = await rules.validate(balanced('BOGUS_VAT'), 'semantic');
      expect(r.passed).toBe(false);
      expect(r.overrideable).toBe(true);
    });

    it('semantic + override with reason => passed:true', async () => {
      const r = await rules.validate(balanced('BOGUS_VAT'), 'semantic', {
        ruleType: 'semantic',
        reason: 'Migration from legacy system',
      });
      expect(r.passed).toBe(true);
    });

    it('override attempt on a structural rule is ignored => still passed:false', async () => {
      const r = await rules.validate(unbalanced(), 'structural', {
        ruleType: 'structural',
        reason: 'please let me through',
      });
      expect(r.passed).toBe(false);
      expect(r.overrideable).toBe(false);
    });
  });
  ```

- [ ] **Run the test — expect FAIL:** `npx jest src/rules/rules.service.spec.ts` → `Cannot find module './rules.service'`.

- [ ] **Write the minimal service** `src/rules/rules.service.ts`. Structural delegates to the Wave 2 `LedgerValidationService` (arithmetic); hard is a stubbed always-pass period-lock; semantic checks every line's VAT code via the plugin and is the ONLY tier that honors an Override:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
  import { DraftVoucher } from '../ledger/voucher/types';
  import { OverrideInput, RuleResult, RuleType } from './types';

  @Injectable()
  export class RulesService {
    constructor(
      private readonly organization: OrganizationService,
      private readonly pluginLoader: PluginLoader,
      private readonly validation: LedgerValidationService,
    ) {}

    async validate(
      draft: DraftVoucher,
      type: RuleType,
      override?: OverrideInput,
    ): Promise<RuleResult> {
      switch (type) {
        case 'structural':
          return this.structural(draft);
        case 'hard':
          return this.hard(draft);
        case 'semantic':
          return this.semantic(draft, override);
      }
    }

    // Structural invariants are pure arithmetic and NEVER overrideable (ADR-0012).
    private structural(draft: DraftVoucher): RuleResult {
      const result = this.validation.validateVoucherLines(draft.lines);
      return {
        passed: result.isValid,
        ruleType: 'structural',
        message: result.isValid ? 'Structural invariants hold' : result.errors.join('; '),
        overrideable: false,
      };
    }

    // Hard process rule: the period containing tax_point_date must not be locked.
    // Period locking lands in Wave 6 — stub always passes, never overrideable.
    private hard(_draft: DraftVoucher): RuleResult {
      return {
        passed: true,
        ruleType: 'hard',
        message: 'Period lock check stubbed (Wave 6); not locked',
        overrideable: false,
      };
    }

    // Semantic rules are country-plugin owned and overridable via a logged Override.
    private async semantic(draft: DraftVoucher, override?: OverrideInput): Promise<RuleResult> {
      const org = await this.organization.getOrganization();
      const plugin = this.pluginLoader.resolve(org.country);

      const invalid = draft.lines
        .filter((l) => l.vat_code != null)
        .filter((l) => !plugin.validateVATCode(l.vat_code as string, { line: l }));

      if (invalid.length === 0) {
        return { passed: true, ruleType: 'semantic', message: 'Semantic rules hold', overrideable: true };
      }

      // A valid Override (semantic only, with a reason) lets the draft pass.
      if (override && override.ruleType === 'semantic' && override.reason.trim().length > 0) {
        return {
          passed: true,
          ruleType: 'semantic',
          message: `Semantic rule overridden: ${override.reason}`,
          overrideable: true,
        };
      }

      const codes = invalid.map((l) => l.vat_code).join(', ');
      return {
        passed: false,
        ruleType: 'semantic',
        message: `Invalid VAT code(s): ${codes}`,
        overrideable: true,
      };
    }
  }
  ```

- [ ] **Write the module** `src/rules/rules.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { OrganizationModule } from '../organization/organization.module';
  import { PluginsModule } from '../plugins/plugins.module';
  import { LedgerModule } from '../ledger/ledger.module';
  import { RulesService } from './rules.service';

  @Module({
    imports: [OrganizationModule, PluginsModule, LedgerModule],
    providers: [RulesService],
    exports: [RulesService],
  })
  export class RulesModule {}
  ```
  > `LedgerModule` must export `LedgerValidationService`. If Wave 2 split validation into its own module, import that instead.

- [ ] **Register the module** in `src/app.module.ts`: add `RulesModule`.

- [ ] **Run the test — expect PASS:** `npx jest src/rules/rules.service.spec.ts`.

- [ ] **Run the wave gate (G1) — expect all green:** `npm run build && npm run lint && npm run test && npm run test:e2e`.

- [ ] **Commit:**
  ```bash
  git add src/rules src/app.module.ts
  git commit -m "feat(rules): three-tier Rules engine (structural/hard/semantic)"
  ```

---

## Task 14 — Policy gate + Override logging

**Files:**
- Create: `src/database/migrations/007_create_policy_config.ts`, `src/database/migrations/008_create_override.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`, `src/app.module.ts`
- Create: `src/policy/types.ts`, `src/policy/policy.service.ts`, `src/policy/override.service.ts`, `src/policy/override.controller.ts`, `src/policy/policy.module.ts`
- Test: `src/policy/policy.service.spec.ts`, `src/policy/override.controller.spec.ts`

Honors **Must NOT do**: no approval lifecycle (Policy only decides auto-post vs hold); structural/hard failures => reject, never overridable; AI confidence stubbed at 1.0.

### Steps

- [ ] **Write the policy_config migration (G4, G6).** `src/database/migrations/007_create_policy_config.ts` — singleton (`id = 1` CHECK), seeded with defaults. Note the EUR ceiling comment:
  ```ts
  import { Kysely, sql } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('policy_config')
      .ifNotExists()
      // Singleton: one Organization, one policy config (id = 1 CHECK, ADR-0003).
      .addColumn('id', 'integer', (col) => col.primaryKey().check(sql`id = 1`))
      // 100000 cents == 1000 EUR (base currency of the seeded Irish org).
      // Above this, hold for approval.
      .addColumn('auto_post_amount_ceiling', 'integer', (col) => col.notNull().defaultTo(100000))
      // Stubbed: AI confidence not implemented yet (always 1.0). Stored x100.
      .addColumn('auto_post_min_confidence', 'integer', (col) => col.notNull().defaultTo(80))
      .addColumn('unknown_supplier_requires_approval', 'integer', (col) => col.notNull().defaultTo(1))
      .execute();

    await db
      .insertInto('policy_config')
      .values({
        id: 1,
        auto_post_amount_ceiling: 100000,
        auto_post_min_confidence: 80,
        unknown_supplier_requires_approval: 1,
      })
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('policy_config').ifExists().execute();
  }
  ```

- [ ] **Write the override migration (G4, G6).** `src/database/migrations/008_create_override.ts` — `voucher_id` is a real FK:
  ```ts
  import { Kysely } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('override')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
      // Only semantic rules can be overridden (enforced in OverrideService).
      .addColumn('rule_type', 'text', (col) => col.notNull())
      .addColumn('rule_name', 'text', (col) => col.notNull())
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('created_by', 'text', (col) => col.notNull())
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('override').ifExists().execute();
  }
  ```

- [ ] **Register both migrations** in `src/database/migrations/index.ts`:
  ```ts
  import * as m007 from './007_create_policy_config';
  import * as m008 from './008_create_override';
  '007_create_policy_config': m007,
  '008_create_override': m008,
  ```

- [ ] **Add the Kysely table types** to `src/database/types.ts` (`policy_config: PolicyConfigTable;` and `override: OverrideTable;` on `Database`, plus):
  ```ts
  export interface PolicyConfigTable {
    id: Generated<number>;
    auto_post_amount_ceiling: number;
    auto_post_min_confidence: number;
    unknown_supplier_requires_approval: number;
  }

  export interface OverrideTable {
    id: Generated<number>;
    voucher_id: number | null;
    rule_type: string;
    rule_name: string;
    reason: string;
    created_by: string;
    created_at: number;
  }
  ```

- [ ] **Write the types** `src/policy/types.ts`:
  ```ts
  import { DraftVoucher } from '../ledger/voucher/types';
  import { RuleResult } from '../rules/types';

  export type PolicyAction = 'auto-post' | 'hold-for-approval' | 'reject';

  export interface PolicyDecision {
    action: PolicyAction;
    reason: string;
  }

  export interface PolicyConfig {
    auto_post_amount_ceiling: number;
    auto_post_min_confidence: number; // x100
    unknown_supplier_requires_approval: boolean;
  }

  export interface OverrideRecord {
    id: number;
    voucher_id: number | null;
    rule_type: string;
    rule_name: string;
    reason: string;
    created_by: string;
    created_at: number;
  }

  export interface CreateOverrideDto {
    voucher_id?: number | null;
    rule_type: string;
    rule_name: string;
    reason: string;
    created_by?: string;
  }

  export type PolicyDraft = DraftVoucher;
  export type PolicyRuleResults = RuleResult[];
  ```

- [ ] **Write the FULL failing integration test** `src/policy/policy.service.spec.ts` (real DI + in-memory SQLite so config is read from the seeded `policy_config` row, satisfying G2 & G3). AC uses NON-default amounts on both sides of the ceiling:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { PolicyService } from './policy.service';
  import { DraftVoucher } from '../ledger/voucher/types';
  import { RuleResult } from '../rules/types';

  const draftOf = (debit: number): DraftVoucher => ({
    voucher_number: 'P-1',
    tax_point_date: '2024-03-10',
    lines: [
      { account_id: 1, amount: debit, currency: 'EUR', base_amount: debit, fx_rate: 1, vat_code: 'NULL_STANDARD', is_debit: true },
      { account_id: 2, amount: debit, currency: 'EUR', base_amount: debit, fx_rate: 1, vat_code: null, is_debit: false },
    ],
  });

  const pass = (ruleType: RuleResult['ruleType']): RuleResult => ({
    passed: true, ruleType, message: 'ok', overrideable: ruleType === 'semantic',
  });
  const allPass: RuleResult[] = [pass('structural'), pass('hard'), pass('semantic')];

  describe('PolicyService (integration)', () => {
    let db: Kysely<Database>;
    let policy: PolicyService;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          PolicyService,
        ],
      }).compile();
      policy = module.get(PolicyService);
    });

    afterEach(async () => { await db.destroy(); });

    it('under ceiling + all rules pass => auto-post', async () => {
      const d = await policy.decide(draftOf(50000), allPass); // 50000 < 100000
      expect(d.action).toBe('auto-post');
    });

    it('over ceiling => hold-for-approval, reason mentions amount', async () => {
      const d = await policy.decide(draftOf(150000), allPass); // 150000 > 100000
      expect(d.action).toBe('hold-for-approval');
      expect(d.reason.toLowerCase()).toContain('amount');
    });

    it('structural failure => reject (never overridable)', async () => {
      const failed: RuleResult[] = [
        { passed: false, ruleType: 'structural', message: 'unbalanced', overrideable: false },
        pass('hard'), pass('semantic'),
      ];
      const d = await policy.decide(draftOf(50000), failed);
      expect(d.action).toBe('reject');
    });

    it('hard failure => reject', async () => {
      const failed: RuleResult[] = [
        pass('structural'),
        { passed: false, ruleType: 'hard', message: 'period locked', overrideable: false },
        pass('semantic'),
      ];
      const d = await policy.decide(draftOf(50000), failed);
      expect(d.action).toBe('reject');
    });
  });
  ```

- [ ] **Run the test — expect FAIL:** `npx jest src/policy/policy.service.spec.ts` → `Cannot find module './policy.service'`.

- [ ] **Write the PolicyService** `src/policy/policy.service.ts`. Reads config from the DB (never hardcoded), totals debits, and decides. Structural/hard failures always reject; semantic failures that have NOT been overridden also reject (the override path resolves them upstream in Rules → here they already show `passed:true`):
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { DraftVoucher } from '../ledger/voucher/types';
  import { RuleResult } from '../rules/types';
  import { PolicyConfig, PolicyDecision } from './types';

  // AI confidence scoring is not implemented yet (Must NOT do). Stub at 1.0.
  const STUBBED_CONFIDENCE = 1.0;

  @Injectable()
  export class PolicyService {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async getConfig(): Promise<PolicyConfig> {
      const row = await this.db
        .selectFrom('policy_config').selectAll().where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return {
        auto_post_amount_ceiling: row.auto_post_amount_ceiling,
        auto_post_min_confidence: row.auto_post_min_confidence,
        unknown_supplier_requires_approval: row.unknown_supplier_requires_approval === 1,
      };
    }

    async decide(draft: DraftVoucher, ruleResults: RuleResult[]): Promise<PolicyDecision> {
      // Inviolable failures (structural/hard) => reject; never overridable.
      const inviolableFailure = ruleResults.find(
        (r) => !r.passed && (r.ruleType === 'structural' || r.ruleType === 'hard'),
      );
      if (inviolableFailure) {
        return { action: 'reject', reason: `Inviolable rule failed: ${inviolableFailure.message}` };
      }

      // Any remaining failed rule (an un-overridden semantic rule) also rejects.
      const remainingFailure = ruleResults.find((r) => !r.passed);
      if (remainingFailure) {
        return { action: 'reject', reason: `Rule failed: ${remainingFailure.message}` };
      }

      const config = await this.getConfig();

      // Confidence gate (stubbed at 1.0 for Wave 3).
      if (STUBBED_CONFIDENCE * 100 < config.auto_post_min_confidence) {
        return { action: 'hold-for-approval', reason: 'AI confidence below threshold' };
      }

      // Amount ceiling: total debits in base currency.
      const total = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      if (total > config.auto_post_amount_ceiling) {
        return {
          action: 'hold-for-approval',
          reason: `Amount ${total} exceeds auto-post ceiling ${config.auto_post_amount_ceiling}`,
        };
      }

      return { action: 'auto-post', reason: 'Within policy thresholds; all rules pass' };
    }
  }
  ```

- [ ] **Write the OverrideService** `src/policy/override.service.ts`. Logs ONLY semantic overrides (enforced in code — Must NOT do):
  ```ts
  import { Injectable, BadRequestException } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { CreateOverrideDto, OverrideRecord } from './types';

  @Injectable()
  export class OverrideService {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async create(dto: CreateOverrideDto): Promise<OverrideRecord> {
      // Structural/hard rules can NEVER be overridden (ADR-0012). Reject here too,
      // not only in Rules — defense in depth.
      if (dto.rule_type !== 'semantic') {
        throw new BadRequestException(
          `Only semantic rules are overridable; got rule_type=${dto.rule_type}`,
        );
      }
      if (!dto.reason || dto.reason.trim().length === 0) {
        throw new BadRequestException('Override requires a non-empty reason');
      }

      const row = await this.db
        .insertInto('override')
        .values({
          voucher_id: dto.voucher_id ?? null,
          rule_type: dto.rule_type,
          rule_name: dto.rule_name,
          reason: dto.reason,
          created_by: dto.created_by ?? 'system',
          created_at: Math.floor(Date.now() / 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as OverrideRecord;
    }

    async list(): Promise<OverrideRecord[]> {
      const rows = await this.db.selectFrom('override').selectAll().execute();
      return rows as OverrideRecord[];
    }
  }
  ```

- [ ] **Write the OverrideController** `src/policy/override.controller.ts`:
  ```ts
  import { Controller, Get, Post, Body } from '@nestjs/common';
  import { OverrideService } from './override.service';
  import { CreateOverrideDto, OverrideRecord } from './types';

  @Controller('api/overrides')
  export class OverrideController {
    constructor(private readonly overrides: OverrideService) {}

    @Post()
    async create(@Body() dto: CreateOverrideDto): Promise<OverrideRecord> {
      return this.overrides.create(dto);
    }

    @Get()
    async list(): Promise<OverrideRecord[]> {
      return this.overrides.list();
    }
  }
  ```

- [ ] **Write the module** `src/policy/policy.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { PolicyService } from './policy.service';
  import { OverrideService } from './override.service';
  import { OverrideController } from './override.controller';

  @Module({
    imports: [DatabaseModule],
    controllers: [OverrideController],
    providers: [PolicyService, OverrideService],
    exports: [PolicyService, OverrideService],
  })
  export class PolicyModule {}
  ```

- [ ] **Write the override controller integration test** `src/policy/override.controller.spec.ts` (real DI + in-memory SQLite — proves a semantic override row is written and a structural override is rejected, satisfying G2 & the AC "Override record created with reason"):
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { OverrideService } from './override.service';
  import { OverrideController } from './override.controller';

  describe('OverrideController (integration)', () => {
    let db: Kysely<Database>;
    let controller: OverrideController;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      const module: TestingModule = await Test.createTestingModule({
        controllers: [OverrideController],
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          OverrideService,
        ],
      }).compile();
      controller = module.get(OverrideController);
    });

    afterEach(async () => { await db.destroy(); });

    it('logs a semantic override with a reason', async () => {
      const rec = await controller.create({
        rule_type: 'semantic',
        rule_name: 'vat_code_applicability',
        reason: 'Migration from legacy system',
        created_by: 'aleksei',
      });
      expect(rec.id).toBeGreaterThan(0);
      expect(rec.reason).toBe('Migration from legacy system');

      const all = await controller.list();
      expect(all).toHaveLength(1);
    });

    it('rejects an attempt to override a structural rule', async () => {
      await expect(
        controller.create({
          rule_type: 'structural',
          rule_name: 'balance',
          reason: 'let me through',
        }),
      ).rejects.toThrow();
    });
  });
  ```

- [ ] **Register the module** in `src/app.module.ts`: add `PolicyModule`.

- [ ] **Run the tests — expect PASS:** `npx jest src/policy/`.

- [ ] **Run the wave gate (G1) — expect all green:** `npm run build && npm run lint && npm run test && npm run test:e2e`.

- [ ] **Commit:**
  ```bash
  git add src/policy src/database/migrations/007_create_policy_config.ts src/database/migrations/008_create_override.ts src/database/migrations/index.ts src/database/types.ts src/app.module.ts
  git commit -m "feat(policy): Policy gate + Override logging"
  ```

---

## Task 15 — Pipeline integration (end-to-end flow)

**Files:**
- Modify: `src/expenses/expenses.service.ts` (add `postExpense`), `src/expenses/expenses.controller.ts` (add `POST :id/post`), `src/expenses/expenses.module.ts` (ensure RulesModule/PolicyModule imported)
- Modify: `src/sales-invoices/sales-invoices.service.ts` (add `postInvoice`), `src/sales-invoices/sales-invoices.controller.ts` (add `POST :id/post`), `src/sales-invoices/sales-invoices.module.ts`
- Test: `test/pipeline.e2e-spec.ts`

Honors **Must NOT do**: NO new business logic — only wiring existing services; NO approval workflow (hold just sets `pending`); NO AI/OCR.

### Steps

- [ ] **Write the FULL failing e2e test** `test/pipeline.e2e-spec.ts` (real `AppModule` on in-memory SQLite, copying `test/app.e2e-spec.ts`). Exercises auto-post (small), hold (large), and reject (forced unbalanced) paths. This is the G2 end-to-end integration test for the whole pipeline:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { INestApplication } from '@nestjs/common';
  import { Kysely, SqliteDialect } from 'kysely';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import request from 'supertest';
  import { App } from 'supertest/types';
  import { AppModule } from './../src/app.module';

  describe('Posting pipeline (e2e)', () => {
    let app: INestApplication<App>;
    let db: Kysely<unknown>;

    beforeEach(async () => {
      db = new Kysely<unknown>({
        dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
      });
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
        .useValue(db)
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterEach(async () => { await app.close(); });

    it('auto-posts a small expense (status posted, voucher posted_at set)', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/expenses')
        .send({ category: 'software', gross_amount: 50000, vat_amount: 0, currency: 'EUR', tax_point_date: '2024-01-15' })
        .expect(201);
      const id = created.body.id as number;

      const posted = await request(app.getHttpServer())
        .post(`/api/expenses/${id}/post`)
        .expect(200);

      expect(posted.body.status).toBe('posted');
      expect(posted.body.voucher_id).not.toBeNull();
      expect(posted.body.voucher.posted_at).not.toBeNull();
    });

    it('holds a large expense for approval (status pending, voucher NOT posted)', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/expenses')
        .send({ category: 'software', gross_amount: 150000, vat_amount: 0, currency: 'EUR', tax_point_date: '2024-01-15' })
        .expect(201);
      const id = created.body.id as number;

      const held = await request(app.getHttpServer())
        .post(`/api/expenses/${id}/post`)
        .expect(200);

      expect(held.body.status).toBe('pending');
      expect(held.body.voucher.posted_at).toBeNull();
    });

    it('rejects an unbalanced draft (400, expense stays draft)', async () => {
      // Force a structural failure: vat_amount > gross would still balance the
      // 2-line cash draft, so instead simulate via the dedicated test category
      // that the null plugin maps to a NON-existent account -> account lookup
      // fails -> 4xx. (Adjust to your structural-failure injection if available.)
      const created = await request(app.getHttpServer())
        .post('/api/expenses')
        .send({ category: '__force_unbalanced__', gross_amount: 50000, vat_amount: 0, currency: 'EUR', tax_point_date: '2024-01-15' })
        .expect(201);
      const id = created.body.id as number;

      await request(app.getHttpServer())
        .post(`/api/expenses/${id}/post`)
        .expect((res) => { if (res.status < 400) throw new Error(`expected 4xx, got ${res.status}`); });

      const after = await request(app.getHttpServer()).get(`/api/expenses/${id}`).expect(200);
      expect(after.body.status).toBe('draft');
    });

    it('auto-posts a small sales invoice end-to-end', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/sales-invoices')
        .send({ invoice_number: 'INV-E2E-1', gross_amount: 24600, vat_amount: 4600, currency: 'EUR', tax_point_date: '2024-01-15' })
        .expect(201);
      const id = created.body.id as number;

      const posted = await request(app.getHttpServer())
        .post(`/api/sales-invoices/${id}/post`)
        .expect(200);

      expect(posted.body.status).toBe('posted');
      expect(posted.body.voucher.posted_at).not.toBeNull();
    });
  });
  ```
  > The reject-path test needs a deterministic structural failure. Two clean options — pick the one that fits Wave 2: (a) have the null plugin map a sentinel category `__force_unbalanced__` to a non-existent account code so `getAccountByCode` returns undefined and the service throws a 4xx (a one-line plugin tweak, NOT new schema); or (b) if `PostingService` exposes injecting raw lines, post a draft with deliberately unbalanced base_amounts. Whichever you choose, the AC is: pipeline rejects with 4xx and the expense stays `draft`.

- [ ] **Run the e2e — expect FAIL:** `npx jest --config ./test/jest-e2e.json test/pipeline.e2e-spec.ts` → 404 on `/post` (endpoint not implemented).

- [ ] **Add `postExpense` to `ExpensesService`** (pure wiring: generateDraft → Rules ×3 → Policy → post-or-hold). Add the two new constructor deps (`RulesService`, `PolicyService`, `PostingService`) and the method:
  ```ts
  // add to imports:
  // import { RulesService } from '../rules/rules.service';
  // import { PolicyService } from '../policy/policy.service';
  // import { PostingService } from '../ledger/posting/posting.service';
  // and to the constructor: private readonly rules, policy, posting

  /**
   * Full pipeline: draft -> Rules (structural/hard/semantic) -> Policy -> post|hold.
   * No new business logic — only orchestration of existing services (ADR-0005).
   */
  async postExpense(id: number): Promise<Expense & { voucher: { id: number | null; posted_at: number | null } | null }> {
    const draft = await this.generateDraft(id);

    const structural = await this.rules.validate(draft, 'structural');
    const hard = await this.rules.validate(draft, 'hard');
    const semantic = await this.rules.validate(draft, 'semantic');
    const decision = await this.policy.decide(draft, [structural, hard, semantic]);

    if (decision.action === 'reject') {
      // Stays draft; surface as a 400 at the controller.
      throw new BadRequestException(decision.reason);
    }

    if (decision.action === 'hold-for-approval') {
      // Persist the voucher in an unposted state and link it; expense -> pending.
      const heldVoucher = await this.posting.createDraftVoucher(draft); // unposted insert
      const expense = await this.setStatus(id, 'pending', heldVoucher.id);
      return { ...expense, voucher: { id: heldVoucher.id, posted_at: null } };
    }

    // auto-post: atomic, immutable.
    const posted = await this.posting.postVoucher(draft);
    const expense = await this.setStatus(id, 'posted', posted.id);
    return { ...expense, voucher: { id: posted.id, posted_at: posted.posted_at } };
  }
  ```
  > Add `import { BadRequestException } from '@nestjs/common';`. The hold path needs an unposted voucher insert: if Wave 2's `PostingService` has no `createDraftVoucher` (insert with `posted_at = null`), add a small repository method `VoucherRepository.createVoucher({ ...draft, posted_at: null })` and call it — this is wiring an *insert*, not new accounting logic, and it does NOT touch schema (the column already exists). Keep the hold voucher unposted (`posted_at` null) so immutability/Wave-6 approval can post it later.

- [ ] **Add the post endpoint to `ExpensesController`:**
  ```ts
  @Post(':id/post')
  async post(@Param('id', ParseIntPipe) id: number) {
    return this.expenses.postExpense(id);
  }
  ```

- [ ] **Add `postInvoice` to `SalesInvoicesService`** (identical orchestration, calling `this.generateDraft`, the same Rules/Policy/Posting deps; sets status `posted`/`pending`). Add the same three constructor deps. On reject, stays `draft` and throws `BadRequestException`.

- [ ] **Add the post endpoint to `SalesInvoicesController`:**
  ```ts
  @Post(':id/post')
  async post(@Param('id', ParseIntPipe) id: number) {
    return this.invoices.postInvoice(id);
  }
  ```

- [ ] **Ensure module imports** — `ExpensesModule` and `SalesInvoicesModule` both import `RulesModule`, `PolicyModule`, and the Wave 2 `LedgerModule` (for `PostingService`). Add any that are missing.

- [ ] **Run the e2e — expect PASS:** `npx jest --config ./test/jest-e2e.json test/pipeline.e2e-spec.ts`.

- [ ] **Run the FULL wave gate (G1) — expect all green:** `npm run build && npm run lint && npm run test && npm run test:e2e`.

- [ ] **Commit:**
  ```bash
  git add src/expenses src/sales-invoices test/pipeline.e2e-spec.ts
  git commit -m "feat(pipeline): end-to-end posting pipeline integration"
  ```

---

## Wave 3 verification pass (G8) — run before the final wave commit

- [ ] **G1 (CI parity, all four green):** `npm run build && npm run lint && npm run test && npm run test:e2e`.
- [ ] **G4 (schema only in migrations) — grep must be EMPTY:**
  ```bash
  grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"
  ```
- [ ] **G6 (DB invariants are real constraints) — confirm the proving tests exist and pass:** `sales-invoices.service.spec.ts` (UNIQUE invoice_number), the status CHECK on `expense`/`sales_invoice`, the `policy_config` `id = 1` singleton, and the `override.voucher_id` FK.
- [ ] **G5 (Must-NOT-do greps clean):** confirm no auto-post in `generate-draft` (drafts return `posted_at: null`); no real email in `send`; structural/hard never overrideable (assert in `rules.service.spec.ts` + `override.controller.spec.ts`); no AI confidence beyond the stubbed `1.0`; no period-lock logic beyond the stub.
- [ ] **G3 (ACs discriminate):** confirm tests use non-default values — expense category `transport`/amount `33000`, invoice net `20000`, Policy amounts `50000`/`150000` straddling the `100000` ceiling.
- [ ] **Scope fidelity:** no Wave 4+ concepts (intake/Document, reconciliation, approval lifecycle, hash chain, supplier/customer matching) introduced.
- [ ] **Final wave commit (if a wave-level marker commit is desired):**
  ```bash
  git commit --allow-empty -m "feat(pipeline): business objects + rules + policy + integration"
  ```
