import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PostingService } from '../ledger/posting/posting.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { AnnualAccountsService } from './annual-accounts.service';
import type { DraftVoucher } from '../ledger/voucher/types';

/**
 * Issue #207 — closing a FINANCIAL YEAR while the twelve monthly VAT periods
 * inside it are filed, against a real migrated SQLite database and the real
 * services (posting, period lock, VAT snapshots, statutory export, the Estonia
 * plugin).
 *
 * This is the scenario the issue says is impossible today, end to end: a normal
 * monthly tax calendar for 2026, every month filed, and then the annual accounts
 * for the financial year 2026 — with the comparative column being 2025 and the
 * December return left exactly as it was frozen.
 */
describe('Annual close over a filed monthly VAT calendar (integration)', () => {
  let db: Kysely<Database>;
  let annual: AnnualAccountsService;
  let periods: ReportingPeriodsService;
  let posting: PostingService;
  let vatReport: VatReportService;
  let statutory: StatutoryReportService;

  /** A plain two-legged EUR draft, posted through the real write path. */
  function draft(
    taxPointDate: string,
    lines: Array<{
      code: string;
      isDebit: boolean;
      base: number;
      vatCode?: string;
    }>,
    reason?: string,
  ): DraftVoucher {
    return {
      tax_point_date: taxPointDate,
      reason,
      lines: lines.map((l) => ({
        account_code: l.code,
        is_debit: l.isDebit,
        amount: l.base,
        currency: 'EUR',
        base_amount: l.base,
        fx_rate: 1,
        fx_rate_source: IDENTITY_RATE_SOURCE,
        vat_code: l.vatCode ?? null,
      })),
    };
  }

  function monthsOf(
    year: number,
  ): Array<{ name: string; start: string; end: string }> {
    return Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      const last = new Date(Date.UTC(year, i + 1, 0))
        .toISOString()
        .slice(8, 10);
      return {
        name: `${year}-${m}`,
        start: `${year}-${m}-01`,
        end: `${year}-${m}-${last}`,
      };
    });
  }

  function periodId(name: string): Promise<number> {
    return db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  }

  /** The XBRL fact for a concept in a context, as a number. */
  function fact(xbrl: string, concept: string, ctx: string): number {
    const m = xbrl.match(
      new RegExp(
        `<${concept} contextRef="${ctx}"[^>]*>(-?[\\d.]+)</${concept}>`,
      ),
    );
    if (!m) throw new Error(`fact ${concept}@${ctx} not found in XBRL`);
    return Number(m[1]);
  }

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

    await db
      .updateTable('organization')
      .set({
        name: 'Test OÜ',
        country: 'EE',
        base_currency: 'EUR',
        vat_registered: 1,
        vat_registration_number: 'EE123456789',
        registry_code: '17499653',
      } as never)
      .execute();

    // Migration 011 seeds a stray open 2024-Q1 — the fixture below is complete.
    await db.deleteFrom('reporting_period').execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        AccountService,
        LedgerValidationService,
        PeriodLockService,
        PostingService,
        VatReportService,
        AuditLogService,
        StatutorySubmissionService,
        StatutoryReportService,
        AuditFindingsService,
        ReportingPeriodsService,
        AnnualAccountsService,
      ],
    }).compile();
    annual = module.get(AnnualAccountsService);
    periods = module.get(ReportingPeriodsService);
    posting = module.get(PostingService);
    vatReport = module.get(VatReportService);
    statutory = module.get(StatutoryReportService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /**
   * The shared fixture: financial years 2025 and 2026, the twelve 2026 months,
   * a van capitalized in 2025, 2025 trading, 2026 trading.
   */
  async function seedTwoYears(): Promise<void> {
    await periods.create({
      name: 'FY2025',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
      kind: 'annual',
    });
    await periods.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    for (const m of monthsOf(2026)) {
      await periods.create({
        name: m.name,
        start_date: m.start,
        end_date: m.end,
      });
    }

    // 2025: capital, a van, and a profit of 10000.
    await posting.postVoucher(
      draft('2025-01-02', [
        { code: 'BANK_EUR', isDebit: true, base: 50000 },
        { code: 'EQUITY', isDebit: false, base: 50000 },
      ]),
    );
    const acq = await posting.postVoucher(
      draft('2025-01-10', [
        { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
        { code: 'BANK_EUR', isDebit: false, base: 20000 },
      ]),
    );
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acq.id,
        acquisition_date: '2025-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    await posting.postVoucher(
      draft('2025-06-01', [
        { code: 'BANK_EUR', isDebit: true, base: 10000 },
        { code: 'REVENUE', isDebit: false, base: 10000 },
      ]),
    );

    // 2026: a VAT-bearing sale in March and an expense in October.
    await posting.postVoucher(
      draft('2026-03-15', [
        { code: 'BANK_EUR', isDebit: true, base: 12400 },
        {
          code: 'REVENUE',
          isDebit: false,
          base: 10000,
          vatCode: 'EE_STANDARD_24',
        },
        {
          code: 'VAT_PAYABLE',
          isDebit: false,
          base: 2400,
          vatCode: 'EE_STANDARD_24',
        },
      ]),
    );
    await posting.postVoucher(
      draft('2026-10-05', [
        { code: 'EXPENSE_OTHER', isDebit: true, base: 3000 },
        { code: 'BANK_EUR', isDebit: false, base: 3000 },
      ]),
    );
  }

  /** File all twelve 2026 VAT periods, in order. */
  async function fileAllMonths(): Promise<void> {
    for (const m of monthsOf(2026)) {
      await periods.lock(await periodId(m.name));
    }
  }

  it('closes the financial year with every month filed, leaving the filed returns byte-identical', async () => {
    await seedTwoYears();
    await periods.closeFinancialYear(await periodId('FY2025'));
    await fileAllMonths();

    const decId = await periodId('2026-12');
    const marId = await periodId('2026-03');
    const snapshotsBefore = await db
      .selectFrom('vat_report')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();
    const eventsBefore = await db
      .selectFrom('statutory_submission_event')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();
    const payloadsBefore = await db
      .selectFrom('statutory_filing_snapshot')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();

    const fyId = await periodId('FY2026');
    const result = await annual.finalize(fyId);
    expect(result.artifacts).toHaveLength(1);

    // ── The year-end adjustment was posted, dated inside the FILED December,
    //    and stamped server-side as belonging to this year's close. ──
    const closeVouchers = await db
      .selectFrom('voucher')
      .selectAll()
      .where('annual_close_period_id', '=', fyId)
      .execute();
    expect(closeVouchers).toHaveLength(1);
    expect(closeVouchers[0].tax_point_date).toBe('2026-12-31');
    expect(closeVouchers[0].reason).toBe(
      'Annual depreciation charge for FY2026',
    );

    // ── Every frozen VAT artifact is exactly as it was. Nothing was re-frozen,
    //    superseded, rebound or appended to. ──
    expect(
      await db
        .selectFrom('vat_report')
        .selectAll()
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(snapshotsBefore);
    expect(
      await db
        .selectFrom('statutory_submission_event')
        .selectAll()
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(eventsBefore);
    expect(
      await db
        .selectFrom('statutory_filing_snapshot')
        .selectAll()
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(payloadsBefore);

    // ── And they still DESCRIBE the ledger: the live December figures match the
    //    frozen ones, so the statutory export raises no drift. ──
    const decFrozen = snapshotsBefore.find(
      (s) => s.reporting_period_id === decId,
    );
    const decLive = await vatReport.preview(decId);
    expect(decLive.merkle_root).toBe(decFrozen?.merkle_root ?? null);
    expect(decLive.voucher_ids).toEqual(
      JSON.parse(decFrozen?.voucher_ids ?? '[]'),
    );
    const decExport = await statutory.generate(decId, { formats: ['xml'] });
    expect(decExport.warnings.map((w) => w.code)).not.toContain(
      'filing_snapshot_drift',
    );

    // The March return (the one with real VAT) is untouched too, figures and all.
    const marLive = await vatReport.preview(marId);
    expect(marLive.total_output_vat).toBe(2400);

    // ── The year is closed, and closing it minted no KMD of its own. ──
    const fy = await periods.getById(fyId);
    expect(fy.status).toBe('locked');
    expect(fy.vat_report_snapshot_id).toBeNull();
    expect(
      await db
        .selectFrom('vat_report')
        .selectAll()
        .where('reporting_period_id', '=', fyId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('statutory_submission_event')
        .selectAll()
        .where('reporting_period_id', '=', fyId)
        .execute(),
    ).toHaveLength(0);

    // ── The use of the year-end route is recorded, not silent. ──
    const findings = await db.selectFrom('audit_finding').selectAll().execute();
    expect(
      findings.some(
        (f) =>
          f.description.includes('Year-end adjustment') &&
          f.description.includes('2026-12'),
      ),
    ).toBe(true);
  });

  it('compares the year against the previous FINANCIAL YEAR, not the nearest month', async () => {
    // A company that changed its fiscal year: the old July–June year ended
    // 2025-06-30, the new calendar financial year is 2026, and the monthly VAT
    // calendar ran straight through the gap between them. "The latest period
    // ending before the year starts" is therefore December 2025 — a MONTH —
    // and picking it would file 2026 against a one-month comparative column.
    await periods.create({
      name: 'FY2024/25',
      start_date: '2024-07-01',
      end_date: '2025-06-30',
      kind: 'annual',
    });
    await periods.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    for (const m of [...monthsOf(2025).slice(6), ...monthsOf(2026)]) {
      await periods.create({
        name: m.name,
        start_date: m.start,
        end_date: m.end,
      });
    }

    // Trading inside the old fiscal year, and inside 2026.
    await posting.postVoucher(
      draft('2025-03-01', [
        { code: 'BANK_EUR', isDebit: true, base: 10000 },
        { code: 'REVENUE', isDebit: false, base: 10000 },
      ]),
    );
    await posting.postVoucher(
      draft('2026-03-15', [
        { code: 'BANK_EUR', isDebit: true, base: 5000 },
        { code: 'REVENUE', isDebit: false, base: 5000 },
      ]),
    );

    await periods.closeFinancialYear(await periodId('FY2024/25'));
    const xbrl = (await annual.generate(await periodId('FY2026'))).artifacts[0]
      .content;

    // The comparative column is the previous FINANCIAL YEAR, whole and entire…
    expect(xbrl).toContain('d-2024-07-01_2025-06-30');
    expect(xbrl).toContain('i-2025-06-30');
    // …and not the nearest earlier VAT period, which covers December alone.
    expect(xbrl).not.toContain('d-2025-12-01_2025-12-31');
    expect(xbrl).not.toContain('i-2025-12-31');

    // The prior column carries the old fiscal year's result (10000 minor = €100,
    // reported in euros, #204), which the current year's brought-forward equity
    // then carries forward (#206) — so both columns still balance.
    expect(
      fact(
        xbrl,
        'et-gaap:TotalAnnualPeriodProfitLoss',
        'd-2024-07-01_2025-06-30',
      ),
    ).toBe(100);
    expect(fact(xbrl, 'et-gaap:Assets', 'i-2026-12-31')).toBe(
      fact(xbrl, 'et-gaap:LiabilitiesAndEquity', 'i-2026-12-31'),
    );
    expect(fact(xbrl, 'et-gaap:Assets', 'i-2025-06-30')).toBe(
      fact(xbrl, 'et-gaap:LiabilitiesAndEquity', 'i-2025-06-30'),
    );
  });

  it('charges the year once however often the close is run or the report re-read (#205)', async () => {
    await seedTwoYears();
    await periods.closeFinancialYear(await periodId('FY2025'));
    await fileAllMonths();
    const fyId = await periodId('FY2026');

    const finalXbrl = (await annual.finalize(fyId)).artifacts[0].content;
    const charge = fact(
      finalXbrl,
      'et-gaap:DepreciationAndImpairmentLossReversal',
      'd-2026-01-01_2026-12-31',
    );
    // 20000 minor / 5 years = 4000 minor a year, reported in euros as a
    // credit-signed −40.00 (#204).
    expect(charge).toBe(-40);
    const closeLines = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['a.code', 'vl.base_amount', 'vl.is_debit'])
      .where('v.annual_close_period_id', '=', fyId)
      .execute();
    expect(closeLines).toEqual(
      expect.arrayContaining([
        { code: 'DEPRECIATION_EXPENSE', base_amount: 4000, is_debit: 1 },
        { code: 'ACCUM_DEPRECIATION_VEHICLES', base_amount: 4000, is_debit: 0 },
      ]),
    );

    // A repeat DRAFT of the closed year reads the same figure — the charge is
    // posted now, so nothing more is virtualized on top of it.
    const again = (await annual.generate(fyId)).artifacts[0].content;
    expect(
      fact(
        again,
        'et-gaap:DepreciationAndImpairmentLossReversal',
        'd-2026-01-01_2026-12-31',
      ),
    ).toBe(charge);
    expect(
      await db
        .selectFrom('voucher')
        .selectAll()
        .where('annual_close_period_id', '=', fyId)
        .execute(),
    ).toHaveLength(1);

    // And the close is one-shot.
    await expect(annual.finalize(fyId)).rejects.toThrow(/already finalized/i);
  });

  it('does not re-charge depreciation when the close fails after the adjustment is committed (#205)', async () => {
    await seedTwoYears();
    await periods.closeFinancialYear(await periodId('FY2025'));
    await fileAllMonths();
    const fyId = await periodId('FY2026');
    const snapshotsBefore = await db
      .selectFrom('vat_report')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();

    // The year-end adjustment is posted in its own transaction, before the
    // status flip — the flip cannot be folded into it (better-sqlite3 has one
    // connection). So the realistic failure is: adjustment committed, close
    // threw. The retry must NOT charge the year a second time.
    const close = jest
      .spyOn(periods, 'closeFinancialYear')
      .mockRejectedValueOnce(
        new Error('close failed after the charge was posted'),
      );

    await expect(annual.finalize(fyId)).rejects.toThrow(/close failed/);
    close.mockRestore();

    const afterFailure = await db
      .selectFrom('voucher')
      .selectAll()
      .where('annual_close_period_id', '=', fyId)
      .execute();
    expect(afterFailure).toHaveLength(1);
    expect((await periods.getById(fyId)).status).toBe('open');

    // The retry succeeds, and charges nothing further: the posted adjustment is
    // netted out of what remains to book, so the year is charged exactly once.
    const xbrl = (await annual.finalize(fyId)).artifacts[0].content;
    expect(
      fact(
        xbrl,
        'et-gaap:DepreciationAndImpairmentLossReversal',
        'd-2026-01-01_2026-12-31',
      ),
    ).toBe(-40);
    expect(
      await db
        .selectFrom('voucher')
        .selectAll()
        .where('annual_close_period_id', '=', fyId)
        .execute(),
    ).toHaveLength(1);
    expect((await periods.getById(fyId)).status).toBe('locked');
    // And the filed returns are still exactly as frozen, across both attempts.
    expect(
      await db
        .selectFrom('vat_report')
        .selectAll()
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(snapshotsBefore);
  });

  it('seals the whole year once it is closed — ordinary postings into it are rejected', async () => {
    await seedTwoYears();
    await periods.closeFinancialYear(await periodId('FY2025'));
    // Deliberately file only January: the rest of 2026 stays OPEN as VAT periods.
    await periods.lock(await periodId('2026-01'));
    const fyId = await periodId('FY2026');
    await annual.finalize(fyId);

    // A month that is still an open VAT period, inside the closed year.
    expect((await periods.getById(await periodId('2026-07'))).status).toBe(
      'open',
    );
    await expect(
      posting.postVoucher(
        draft('2026-07-10', [
          { code: 'EXPENSE_OTHER', isDebit: true, base: 100 },
          { code: 'BANK_EUR', isDebit: false, base: 100 },
        ]),
      ),
    ).rejects.toThrow(/closed financial year FY2026/i);

    // …and so is a further year-end adjustment claiming the closed year.
    await expect(
      posting.postVoucher(
        draft('2026-12-31', [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 100 },
          { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 100 },
        ]),
        { kind: 'annual-close', financialYearId: fyId },
      ),
    ).rejects.toThrow(/closed/i);
  });

  describe('the year-end route is a validated capability, not a claim', () => {
    let fyId: number;

    beforeEach(async () => {
      await seedTwoYears();
      await periods.closeFinancialYear(await periodId('FY2025'));
      await fileAllMonths();
      fyId = await periodId('FY2026');
    });

    it('refuses an account outside the year-end adjustment whitelist', async () => {
      await expect(
        posting.postVoucher(
          draft('2026-12-31', [
            { code: 'BANK_EUR', isDebit: true, base: 100 },
            { code: 'REVENUE', isDebit: false, base: 100 },
          ]),
          { kind: 'annual-close', financialYearId: fyId },
        ),
      ).rejects.toThrow(/may only touch/i);
    });

    it('refuses VAT metadata on a whitelisted account', async () => {
      await expect(
        posting.postVoucher(
          draft('2026-12-31', [
            {
              code: 'DEPRECIATION_EXPENSE',
              isDebit: true,
              base: 100,
              vatCode: 'EE_STANDARD_24',
            },
            { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 100 },
          ]),
          { kind: 'annual-close', financialYearId: fyId },
        ),
      ).rejects.toThrow(/VAT metadata/i);
    });

    it('refuses a date outside the declared financial year', async () => {
      await expect(
        posting.postVoucher(
          draft('2025-12-31', [
            { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 100 },
            { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 100 },
          ]),
          { kind: 'annual-close', financialYearId: fyId },
        ),
      ).rejects.toThrow(/outside financial year/i);
    });

    it('refuses a VAT period passed off as a financial year', async () => {
      const decId = await periodId('2026-12');
      await expect(
        posting.postVoucher(
          draft('2026-12-31', [
            { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 100 },
            { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 100 },
          ]),
          { kind: 'annual-close', financialYearId: decId },
        ),
      ).rejects.toThrow(/not a financial year/i);
    });

    it('still refuses an ORDINARY posting into the filed December', async () => {
      await expect(
        posting.postVoucher(
          draft('2026-12-31', [
            { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 100 },
            { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 100 },
          ]),
        ),
      ).rejects.toThrow(/locked period 2026-12/i);
    });

    it('leaves no annual-close mark on an ordinary voucher', async () => {
      const posted = await posting.postVoucher(
        draft('2027-01-05', [
          { code: 'EXPENSE_OTHER', isDebit: true, base: 100 },
          { code: 'BANK_EUR', isDebit: false, base: 100 },
        ]),
      );
      const row = await db
        .selectFrom('voucher')
        .selectAll()
        .where('id', '=', posted.id)
        .executeTakeFirstOrThrow();
      expect(row.annual_close_period_id).toBeNull();
    });
  });

  it('does not charge the year twice when a legacy full-year VAT period already closed it', async () => {
    // THE TRANSITION CASE. Before financial years existed, the only way to run
    // the annual accounts was over a full-year VAT period — so an upgraded
    // database can hold a legacy "2026" VAT period that was already finalized,
    // with the year's depreciation posted under ITS name. Creating the proper
    // financial year over the same dates must not re-charge the year.
    await periods.create({
      name: '2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    await posting.postVoucher(
      draft('2026-01-02', [
        { code: 'BANK_EUR', isDebit: true, base: 50000 },
        { code: 'EQUITY', isDebit: false, base: 50000 },
      ]),
    );
    const acq = await posting.postVoucher(
      draft('2026-01-10', [
        { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
        { code: 'BANK_EUR', isDebit: false, base: 20000 },
      ]),
    );
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acq.id,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();

    // The legacy close: annual accounts over the VAT period, which posts the
    // year's charge under the reason "Annual depreciation charge for 2026".
    await annual.finalize(await periodId('2026'));
    const legacyCharge = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .where('v.reason', '=', 'Annual depreciation charge for 2026')
      .execute();
    expect(legacyCharge).toEqual([{ base_amount: 4000 }]);

    // Now the operator adopts the financial-year scope for the same year.
    const fyId = (
      await periods.create({
        name: 'FY2026',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        kind: 'annual',
      })
    ).id;

    // The draft must read the charge the ledger already carries — once.
    const xbrl = (await annual.generate(fyId)).artifacts[0].content;
    expect(
      fact(
        xbrl,
        'et-gaap:DepreciationAndImpairmentLossReversal',
        'd-2026-01-01_2026-12-31',
      ),
    ).toBe(-40);

    // And finalizing the year must post no second charge.
    await annual.finalize(fyId);
    const allCharges = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'v.reason'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .execute();
    expect(allCharges).toEqual([
      { base_amount: 4000, reason: 'Annual depreciation charge for 2026' },
    ]);
  });

  it("does not net the PREVIOUS year's close out of this year's charge", async () => {
    // The counterpart of the transition case: recognition is per YEAR. FY2025's
    // own close is posted on 2025-12-31 and is already reflected in the opening
    // accumulated depreciation, so it must not be subtracted from what 2026
    // still has to charge — which is what a window open at the start would do.
    await seedTwoYears();
    const fy2025 = await periodId('FY2025');
    await annual.finalize(fy2025);
    expect(
      await db
        .selectFrom('voucher')
        .selectAll()
        .where('annual_close_period_id', '=', fy2025)
        .execute(),
    ).toHaveLength(1);

    const xbrl = (await annual.generate(await periodId('FY2026'))).artifacts[0]
      .content;
    // A full second year of the van: 20000 / 5 = 4000 minor = €40.
    expect(
      fact(
        xbrl,
        'et-gaap:DepreciationAndImpairmentLossReversal',
        'd-2026-01-01_2026-12-31',
      ),
    ).toBe(-40);
  });

  it('refuses to produce a VAT declaration or a KMD export for a financial year', async () => {
    await seedTwoYears();
    const fyId = await periodId('FY2026');

    await expect(vatReport.generate(fyId)).rejects.toThrow(/financial year/i);
    await expect(vatReport.preview(fyId)).rejects.toThrow(/financial year/i);
    await expect(vatReport.buildDeclaration(fyId)).rejects.toThrow(
      /financial year/i,
    );
    await expect(
      statutory.generate(fyId, { formats: ['xml'] }),
    ).rejects.toThrow(/financial year/i);
  });
});
