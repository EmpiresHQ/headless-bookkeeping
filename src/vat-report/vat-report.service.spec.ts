import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { NotFoundException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { VatReportService } from './vat-report.service';
import { VatReportController } from './vat-report.controller';

/**
 * Integration test for Task 28: VAT report snapshot generation.
 *
 * Real-DI against in-memory SQLite (G2 gate).
 *
 * Proves:
 *  (a) generate() aggregates voucher_lines by vat_code into input vs output
 *  (b) total_payable = total_output_vat - total_input_vat
 *  (c) merkle_root is NULL on generation
 *  (d) Immutability: raw UPDATE/DELETE on vat_report is rejected by triggers
 *  (e) Idempotency: re-generating returns the same snapshot
 *  (f) NotFoundException for unknown period
 *  (g) Controller 405 on PUT/PATCH/DELETE
 */
describe('VAT report snapshot generation (integration)', () => {
  let db: Kysely<Database>;
  let vatReportService: VatReportService;
  let vatReportController: VatReportController;

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
        VatReportService,
        VatReportController,
      ],
      controllers: [VatReportController],
    }).compile();

    vatReportService = module.get(VatReportService);
    vatReportController = module.get(VatReportController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Insert a posted voucher with the given lines and tax_point_date. */
  async function seedPostedVoucher(
    taxPointDate: string,
    lines: Array<{
      account_code: string;
      amount: number;
      currency: string;
      base_amount: number;
      fx_rate: number;
      vat_code: string | null;
      is_debit: boolean;
    }>,
  ): Promise<number> {
    const postedAt = Math.floor(Date.now() / 1000);

    // Resolve account codes to IDs
    const codes = [...new Set(lines.map((l) => l.account_code))];
    const accounts = await db
      .selectFrom('account')
      .select(['id', 'code'])
      .where('code', 'in', codes)
      .execute();
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tax_point_date: taxPointDate,
        posted_at: postedAt,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values(
        lines.map((l) => ({
          voucher_id: voucher.id,
          account_id: byCode.get(l.account_code)!,
          amount: l.amount,
          currency: l.currency,
          base_amount: l.base_amount,
          fx_rate: l.fx_rate,
          vat_code: l.vat_code,
          is_debit: l.is_debit ? 1 : 0,
        })),
      )
      .execute();

    return voucher.id;
  }

  // ── (a) Aggregation by vat_code ────────────────────────────────────────

  it('(a) aggregates voucher_lines by vat_code into input vs output', async () => {
    // Seed two vouchers in 2024-Q1 (2024-01-01 to 2024-03-31)
    // Voucher 1: purchase (debit) with VAT code "INPUT_25"
    await seedPostedVoucher('2024-02-15', [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    // Voucher 2: sale (credit) with VAT code "OUTPUT_25"
    await seedPostedVoucher('2024-03-01', [
      {
        account_code: 'AR',
        amount: 12500,
        currency: 'EUR',
        base_amount: 12500,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: 'REVENUE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: 2500,
        currency: 'EUR',
        base_amount: 2500,
        fx_rate: 1,
        vat_code: 'OUTPUT_25',
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);

    expect(report.period_name).toBe('2024-Q1');
    expect(report.vat_summary).toHaveLength(2);

    const inputLine = report.vat_summary.find((l) => l.vat_code === 'INPUT_25');
    expect(inputLine).toBeDefined();
    expect(inputLine!.input_vat).toBe(10000);
    expect(inputLine!.output_vat).toBe(0);

    const outputLine = report.vat_summary.find(
      (l) => l.vat_code === 'OUTPUT_25',
    );
    expect(outputLine).toBeDefined();
    expect(outputLine!.input_vat).toBe(0);
    expect(outputLine!.output_vat).toBe(2500);
  });

  // ── (b) Totals computation ─────────────────────────────────────────────

  it('(b) total_payable = total_output_vat - total_input_vat', async () => {
    await seedPostedVoucher('2024-01-10', [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    await seedPostedVoucher('2024-02-20', [
      {
        account_code: 'AR',
        amount: 20000,
        currency: 'EUR',
        base_amount: 20000,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: 'REVENUE',
        amount: 16000,
        currency: 'EUR',
        base_amount: 16000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: 4000,
        currency: 'EUR',
        base_amount: 4000,
        fx_rate: 1,
        vat_code: 'OUTPUT_25',
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);

    // input_vat = 5000 (from INPUT_25 debit line)
    // output_vat = 4000 (from OUTPUT_25 credit line on VAT_PAYABLE)
    expect(report.total_input_vat).toBe(5000);
    expect(report.total_output_vat).toBe(4000);
    expect(report.total_payable).toBe(4000 - 5000); // -1000 (net reclaimable)
    expect(report.total_receivable).toBe(5000 - 4000); // 1000
  });

  // ── (c) merkle_root is NULL ────────────────────────────────────────────

  it('(c) merkle_root is NULL on generation', async () => {
    const report = await vatReportService.generate(1);
    expect(report.merkle_root).toBeNull();
  });

  // ── (d) Immutability via triggers ──────────────────────────────────────

  it('(d) raw UPDATE on vat_report is rejected by trigger', async () => {
    const report = await vatReportService.generate(1);

    // Attempt raw update — should be blocked by BEFORE UPDATE trigger
    await expect(
      db
        .updateTable('vat_report')
        .set({ merkle_root: 'fake-hash' })
        .where('id', '=', report.id)
        .execute(),
    ).rejects.toThrow('VAT report is immutable');
  });

  it('(d) raw DELETE on vat_report is rejected by trigger', async () => {
    const report = await vatReportService.generate(1);

    // Attempt raw delete — should be blocked by BEFORE DELETE trigger
    await expect(
      db.deleteFrom('vat_report').where('id', '=', report.id).execute(),
    ).rejects.toThrow('VAT report is immutable');
  });

  // ── (e) Idempotency ────────────────────────────────────────────────────

  it('(e) re-generating returns the same snapshot', async () => {
    const first = await vatReportService.generate(1);
    const second = await vatReportService.generate(1);

    expect(second.id).toBe(first.id);
    expect(second.generated_at).toBe(first.generated_at);
  });

  // ── (f) NotFoundException for unknown period ───────────────────────────

  it('(f) generate throws NotFoundException for unknown period id', async () => {
    await expect(vatReportService.generate(999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('(f) getById throws NotFoundException for unknown report id', async () => {
    await expect(vatReportService.getById(999)).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── (g) Controller 405 on PUT/PATCH/DELETE ─────────────────────────────

  it('(g) PUT /api/vat-reports/:id returns 405', () => {
    expect(() => vatReportController.blockUpdate()).toThrow(
      'VAT report is immutable',
    );
  });

  it('(g) PATCH /api/vat-reports/:id returns 405', () => {
    expect(() => vatReportController.blockPatch()).toThrow(
      'VAT report is immutable',
    );
  });

  it('(g) DELETE /api/vat-reports/:id returns 405', () => {
    expect(() => vatReportController.blockDelete()).toThrow(
      'VAT report is immutable',
    );
  });

  // ── (h) Vouchers outside period are excluded ───────────────────────────

  it('(h) vouchers outside the period date range are excluded', async () => {
    // Voucher inside 2024-Q1
    await seedPostedVoucher('2024-02-15', [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    // Voucher outside 2024-Q1 (April = Q2)
    await seedPostedVoucher('2024-04-15', [
      {
        account_code: 'EXPENSE_RENT',
        amount: 50000,
        currency: 'EUR',
        base_amount: 50000,
        fx_rate: 1,
        vat_code: 'INPUT_20',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 50000,
        currency: 'EUR',
        base_amount: 50000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);

    // Only INPUT_25 should appear (from the Feb voucher)
    expect(report.vat_summary).toHaveLength(1);
    expect(report.vat_summary[0].vat_code).toBe('INPUT_25');
    expect(report.voucher_ids).toHaveLength(1);
  });

  // ── (i) Empty period produces zero totals ──────────────────────────────

  it('(i) empty period produces zero totals and empty summary', async () => {
    const report = await vatReportService.generate(1);

    expect(report.vat_summary).toEqual([]);
    expect(report.total_input_vat).toBe(0);
    expect(report.total_output_vat).toBe(0);
    expect(report.total_payable).toBe(0);
    expect(report.total_receivable).toBe(0);
    expect(report.voucher_ids).toEqual([]);
  });

  // ── (j) getVoucherIds returns the correct list ─────────────────────────

  it('(j) getVoucherIds returns the voucher IDs included in the report', async () => {
    const v1 = await seedPostedVoucher('2024-01-15', [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const v2 = await seedPostedVoucher('2024-02-20', [
      {
        account_code: 'EXPENSE_RENT',
        amount: 20000,
        currency: 'EUR',
        base_amount: 20000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 20000,
        currency: 'EUR',
        base_amount: 20000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);
    const voucherIds = await vatReportService.getVoucherIds(report.id);

    expect(voucherIds).toContain(v1);
    expect(voucherIds).toContain(v2);
    expect(voucherIds).toHaveLength(2);
  });

  // ── (k) Unposted vouchers are excluded ─────────────────────────────────

  it('(k) unposted vouchers (posted_at IS NULL) are excluded', async () => {
    // Insert an unposted voucher
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-UNPOSTED-001',
        tax_point_date: '2024-02-15',
        posted_at: null,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .execute();

    const unpostedVoucher = await db
      .selectFrom('voucher')
      .select('id')
      .where('voucher_number', '=', 'V-UNPOSTED-001')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values({
        voucher_id: unpostedVoucher.id,
        account_id: 1, // CASH
        amount: 99999,
        currency: 'EUR',
        base_amount: 99999,
        fx_rate: 1,
        vat_code: 'SHOULD_NOT_APPEAR',
        is_debit: 1,
      })
      .execute();

    const report = await vatReportService.generate(1);

    // The unposted voucher's line should NOT appear
    const badLine = report.vat_summary.find(
      (l) => l.vat_code === 'SHOULD_NOT_APPEAR',
    );
    expect(badLine).toBeUndefined();
  });
});
