import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ReportingPeriodsService } from './reporting-periods.service';
import { ReportingPeriodsController } from './reporting-periods.controller';
import { VatReportService } from '../vat-report/vat-report.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from './period-lock.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { OrganizationService } from '../organization/organization.service';
// ValidationError not used in these tests
// import { ValidationError } from '../ledger/posting/types';
import { DraftVoucher } from '../ledger/voucher/types';

/**
 * Integration tests for Task 27: ReportingPeriod lock + filing guard.
 *
 * Real-DI against in-memory SQLite (G2 gate).
 *
 * Proves:
 *  (a) POST :id/lock changes status open → locked, sets filed_at
 *  (b) Lock is idempotent — re-locking returns 200, not error
 *  (c) PostingService rejects voucher whose tax_point_date falls in locked period
 *  (d) GET :id/warnings lists pending approvals and unposted drafts
 *  (e) Warnings do NOT block locking — user decides
 */
describe('ReportingPeriod lock + filing guard (integration)', () => {
  let db: Kysely<Database>;
  let periodsService: ReportingPeriodsService;
  let periodsController: ReportingPeriodsController;
  let postingService: PostingService;

  const balancedDraft = (taxPointDate: string): DraftVoucher => ({
    voucher_number: 'V-TEST-001',
    tax_point_date: taxPointDate,
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ReportingPeriodsService,
        ReportingPeriodsController,
        VatReportService,
        LedgerBalanceService,
        AccountService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrganizationService,
      ],
      controllers: [ReportingPeriodsController],
    }).compile();

    periodsService = module.get(ReportingPeriodsService);
    periodsController = module.get(ReportingPeriodsController);
    postingService = module.get(PostingService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── (a) Lock changes status open → locked, sets filed_at ──────────────

  it('(a) lock changes status from open to locked and sets filed_at', async () => {
    const period = await periodsService.getById(1);
    expect(period.status).toBe('open');
    expect(period.filed_at).toBeNull();

    const locked = await periodsService.lock(1);

    expect(locked.status).toBe('locked');
    expect(locked.filed_at).not.toBeNull();
    expect(locked.filed_at).toBeGreaterThan(0);
  });

  it('(a) controller POST :id/lock returns the locked period', async () => {
    const result = await periodsController.lock(1);

    expect(result.status).toBe('locked');
    expect(result.filed_at).not.toBeNull();
  });

  // ── (b) Lock is idempotent ────────────────────────────────────────────

  it('(b) re-locking an already-locked period returns 200, not error', async () => {
    // First lock
    const first = await periodsService.lock(1);
    expect(first.status).toBe('locked');
    const firstFiledAt = first.filed_at;

    // Second lock — should succeed, not throw
    const second = await periodsService.lock(1);
    expect(second.status).toBe('locked');
    // filed_at should remain the same (not updated on re-lock)
    expect(second.filed_at).toBe(firstFiledAt);
  });

  it('(b) controller re-lock returns the same locked period', async () => {
    await periodsController.lock(1);
    const result = await periodsController.lock(1);
    expect(result.status).toBe('locked');
  });

  // ── (c) PostingService rejects voucher into locked period ─────────────

  it('(c) posting a voucher with tax_point_date in a locked period throws BadRequestException', async () => {
    // Lock the 2024-Q1 period (2024-01-01 to 2024-03-31)
    await periodsService.lock(1);

    // Try to post a voucher dated within that period
    const draft = balancedDraft('2024-02-15');
    await expect(postingService.postVoucher(draft)).rejects.toThrow(
      BadRequestException,
    );
    await expect(postingService.postVoucher(draft)).rejects.toThrow(
      'Cannot post into locked period 2024-Q1',
    );
  });

  it('(c) posting a voucher with tax_point_date in an open period succeeds', async () => {
    // 2024-Q1 is open (2024-01-01 to 2024-03-31)
    const draft = balancedDraft('2024-02-15');
    const result = await postingService.postVoucher(draft);
    expect(result.id).toBeGreaterThan(0);
    expect(result.posted_at).not.toBeNull();
  });

  it('(c) posting a voucher with tax_point_date outside any period succeeds', async () => {
    // Date outside the seeded 2024-Q1 range
    const draft = balancedDraft('2025-06-15');
    const result = await postingService.postVoucher(draft);
    expect(result.id).toBeGreaterThan(0);
  });

  // ── (d) Warnings endpoint lists pending items ─────────────────────────

  it('(d) warnings returns empty array when no pending/draft items exist', async () => {
    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toEqual([]);
  });

  it('(d) warnings lists pending expense approvals in the period', async () => {
    // Seed a pending expense within 2024-Q1
    await db
      .insertInto('expense')
      .values({
        category: 'software',
        gross_amount: 5000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-01',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('pending_approval');
    expect(result.warnings[0].object_type).toBe('expense');
    expect(result.warnings[0].description).toContain('software');
  });

  it('(d) warnings lists unposted draft expenses in the period', async () => {
    await db
      .insertInto('expense')
      .values({
        category: 'transport',
        gross_amount: 2500,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-03-15',
        status: 'draft',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('unposted_draft');
    expect(result.warnings[0].object_type).toBe('expense');
  });

  it('(d) warnings lists pending sales invoices in the period', async () => {
    await db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-001',
        gross_amount: 15000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-01-20',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('pending_approval');
    expect(result.warnings[0].object_type).toBe('sales_invoice');
    expect(result.warnings[0].description).toContain('INV-001');
  });

  it('(d) warnings lists draft sales invoices in the period', async () => {
    await db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-002',
        gross_amount: 8000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-28',
        status: 'draft',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('unposted_draft');
    expect(result.warnings[0].object_type).toBe('sales_invoice');
  });

  it('(d) warnings ignores items outside the period date range', async () => {
    // Expense outside 2024-Q1 (April = Q2)
    await db
      .insertInto('expense')
      .values({
        category: 'rent',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-04-01',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toEqual([]);
  });

  it('(d) warnings returns multiple items of different types', async () => {
    await db
      .insertInto('expense')
      .values({
        category: 'software',
        gross_amount: 5000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-01',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    await db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-003',
        gross_amount: 12000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-03-01',
        status: 'draft',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const result = await periodsController.getWarnings(1);
    expect(result.warnings).toHaveLength(2);
    const types = result.warnings.map((w) => w.type);
    expect(types).toContain('pending_approval');
    expect(types).toContain('unposted_draft');
  });

  // ── (e) Warnings do NOT block locking ─────────────────────────────────

  it('(e) lock succeeds even when warnings exist', async () => {
    // Seed a pending expense
    await db
      .insertInto('expense')
      .values({
        category: 'software',
        gross_amount: 5000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-01',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    // Verify warnings exist
    const warnings = await periodsController.getWarnings(1);
    expect(warnings.warnings.length).toBeGreaterThan(0);

    // Lock should still succeed
    const locked = await periodsService.lock(1);
    expect(locked.status).toBe('locked');
  });

  // ── NotFoundException for unknown period ──────────────────────────────

  it('lock throws NotFoundException for unknown period id', async () => {
    await expect(periodsService.lock(999)).rejects.toThrow(NotFoundException);
  });

  it('getWarnings throws NotFoundException for unknown period id', async () => {
    await expect(periodsService.getWarnings(999)).rejects.toThrow(
      NotFoundException,
    );
  });
});
