import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';
import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { ConflictException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { StatutoryReportService } from './statutory-report.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { AccountService } from '../ledger/account/account.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { CurrencyService } from '../currency/currency.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { DraftVoucherLine } from '../ledger/voucher/types';
import { validateAgainstKmdXsd } from '../plugins/estonia-kmd/xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';

const xsd = readFileSync(
  join(__dirname, '../../test/fixtures/vatdeclaration.xsd'),
  'utf8',
);

/**
 * Issue #210 — where a reverse-charged acquisition is DECLARED, and what the
 * system does with the ones whose origin the ledger never recorded.
 *
 * Two halves:
 *  - the split itself: an acquisition from a taxable person of another member
 *    state belongs in KMD row 6, one from outside the Community in row 7, and
 *    both survive reversal with the right sign in the same period;
 *  - the legacy code: a voucher carrying `EE_REVERSE_CHARGE` says nothing about
 *    its origin, so it is counted in NEITHER row, it BLOCKS filing (per
 *    voucher, never by cancellation), and it is cleared only by the documented
 *    correction — or, for an acquisition a previous return already declared, by
 *    that return's own evidence.
 *
 * Real DI, real migrations, real EE plugin, real lock/filing services.
 */
describe('Reverse-charge acquisition origin (issue #210)', () => {
  let db: Kysely<Database>;
  let statutory: StatutoryReportService;
  let vatReports: VatReportService;
  let periods: ReportingPeriodsService;
  let submissions: StatutorySubmissionService;
  let organization: OrganizationService;
  let posting: PostingService;

  const PERIOD_ID = 1; // seeded 2024-Q1 (2024-01-01 … 2024-03-31), open
  const IN_PERIOD = '2024-02-15';

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
        OrganizationService,
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        LedgerBalanceService,
        AccountService,
        CurrencyService,
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
        SalesInvoicesService,
        AuditFindingsService,
        AuditLogService,
        VatReportService,
        PrepaymentAllocationRepository,
        StatutorySubmissionService,
        StatutoryReportService,
        ReportingPeriodsService,
      ],
    }).compile();

    statutory = module.get(StatutoryReportService);
    vatReports = module.get(VatReportService);
    periods = module.get(ReportingPeriodsService);
    submissions = module.get(StatutorySubmissionService);
    organization = module.get(OrganizationService);
    posting = module.get(PostingService);

    await organization.updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  const line = (
    account_code: string,
    base_amount: number,
    is_debit: boolean,
    vat_code: string | null,
  ): DraftVoucherLine => ({
    account_code,
    base_amount,
    amount: base_amount,
    is_debit,
    vat_code,
    currency: 'EUR',
    fx_rate: 1,
  });

  /** The four legs a self-assessed acquisition books, under one VAT code. */
  const acquisitionLines = (net: number, code: string): DraftVoucherLine[] => {
    const vat = Math.round(net * 0.24);
    return [
      line('EXPENSE_SOFTWARE', net, true, code),
      line('VAT_RECEIVABLE', vat, true, code),
      line('AP', net, false, null),
      line('VAT_PAYABLE', vat, false, code),
    ];
  };

  async function postAcquisition(
    net: number,
    code: string,
    date = IN_PERIOD,
  ): Promise<number> {
    const posted = await posting.postVoucher({
      tax_point_date: date,
      lines: acquisitionLines(net, code),
    });
    return posted.id;
  }

  /** The mirrored reversal of an acquisition, linked by `reverses_id`. */
  async function postReversal(
    originalId: number,
    net: number,
    code: string,
    date = IN_PERIOD,
  ): Promise<number> {
    const posted = await posting.postVoucher({
      tax_point_date: date,
      reverses_id: originalId,
      lines: acquisitionLines(net, code).map((l) => ({
        ...l,
        is_debit: !l.is_debit,
      })),
    });
    return posted.id;
  }

  const voucherNumber = async (id: number): Promise<string> =>
    (
      await db
        .selectFrom('voucher')
        .select(['voucher_number'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).voucher_number;

  const countRows = async (
    table: 'vat_report' | 'statutory_filing_snapshot',
  ): Promise<number> =>
    (await db.selectFrom(table).selectAll().execute()).length;

  /**
   * A second, LATER open period — the one a correction is redirected into once
   * the original's period has been filed (ADR-0009).
   */
  async function createLaterPeriod(): Promise<number> {
    const row = await db
      .insertInto('reporting_period')
      .values({
        name: '2024-Q2',
        start_date: '2024-04-01',
        end_date: '2024-06-30',
        status: 'open',
        created_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * Fake a period that was FILED by the pre-#210 code: a frozen VAT snapshot
   * covering `voucherIds`, a filing payload whose declaration has no
   * `row6_7_unresolved_acquisition` field (the shape that classifier produced),
   * the period locked and bound, and a `prepared` event pinning both.
   *
   * Written directly, because the current code can no longer produce it — which
   * is exactly the historical state this issue has to keep working with.
   */
  async function fileUnderLegacyPayload(
    periodId: number,
    voucherIds: number[],
    declaredRow7: number,
  ): Promise<void> {
    const snapshot = await db
      .insertInto('vat_report')
      .values({
        reporting_period_id: periodId,
        period_name: '2024-Q1',
        start_date: '2024-01-01',
        end_date: '2024-03-31',
        vat_summary: JSON.stringify([]),
        total_input_vat: 0,
        total_output_vat: 0,
        total_payable: 0,
        total_receivable: 0,
        voucher_ids: JSON.stringify(voucherIds),
        merkle_root: null,
        generated_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const payload = await db
      .insertInto('statutory_filing_snapshot')
      .values({
        reporting_period_id: periodId,
        vat_report_id: snapshot.id,
        report_kind: 'EE_KMD',
        country: 'EE',
        payload: JSON.stringify({
          declarant: { regNumber: '17499653', name: 'Test OÜ' },
          period: {
            name: '2024-Q1',
            startDate: '2024-01-01',
            endDate: '2024-03-31',
          },
          mode: 'final',
          boxes: [],
          declaration: {
            reporting_period_id: periodId,
            period_name: '2024-Q1',
            start_date: '2024-01-01',
            end_date: '2024-03-31',
            row1_base_24: declaredRow7,
            row2_base_reduced: 0,
            row2_base_9: 0,
            row2_base_13: 0,
            row3_base_zero: 0,
            row4_output_vat: 0,
            row5_input_vat: 0,
            row6_intra_eu_acquisition: 0,
            // The defect as it was filed: every reverse charge in row 7.
            row7_other_acquisition: declaredRow7,
            net_vat_due: 0,
            vd_intra_eu_services: 0,
            review_flags: [],
          },
          totals: { totalInputVat: 0, totalOutputVat: 0, totalPayable: 0 },
          salesLines: [],
          purchaseLines: [],
        }),
        reason: 'lock',
        created_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .updateTable('reporting_period')
      .set({
        status: 'locked',
        filed_at: 0,
        vat_report_snapshot_id: snapshot.id,
      })
      .where('id', '=', periodId)
      .execute();

    await db
      .insertInto('statutory_submission_event')
      .values({
        reporting_period_id: periodId,
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: snapshot.id,
        event_kind: 'prepared',
        source_payload_id: payload.id,
        external_ref: null,
        occurred_at: 0,
        actor: 'system',
      })
      .execute();
  }

  // ── the split: row 6 vs row 7 ─────────────────────────────────────────────

  it('declares an intra-EU acquisition in row 6 and a third-country one in row 7, in one period', async () => {
    await postAcquisition(10000, 'EE_REVERSE_CHARGE_EU');
    await postAcquisition(25000, 'EE_REVERSE_CHARGE_3RD_COUNTRY');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    // The reported symptom first: the EU acquisition is NOT in row 7.
    expect(d.row6_intra_eu_acquisition).toBe(10000);
    expect(d.row7_other_acquisition).toBe(25000);
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.unresolved_acquisition_vouchers).toEqual([]);
    // Both are self-assessed supplies: one row-1 base each, not three per leg.
    expect(d.row1_base_24).toBe(35000);
    expect(d.row4_output_vat).toBe(8400);
    expect(d.row5_input_vat).toBe(8400);
    expect(d.net_vat_due).toBe(0);
    expect(d.review_flags).toEqual([]);

    const xml = (await statutory.generate(PERIOD_ID, { formats: ['xml'] }))
      .artifacts[0].content;
    expect(xml).toContain(
      '<euAcquisitionsGoodsAndServicesTotal>100.00</euAcquisitionsGoodsAndServicesTotal>',
    );
    expect(xml).toContain(
      '<acquisitionOtherGoodsAndServicesTotal>250.00</acquisitionOtherGoodsAndServicesTotal>',
    );
    expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });

    const csv = (await statutory.generate(PERIOD_ID, { formats: ['csv'] }))
      .artifacts[0].content;
    const kmd6 = csv.split('\r\n')[0].split(';');
    expect(kmd6[23]).toBe('100.00'); // euAcquisitionsGoodsAndServicesTotal
    expect(kmd6[25]).toBe('250.00'); // acquisitionOtherGoodsAndServicesTotal
  });

  it('reverses each origin against its OWN row, not against the other', async () => {
    const eu = await postAcquisition(10000, 'EE_REVERSE_CHARGE_EU');
    await postAcquisition(25000, 'EE_REVERSE_CHARGE_3RD_COUNTRY');
    await postReversal(eu, 10000, 'EE_REVERSE_CHARGE_EU');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_intra_eu_acquisition).toBe(0);
    expect(d.row7_other_acquisition).toBe(25000);
    expect(d.row1_base_24).toBe(25000);
  });

  // ── the legacy code: unresolved, per voucher ──────────────────────────────

  it('counts a legacy reverse charge in NEITHER row and refuses the filing', async () => {
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_intra_eu_acquisition).toBe(0);
    // The defect: this used to be 10000 in row 7, on no evidence at all.
    expect(d.row7_other_acquisition).toBe(0);
    expect(d.row6_7_unresolved_acquisition).toBe(10000);
    expect(d.unresolved_acquisition_vouchers).toEqual([
      await voucherNumber(legacy),
    ]);
    expect(d.review_flags.join(' ')).toMatch(/row 6 or row 7/);

    // A draft still renders — it is the diagnostic — and omits the cents from
    // both acquisition boxes rather than inventing one.
    const draft = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(draft.artifacts[0].content).not.toContain('euAcquisitions');
    expect(draft.artifacts[0].content).not.toContain('acquisitionOther');
    expect(
      draft.warnings.find((w) => w.code === 'unresolved_acquisition_origin'),
    ).toMatchObject({ blocksFinal: true });

    // The filing itself is refused, and leaves nothing behind.
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
    const period = await periods.getById(PERIOD_ID);
    expect(period.status).toBe('open');
    expect(period.vat_report_snapshot_id).toBeNull();
    expect(await countRows('vat_report')).toBe(0);
    expect(await countRows('statutory_filing_snapshot')).toBe(0);
    expect((await submissions.getState(PERIOD_ID)).history).toEqual([]);
  });

  it('two UNRELATED legacy movements that net to zero are both still unresolved', async () => {
    // +100 on one voucher, −100 on an unrelated one (a legacy reversal of a
    // voucher in some other period). The period total is zero; nothing about
    // either acquisition's row has been established.
    const a = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    const elsewhere = await postAcquisition(
      10000,
      'EE_REVERSE_CHARGE',
      '2023-12-31',
    );
    const b = await postReversal(elsewhere, 10000, 'EE_REVERSE_CHARGE');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.unresolved_acquisition_vouchers).toEqual(
      [await voucherNumber(a), await voucherNumber(b)].sort((x, y) =>
        x.localeCompare(y),
      ),
    );
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
  });

  it('an equal-amount correction elsewhere in the period clears nothing', async () => {
    const elsewhere = await postAcquisition(
      10000,
      'EE_REVERSE_CHARGE',
      '2023-12-31',
    );
    const orphanReversal = await postReversal(
      elsewhere,
      10000,
      'EE_REVERSE_CHARGE',
    );
    // An unrelated corrected voucher, same amount, properly classified. It
    // proves nothing about the reversal above — different chain.
    await posting.postVoucher({
      tax_point_date: IN_PERIOD,
      corrects_object_type: 'expense',
      corrects_object_id: 4242,
      lines: acquisitionLines(10000, 'EE_REVERSE_CHARGE_EU'),
    });

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.unresolved_acquisition_vouchers).toEqual([
      await voucherNumber(orphanReversal),
    ]);
    expect(d.row6_intra_eu_acquisition).toBe(10000);
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
  });

  it('a FULL linked reversal inside the period is neutral on both sides — no replacement needed', async () => {
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.unresolved_acquisition_vouchers).toEqual([]);
    expect(d.row1_base_24).toBe(0);
    expect(d.row4_output_vat).toBe(0);
    expect(d.row5_input_vat).toBe(0);

    // Nothing of unknown origin is left in the period, so it files.
    const locked = await periods.lock(PERIOD_ID);
    expect(locked.status).toBe('locked');
  });

  it('a PARTIAL linked reversal leaves both legs unresolved', async () => {
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    const partial = await postReversal(legacy, 4000, 'EE_REVERSE_CHARGE');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_7_unresolved_acquisition).toBe(6000);
    expect(d.unresolved_acquisition_vouchers).toEqual(
      [await voucherNumber(legacy), await voucherNumber(partial)].sort((x, y) =>
        x.localeCompare(y),
      ),
    );
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
  });

  it('an original with TWO linked reversals clears nothing — the chain is not neutral', async () => {
    // Nothing in the ledger makes `reverses_id` unique. Matching pair-wise,
    // every node here finds a partner; the chain still declares −100 of
    // acquisition nobody can place.
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    const first = await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE');
    const second = await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE');

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_7_unresolved_acquisition).toBe(-10000);
    expect(d.unresolved_acquisition_vouchers).toEqual(
      await Promise.all([legacy, first, second].map(voucherNumber)).then((n) =>
        n.sort((x, y) => x.localeCompare(y)),
      ),
    );
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
  });

  it('a reversal OF a reversal leaves the whole chain unresolved', async () => {
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    const reversal = await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE');
    // Mirrors the reversal, i.e. re-books the acquisition: +100 again.
    const reBooked = await posting.postVoucher({
      tax_point_date: IN_PERIOD,
      reverses_id: reversal,
      lines: acquisitionLines(10000, 'EE_REVERSE_CHARGE'),
    });

    const d = await vatReports.buildDeclaration(PERIOD_ID);
    expect(d.row6_7_unresolved_acquisition).toBe(10000);
    expect(d.unresolved_acquisition_vouchers).toEqual(
      await Promise.all(
        [legacy, reversal, reBooked.id].map(voucherNumber),
      ).then((n) => n.sort((x, y) => x.localeCompare(y))),
    );
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);
  });

  it('a reversal posted in a LATER period does not clear the earlier one', async () => {
    const laterPeriod = await createLaterPeriod();
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE', '2024-05-15');

    // The earlier period still declares an acquisition of unknown origin.
    const earlier = await vatReports.buildDeclaration(PERIOD_ID);
    expect(earlier.row6_7_unresolved_acquisition).toBe(10000);
    expect(earlier.unresolved_acquisition_vouchers).toEqual([
      await voucherNumber(legacy),
    ]);
    await expect(periods.lock(PERIOD_ID)).rejects.toThrow(ConflictException);

    // And the later period's removal is unresolved in its own right: the
    // voucher it reverses never recorded an origin and was never filed.
    const later = await vatReports.buildDeclaration(laterPeriod);
    expect(later.row6_7_unresolved_acquisition).toBe(-10000);
    expect(later.unresolved_acquisition_vouchers).toHaveLength(1);
  });

  // ── the recovery path ─────────────────────────────────────────────────────

  it('a legacy acquisition ALREADY FILED is taken back out of the row that filing used', async () => {
    // Q1 is filed by the old code, with the acquisition inside its covered set.
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    await fileUnderLegacyPayload(PERIOD_ID, [legacy], 10000);

    // The correction is redirected into the open period (ADR-0009): the
    // reversal of the old voucher, plus the replacement carrying the origin.
    const laterPeriod = await createLaterPeriod();
    await postReversal(legacy, 10000, 'EE_REVERSE_CHARGE', '2024-05-15');
    await posting.postVoucher({
      tax_point_date: '2024-05-15',
      corrects_object_type: 'expense',
      corrects_object_id: 77,
      lines: acquisitionLines(10000, 'EE_REVERSE_CHARGE_EU'),
    });

    const d = await vatReports.buildDeclaration(laterPeriod);
    // The removal comes out of row 7 — where the filed return actually put it —
    // and the replacement declares the resolved origin in row 6.
    expect(d.row7_other_acquisition).toBe(-10000);
    expect(d.row6_intra_eu_acquisition).toBe(10000);
    expect(d.row6_7_unresolved_acquisition).toBe(0);
    expect(d.unresolved_acquisition_vouchers).toEqual([]);
    expect(d.review_flags.join(' ')).toMatch(/row 7/);

    const locked = await periods.lock(laterPeriod);
    expect(locked.status).toBe('locked');

    // The already-filed Q1 payload is untouched and still renders as filed.
    const q1 = await statutory.generate(PERIOD_ID, { formats: ['xml'] });
    expect(q1.artifacts[0].content).toContain(
      '<acquisitionOtherGoodsAndServicesTotal>100.00</acquisitionOtherGoodsAndServicesTotal>',
    );
  });

  it('an old filed snapshot that did NOT cover the voucher proves nothing', async () => {
    // Same filed period — but its snapshot's covered set leaves the voucher
    // out, which is exactly the incomplete-snapshot state of issue #200. The
    // amount was never filed, so it cannot be taken back out of a filed row.
    const legacy = await postAcquisition(10000, 'EE_REVERSE_CHARGE');
    const unrelated = await postAcquisition(
      500,
      'EE_REVERSE_CHARGE_EU',
      '2024-02-16',
    );
    await fileUnderLegacyPayload(PERIOD_ID, [unrelated], 0);

    const laterPeriod = await createLaterPeriod();
    const reversal = await postReversal(
      legacy,
      10000,
      'EE_REVERSE_CHARGE',
      '2024-05-15',
    );

    const d = await vatReports.buildDeclaration(laterPeriod);
    expect(d.row7_other_acquisition).toBe(0);
    expect(d.row6_7_unresolved_acquisition).toBe(-10000);
    expect(d.unresolved_acquisition_vouchers).toEqual([
      await voucherNumber(reversal),
    ]);
    await expect(periods.lock(laterPeriod)).rejects.toThrow(ConflictException);
  });
});
