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
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { OrganizationService } from '../organization/organization.service';

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
  let organizationService: OrganizationService;

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
        LedgerBalanceService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrganizationService,
        VatReportService,
        VatReportController,
      ],
      controllers: [VatReportController],
    }).compile();

    vatReportService = module.get(VatReportService);
    vatReportController = module.get(VatReportController);
    organizationService = module.get(OrganizationService);
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
    // Voucher 1: purchase (debit). The INPUT_25 code is on BOTH the net expense
    // line and the VAT_RECEIVABLE line (as the real pipeline books it), but the
    // VAT *amount* is only the VAT_RECEIVABLE line — the report must not count
    // the 10000 taxable base as input VAT.
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
        account_code: 'VAT_RECEIVABLE',
        amount: 2500,
        currency: 'EUR',
        base_amount: 2500,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 12500,
        currency: 'EUR',
        base_amount: 12500,
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
    expect(inputLine!.input_vat).toBe(2500);
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
        amount: 20000,
        currency: 'EUR',
        base_amount: 20000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'VAT_RECEIVABLE',
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 25000,
        currency: 'EUR',
        base_amount: 25000,
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

  // ── (c) Merkle root over covered Vouchers ──────────────────────────────

  it('(c) computes a non-null deterministic Merkle root, stable across regeneration', async () => {
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
        account_code: 'VAT_RECEIVABLE',
        amount: 2500,
        currency: 'EUR',
        base_amount: 2500,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 12500,
        currency: 'EUR',
        base_amount: 12500,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const first = await vatReportService.generate(1);
    expect(first.merkle_root).not.toBeNull();
    expect(first.merkle_root).toMatch(/^[0-9a-f]{64}$/);

    // Idempotent: re-generating returns the SAME frozen root (never recomputed).
    const second = await vatReportService.generate(1);
    expect(second.merkle_root).toBe(first.merkle_root);
  });

  it('(c) empty period yields a null Merkle root', async () => {
    const report = await vatReportService.generate(1);
    expect(report.merkle_root).toBeNull();
  });

  it('(c) single-voucher period yields a non-null root equal to that voucher leaf hash', async () => {
    await seedPostedVoucher('2024-01-10', [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 8000,
        currency: 'EUR',
        base_amount: 8000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 8000,
        currency: 'EUR',
        base_amount: 8000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);
    expect(report.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(report.voucher_ids).toHaveLength(1);
  });

  it('(c) Merkle root differs when the covered voucher set differs (different period)', async () => {
    // Seed a second reporting period (2024-Q2) — only Q1 is seeded by migration.
    await db
      .insertInto('reporting_period')
      .values({
        name: '2024-Q2',
        start_date: '2024-04-01',
        end_date: '2024-06-30',
        status: 'open',
        created_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    // Q1 voucher
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
    // Q2 voucher
    await seedPostedVoucher('2024-05-15', [
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

    const q1 = await vatReportService.generate(1); // 2024-Q1
    const q2 = await vatReportService.generate(2); // 2024-Q2
    expect(q1.merkle_root).not.toBeNull();
    expect(q2.merkle_root).not.toBeNull();
    expect(q1.merkle_root).not.toBe(q2.merkle_root);
  });

  // ── (c2) Coverage: a VAT-less Voucher is covered but ignored by boxes ───

  it('(c2) a VAT-less Voucher in the period is covered (Merkle leaf) yet excluded from box amounts', async () => {
    // Voucher WITH a VAT-control line.
    const withVat = await seedPostedVoucher('2024-02-15', [
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
        account_code: 'VAT_RECEIVABLE',
        amount: 2500,
        currency: 'EUR',
        base_amount: 2500,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 12500,
        currency: 'EUR',
        base_amount: 12500,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    // Voucher with NO VAT-control line (pure cash transfer, no VAT_* account).
    const noVat = await seedPostedVoucher('2024-03-01', [
      {
        account_code: 'CASH',
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: null,
        is_debit: true,
      },
      {
        account_code: 'BANK_EUR',
        amount: 5000,
        currency: 'EUR',
        base_amount: 5000,
        fx_rate: 1,
        vat_code: null,
        is_debit: false,
      },
    ]);

    const report = await vatReportService.generate(1);

    // COVERAGE: both vouchers are covered (Merkle leaves + voucher_ids).
    expect(report.voucher_ids).toContain(withVat);
    expect(report.voucher_ids).toContain(noVat);
    expect(report.voucher_ids).toHaveLength(2);
    expect(report.merkle_root).toMatch(/^[0-9a-f]{64}$/);

    // BOX AMOUNTS: only the VAT-control line contributes — the VAT-less
    // voucher adds nothing to input/output VAT.
    expect(report.total_input_vat).toBe(2500);
    expect(report.total_output_vat).toBe(0);
    expect(report.vat_summary).toHaveLength(1);
    expect(report.vat_summary[0].vat_code).toBe('INPUT_25');
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

  // ── (h) Preview: read-only, never freezes ──────────────────────────────

  describe('preview (read-only)', () => {
    it('computes the same figures as generate WITHOUT storing a snapshot', async () => {
      const preview = await vatReportService.preview(1);

      // Nothing was frozen.
      expect(preview.frozen_snapshot_id).toBeNull();
      const stored = await db
        .selectFrom('vat_report')
        .selectAll()
        .where('reporting_period_id', '=', 1)
        .execute();
      expect(stored).toHaveLength(0);

      // ...and the figures match what generate would freeze.
      const generated = await vatReportService.generate(1);
      expect(preview.total_input_vat).toBe(generated.total_input_vat);
      expect(preview.total_output_vat).toBe(generated.total_output_vat);
      expect(preview.total_payable).toBe(generated.total_payable);
      expect(preview.total_receivable).toBe(generated.total_receivable);
      expect(preview.merkle_root).toBe(generated.merkle_root);
      expect(preview.voucher_ids).toEqual(generated.voucher_ids);
    });

    it('recomputes live once a snapshot exists, and points at the frozen one', async () => {
      const frozen = await vatReportService.generate(1);

      const preview = await vatReportService.preview(1);
      // The caller can see that a frozen snapshot is already in the way —
      // this is exactly the drift that a re-run of generate() would hide.
      expect(preview.frozen_snapshot_id).toBe(frozen.id);
      expect(preview.total_input_vat).toBe(frozen.total_input_vat);
    });

    it('throws NotFoundException for an unknown period id', async () => {
      await expect(vatReportService.preview(999)).rejects.toThrow(
        NotFoundException,
      );
    });
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

  // ── (i) List all VAT reports ───────────────────────────────────────────

  it('(i) list() returns an empty array when no reports exist', async () => {
    await expect(vatReportService.list()).resolves.toEqual([]);
  });

  it('(i) list() returns every generated VAT report, mapped, period order', async () => {
    // Only Q1 is seeded by migration — add Q2.
    await db
      .insertInto('reporting_period')
      .values({
        name: '2024-Q2',
        start_date: '2024-04-01',
        end_date: '2024-06-30',
        status: 'open',
        created_at: Math.floor(Date.now() / 1000),
      })
      .execute();
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
    await seedPostedVoucher('2024-05-15', [
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
    const q1 = await vatReportService.generate(1);
    const q2 = await vatReportService.generate(2);

    const all = await vatReportService.list();
    expect(all).toHaveLength(2);
    // Ordered by reporting_period_id: Q1 (period 1) before Q2 (period 2).
    expect(all.map((r) => r.id)).toEqual([q1.id, q2.id]);
    expect(all[0].period_name).toBe('2024-Q1');
    expect(all[1].period_name).toBe('2024-Q2');
    // Mapped shape preserved (JSON columns parsed to arrays).
    expect(Array.isArray(all[0].vat_summary)).toBe(true);
    expect(Array.isArray(all[0].voucher_ids)).toBe(true);
  });

  it('(i) GET /api/vat-reports lists reports via the controller', async () => {
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
    await vatReportService.generate(1);

    const res = await vatReportController.list();
    expect(res.vat_reports).toHaveLength(1);
    expect(res.vat_reports[0].period_name).toBe('2024-Q1');
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
        amount: 8000,
        currency: 'EUR',
        base_amount: 8000,
        fx_rate: 1,
        vat_code: 'INPUT_25',
        is_debit: true,
      },
      {
        account_code: 'VAT_RECEIVABLE',
        amount: 2000,
        currency: 'EUR',
        base_amount: 2000,
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

  // ── (l) KMD declaration view (derived, EE) ─────────────────────────────

  describe('(l) buildDeclaration — Estonian KMD rows', () => {
    beforeEach(async () => {
      await organizationService.updateOrganization({ country: 'EE' });
    });

    it('maps reverse charge to rows 1/4/5/7 with a 6-vs-7 review flag', async () => {
      // Imported service self-assessed at 24% of 1600 = 384, net cash zero.
      await seedPostedVoucher('2024-02-15', [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 1600,
          currency: 'EUR',
          base_amount: 1600,
          fx_rate: 1,
          vat_code: 'EE_REVERSE_CHARGE',
          is_debit: true,
        },
        {
          account_code: 'VAT_RECEIVABLE',
          amount: 384,
          currency: 'EUR',
          base_amount: 384,
          fx_rate: 1,
          vat_code: 'EE_REVERSE_CHARGE',
          is_debit: true,
        },
        {
          account_code: 'AP',
          amount: 1600,
          currency: 'EUR',
          base_amount: 1600,
          fx_rate: 1,
          vat_code: null,
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 384,
          currency: 'EUR',
          base_amount: 384,
          fx_rate: 1,
          vat_code: 'EE_REVERSE_CHARGE',
          is_debit: false,
        },
      ]);

      const d = await vatReportService.buildDeclaration(1);

      expect(d.row1_base_24).toBe(1600); // self-assessed received supply
      expect(d.row7_other_acquisition).toBe(1600); // default acquisition row
      expect(d.row4_output_vat).toBe(384);
      expect(d.row5_input_vat).toBe(384);
      expect(d.net_vat_due).toBe(0); // output == input, cash neutral
      expect(d.review_flags.some((f) => /row 6.*7/i.test(f))).toBe(true);
    });

    it('maps a 0% intra-EU service sale to row 3 + VD 3S reminder', async () => {
      // A 0% supply books no VAT leg (amount > 0 CHECK forbids a zero line), so
      // the posted voucher is just Dr AR / Cr REVENUE(0%-rated base).
      await seedPostedVoucher('2024-03-01', [
        {
          account_code: 'AR',
          amount: 615700,
          currency: 'EUR',
          base_amount: 615700,
          fx_rate: 1,
          vat_code: null,
          is_debit: true,
        },
        {
          account_code: 'REVENUE',
          amount: 615700,
          currency: 'EUR',
          base_amount: 615700,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_0_EU',
          is_debit: false,
        },
      ]);

      const d = await vatReportService.buildDeclaration(1);

      expect(d.row3_base_zero).toBe(615700);
      expect(d.row1_base_24).toBe(0); // NOT standard-rate output
      expect(d.vd_intra_eu_services).toBe(615700);
      expect(d.review_flags.some((f) => /VD koondaruanne.*3S/i.test(f))).toBe(
        true,
      );
    });

    it('maps a standard 24% domestic sale to row 1 + row 4', async () => {
      await seedPostedVoucher('2024-01-20', [
        {
          account_code: 'AR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
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
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
      ]);

      const d = await vatReportService.buildDeclaration(1);
      expect(d.row1_base_24).toBe(10000);
      expect(d.row4_output_vat).toBe(2400);
      expect(d.net_vat_due).toBe(2400);
      expect(d.review_flags).toEqual([]);
    });

    it('throws NotFoundException for an unknown period', async () => {
      await expect(vatReportService.buildDeclaration(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
