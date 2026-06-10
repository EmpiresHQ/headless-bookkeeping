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
import { StatusTransitionService } from './../src/ledger/status/status-transition.service';
import { PeriodLockService } from './../src/reporting-periods/period-lock.service';
import { RulesService } from './../src/rules/rules.service';
import { PolicyService } from './../src/policy/policy.service';
import { PostingPipelineService } from './../src/ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from './../src/expenses/expenses.service';
import { ExpensesController } from './../src/expenses/expenses.controller';
import { SalesInvoicesService } from './../src/sales-invoices/sales-invoices.service';
import { SalesInvoicesController } from './../src/sales-invoices/sales-invoices.controller';
import { OrganizationService } from './../src/organization/organization.service';
import { OrgContextResolver } from './../src/organization/org-context.resolver';
import { PluginLoader } from './../src/plugins/plugin-loader.service';
import { NullCountryPlugin } from './../src/plugins/null-country.plugin';
import { EstoniaCountryPlugin } from './../src/plugins/estonia-country.plugin';
import { CurrencyService } from './../src/currency/currency.service';
import { VoucherProjectionService } from './../src/ledger/projection/voucher-projection.service';
import { ZodValidationPipe } from './../src/common/pipes/zod-validation.pipe';

describe('Pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ExpensesController, SalesInvoicesController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        VoucherProjectionService,
        ExpensesService,
        SalesInvoicesService,
        OrganizationService,
        OrgContextResolver,
        PluginLoader,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        CurrencyService,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  // ── Expense pipeline ──────────────────────────────────────────

  const createExpense = async (
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post('/api/expenses')
      .send({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        ...overrides,
      })
      .expect(201);
    return res.body as Record<string, unknown>;
  };

  describe('Expense pipeline: happy path (auto-post)', () => {
    it('creates an expense, posts it, mints a voucher, sets status=posted', async () => {
      const expense = await createExpense();
      expect(Reflect.get(expense, 'status')).toBe('draft');

      const res = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(201);

      // Policy returns auto-post for small amounts (< 100000 cents)
      expect(Reflect.get(Reflect.get(res.body, 'policy'), 'action')).toBe(
        'auto-post',
      );

      // Voucher was minted
      expect(Reflect.get(res.body, 'voucher')).not.toBeNull();
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('id');
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('posted_at');
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('previous_hash');
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('lines');
      expect(
        Array.isArray(Reflect.get(Reflect.get(res.body, 'voucher'), 'lines')),
      ).toBe(true);

      // Expense updated
      expect(Reflect.get(Reflect.get(res.body, 'expense'), 'status')).toBe(
        'posted',
      );
      expect(Reflect.get(Reflect.get(res.body, 'expense'), 'voucher_id')).toBe(
        Reflect.get(Reflect.get(res.body, 'voucher'), 'id'),
      );
    });
  });

  describe('Expense pipeline: policy hold', () => {
    it('holds a large expense for approval, sets status=pending, no voucher', async () => {
      // Amount > 100000 cents = 1000 EUR
      const expense = await createExpense({
        gross_amount: 250000,
        vat_amount: 50000,
      });
      expect(Reflect.get(expense, 'status')).toBe('draft');

      const res = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(201);

      // Policy holds for approval due to amount ceiling
      expect(Reflect.get(Reflect.get(res.body, 'policy'), 'action')).toBe(
        'hold-for-approval',
      );
      expect(Reflect.get(Reflect.get(res.body, 'policy'), 'reason')).toContain(
        'ceiling',
      );

      // NO voucher persisted (ADR-0020)
      expect(Reflect.get(res.body, 'voucher')).toBeNull();

      // Expense status set to pending
      expect(Reflect.get(Reflect.get(res.body, 'expense'), 'status')).toBe(
        'pending',
      );
      expect(
        Reflect.get(Reflect.get(res.body, 'expense'), 'voucher_id'),
      ).toBeNull();

      // Verify no voucher rows in DB
      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);
    });
  });

  describe('Expense pipeline: rule rejection (structural failure → 400)', () => {
    it('rejects an expense that produces a negative net amount', async () => {
      // gross < vat → net negative → structural validation fails (amount > 0)
      const expense = await createExpense({
        gross_amount: 100,
        vat_amount: 200,
      });
      expect(Reflect.get(expense, 'status')).toBe('draft');

      const res = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(400);

      expect(Reflect.get(res.body, 'message')).toContain('Structural');

      // Expense stays draft, no voucher minted
      const updated = await db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', Reflect.get(expense, 'id') as number)
        .executeTakeFirst();
      expect(updated?.status).toBe('draft');
      expect(updated?.voucher_id).toBeNull();

      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);
    });
  });

  describe('Expense pipeline: idempotency (AC-9)', () => {
    it('refuses to double-post an already-posted expense', async () => {
      const expense = await createExpense();

      // First post succeeds
      const first = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(201);
      expect(Reflect.get(Reflect.get(first.body, 'expense'), 'status')).toBe(
        'posted',
      );

      // Second post returns 409
      const second = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(409);
      expect(Reflect.get(second.body, 'message')).toContain('already posted');

      // Only one voucher exists
      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(1);
    });

    it('refuses to post a pending expense', async () => {
      // Create a large expense that will be held
      const expense = await createExpense({
        gross_amount: 250000,
        vat_amount: 50000,
      });

      // First post → held
      await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(201);

      // Second post → refused (already pending)
      const second = await request(app.getHttpServer())
        .post(`/api/expenses/${Reflect.get(expense, 'id') as number}/post`)
        .expect(409);
      expect(Reflect.get(second.body, 'message')).toContain('already pending');
    });
  });

  // ── Sales invoice pipeline ────────────────────────────────────

  const createInvoice = async (
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-invoices')
      .send({
        invoice_number: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        ...overrides,
      })
      .expect(201);
    return res.body as Record<string, unknown>;
  };

  describe('SalesInvoice pipeline: happy path (auto-post)', () => {
    it('creates an invoice, posts it, mints a voucher, sets status=posted', async () => {
      const invoice = await createInvoice();
      expect(Reflect.get(invoice, 'status')).toBe('draft');

      const res = await request(app.getHttpServer())
        .post(
          `/api/sales-invoices/${Reflect.get(invoice, 'id') as number}/post`,
        )
        .expect(201);

      expect(Reflect.get(Reflect.get(res.body, 'policy'), 'action')).toBe(
        'auto-post',
      );
      expect(Reflect.get(res.body, 'voucher')).not.toBeNull();
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('id');
      expect(Reflect.get(res.body, 'voucher')).toHaveProperty('posted_at');
      expect(
        Array.isArray(Reflect.get(Reflect.get(res.body, 'voucher'), 'lines')),
      ).toBe(true);
      expect(Reflect.get(Reflect.get(res.body, 'invoice'), 'status')).toBe(
        'posted',
      );
      expect(Reflect.get(Reflect.get(res.body, 'invoice'), 'voucher_id')).toBe(
        Reflect.get(Reflect.get(res.body, 'voucher'), 'id'),
      );

      // Verify voucher lines (Dr AR + Cr REVENUE + Cr VAT_PAYABLE)
      const voucherLines = Reflect.get(
        Reflect.get(res.body, 'voucher'),
        'lines',
      ) as Array<{ is_debit: boolean }>;
      const debitLines = voucherLines.filter((l) => l.is_debit);
      const creditLines = voucherLines.filter((l) => !l.is_debit);
      expect(debitLines).toHaveLength(1); // Dr AR
      expect(creditLines).toHaveLength(2); // Cr REVENUE + Cr VAT_PAYABLE
    });
  });

  describe('SalesInvoice pipeline: policy hold', () => {
    it('holds a large invoice for approval, sets status=pending, no voucher', async () => {
      const invoice = await createInvoice({
        gross_amount: 250000,
        vat_amount: 50000,
        invoice_number: `INV-LARGE-${Date.now()}`,
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/sales-invoices/${Reflect.get(invoice, 'id') as number}/post`,
        )
        .expect(201);

      expect(Reflect.get(Reflect.get(res.body, 'policy'), 'action')).toBe(
        'hold-for-approval',
      );
      expect(Reflect.get(res.body, 'voucher')).toBeNull();
      expect(Reflect.get(Reflect.get(res.body, 'invoice'), 'status')).toBe(
        'pending',
      );
      expect(
        Reflect.get(Reflect.get(res.body, 'invoice'), 'voucher_id'),
      ).toBeNull();
    });
  });

  describe('SalesInvoice pipeline: idempotency (AC-9)', () => {
    it('refuses to double-post an already-posted invoice', async () => {
      const invoice = await createInvoice();

      // First post succeeds
      const first = await request(app.getHttpServer())
        .post(
          `/api/sales-invoices/${Reflect.get(invoice, 'id') as number}/post`,
        )
        .expect(201);
      expect(Reflect.get(Reflect.get(first.body, 'invoice'), 'status')).toBe(
        'posted',
      );

      // Second post returns 409
      const second = await request(app.getHttpServer())
        .post(
          `/api/sales-invoices/${Reflect.get(invoice, 'id') as number}/post`,
        )
        .expect(409);
      expect(Reflect.get(second.body, 'message')).toContain('already posted');
    });
  });

  describe('SalesInvoice pipeline: not found', () => {
    it('returns 404 for a non-existent invoice', async () => {
      await request(app.getHttpServer())
        .post('/api/sales-invoices/99999/post')
        .expect(404);
    });
  });
});
