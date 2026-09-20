import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AnnualAccountsService } from '../annual-accounts/annual-accounts.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DepreciationAttributionService } from './depreciation-attribution.service';
import { FixedAssetsService } from './fixed-assets.service';
import type { DraftVoucher } from '../ledger/voucher/types';

/**
 * Issue #208 — disposing of an asset AFTER a year-end close must not re-charge
 * the depreciation that close already posted.
 *
 * Real migrated SQLite, the real posting/period-lock/annual-close services and
 * the real disposal path. The arithmetic is the issue's own: a EUR 1,200 IT
 * asset acquired 2026-01-01 over 4 years with no residual depreciates EUR 300 a
 * year; FY2026 is closed (EUR 300 posted) and the asset is disposed of on
 * 2027-04-30, four months into the next year (EUR 100). The catch-up is
 * therefore EUR 100, not EUR 400, and retirement must leave neither cost nor
 * accumulated depreciation behind for the asset.
 */
describe('Disposal after an annual close (integration, issue #208)', () => {
  let db: Kysely<Database>;
  let annual: AnnualAccountsService;
  let periods: ReportingPeriodsService;
  let posting: PostingService;
  let assets: FixedAssetsService;
  let attribution: DepreciationAttributionService;

  function draft(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
    reason?: string,
    reversesId?: number,
  ): DraftVoucher {
    return {
      tax_point_date: taxPointDate,
      reason,
      reverses_id: reversesId,
      lines: lines.map((l) => ({
        account_code: l.code,
        is_debit: l.isDebit,
        amount: l.base,
        currency: 'EUR',
        base_amount: l.base,
        fx_rate: 1,
        fx_rate_source: IDENTITY_RATE_SOURCE,
        vat_code: null,
      })),
    };
  }

  function periodId(name: string): Promise<number> {
    return db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  }

  /** Net over an account, credit-positive (the contra accounts' normal side). */
  async function creditNet(code: string): Promise<number> {
    const rows = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', code)
      .where('v.posted_at', 'is not', null)
      .execute();
    return rows.reduce(
      (s, r) => s + (r.is_debit ? -r.base_amount : r.base_amount),
      0,
    );
  }

  /** Register an asset: a capex voucher plus its register row. */
  async function register(opts: {
    name: string;
    assetClass: string;
    date: string;
    costMinor: number;
    lifeYears: number;
    residualMinor?: number;
    accountCode: string;
  }): Promise<number> {
    const acq = await posting.postVoucher(
      draft(opts.date, [
        { code: opts.accountCode, isDebit: true, base: opts.costMinor },
        { code: 'BANK_EUR', isDebit: false, base: opts.costMinor },
      ]),
    );
    const res = await db
      .insertInto('fixed_asset')
      .values({
        name: opts.name,
        asset_class: opts.assetClass,
        acquisition_voucher_id: acq.id,
        acquisition_date: opts.date,
        cost_base_minor: opts.costMinor,
        useful_life_years: opts.lifeYears,
        residual_value_minor: opts.residualMinor ?? 0,
        retired_at: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return res.id as number;
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
        DepreciationAttributionService,
        FixedAssetsService,
      ],
    }).compile();

    annual = module.get(AnnualAccountsService);
    periods = module.get(ReportingPeriodsService);
    posting = module.get(PostingService);
    assets = module.get(FixedAssetsService);
    attribution = module.get(DepreciationAttributionService);

    await periods.create({
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      kind: 'annual',
    });
    await periods.create({
      name: 'FY2027',
      start_date: '2027-01-01',
      end_date: '2027-12-31',
      kind: 'annual',
    });
    await posting.postVoucher(
      draft('2026-01-01', [
        { code: 'BANK_EUR', isDebit: true, base: 500000 },
        { code: 'EQUITY', isDebit: false, base: 500000 },
      ]),
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('charges only the depreciation not already posted for the asset', async () => {
    const id = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });

    await annual.finalize(await periodId('FY2026'));
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(30000);

    const result = await assets.dispose(id, { disposal_date: '2027-04-30' });

    // Catch-up is the four months of 2027 only.
    expect(result.depreciationVoucher).not.toBeNull();
    const catchUp = result.depreciationVoucher!.lines.find((l) => l.is_debit)!;
    expect(catchUp.base_amount).toBe(10000);

    // Retirement removes the asset's cost AND all of its accumulated
    // depreciation — no orphan contra balance is left behind.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(0);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(0);

    // Total depreciation through disposal is 400, booked as a loss on an
    // asset sold for nothing at a net book value of 800.
    const loss = result.disposalVoucher.lines.find(
      (l) => l.is_debit && l.base_amount === 80000,
    );
    expect(loss).toBeDefined();
  });
  it("deducts only the disposed asset's own depreciation when a class holds several assets", async () => {
    // Three IT assets in ONE class, deliberately unlike each other: different
    // acquisition dates, lives and residual values, so no proportional shortcut
    // could reproduce the right split by accident.
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const server = await register({
      name: 'Server',
      assetClass: 'it_equipment',
      date: '2026-07-01',
      costMinor: 240000,
      lifeYears: 5,
      residualMinor: 40000,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const printer = await register({
      name: 'Printer',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 60000,
      lifeYears: 3,
      accountCode: 'FIXED_ASSETS_IT',
    });

    await annual.finalize(await periodId('FY2026'));
    // 30000 (laptop) + 20000 (server: 200000/60 × 6) + 20000 (printer).
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(70000);

    const beforeByAsset = await attribution.postedByAsset(
      [laptop, server, printer],
      '2026-12-31',
    );
    expect(beforeByAsset.get(laptop)).toBe(30000);
    expect(beforeByAsset.get(server)).toBe(20000);
    expect(beforeByAsset.get(printer)).toBe(20000);

    // Dispose ONLY the laptop, four months into 2027.
    const result = await assets.dispose(laptop, {
      disposal_date: '2027-04-30',
    });
    expect(
      result.depreciationVoucher!.lines.find((l) => l.is_debit)!.base_amount,
    ).toBe(10000);

    // The peers' accumulated depreciation is untouched: what remains on the
    // class is exactly theirs (20000 + 20000), not zero and not reduced.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(40000);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(-300000); // debit-normal cost of the two survivors
    const after = await attribution.postedByAsset(
      [server, printer],
      '2027-04-30',
    );
    expect(after.get(server)).toBe(20000);
    expect(after.get(printer)).toBe(20000);

    // The register reconciles to the class control balance (issue #214's
    // second criterion): Σ book value == cost ledger − contra ledger.
    const rows = await assets.list();
    const live = rows.filter((r) => r.retired_at === null);
    const sumBook = live.reduce((s, r) => s + r.book_value_minor, 0);
    expect(sumBook).toBe(300000 - 40000);
    expect(rows.find((r) => r.id === laptop)!.book_value_minor).toBe(0);
    expect(rows.every((r) => r.unattributed_depreciation_minor === 0)).toBe(
      true,
    );
  });

  it('stops at the residual value and charges a fully depreciated asset nothing on disposal', async () => {
    // A van worth 120000 over 2 years with a 20000 residual: the depreciable
    // base is 100000, fully charged by the end of 2027.
    const van = await register({
      name: 'Van',
      assetClass: 'vehicle',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 2,
      residualMinor: 20000,
      accountCode: 'FIXED_ASSETS_VEHICLES',
    });
    await annual.finalize(await periodId('FY2026'));
    expect(await creditNet('ACCUM_DEPRECIATION_VEHICLES')).toBe(50000);
    await annual.finalize(await periodId('FY2027'));
    expect(await creditNet('ACCUM_DEPRECIATION_VEHICLES')).toBe(100000);

    await periods.create({
      name: 'FY2028',
      start_date: '2028-01-01',
      end_date: '2028-12-31',
      kind: 'annual',
    });

    // Disposed a year after it was fully depreciated: nothing more accrues, so
    // there is no catch-up voucher at all.
    const result = await assets.dispose(van, {
      disposal_date: '2028-06-30',
      proceeds_minor: 25000,
    });
    expect(result.depreciationVoucher).toBeNull();

    // Cost and contra both leave the books; the 5000 over the residual is a gain.
    expect(await creditNet('ACCUM_DEPRECIATION_VEHICLES')).toBe(0);
    expect(await creditNet('FIXED_ASSETS_VEHICLES')).toBe(0);
    const gain = result.disposalVoucher.lines.find(
      (l) => !l.is_debit && l.base_amount === 5000,
    );
    expect(gain).toBeDefined();
  });

  it('closes the year after a disposal without reposting its charge or suppressing a peer', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const peer = await register({
      name: 'Workstation',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 240000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await annual.finalize(await periodId('FY2026'));
    await assets.dispose(laptop, { disposal_date: '2027-04-30' });

    // Closing 2027 now: the laptop's 2027 depreciation was ALREADY realized by
    // the disposal catch-up and must not be charged again, while the peer's
    // full 2027 charge must still be posted in full.
    await annual.finalize(await periodId('FY2027'));

    const closeLines = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('v.reason', '=', 'Annual depreciation charge for FY2027')
      .where('a.code', '=', 'ACCUM_DEPRECIATION_IT')
      .execute();
    expect(closeLines).toHaveLength(1);
    expect(closeLines[0].base_amount).toBe(60000); // the peer's year, alone
    expect(Boolean(closeLines[0].is_debit)).toBe(false);

    expect(await attribution.postedForAsset(peer, '2027-12-31')).toBe(120000);
    // The disposed asset gained nothing from the close.
    expect(await attribution.postedForAsset(laptop, '2027-12-31')).toBe(40000);
  });

  it('keeps depreciation posted as of an earlier date when a reversal lands in a later period', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await annual.finalize(await periodId('FY2026'));
    const close = await db
      .selectFrom('voucher')
      .select(['id'])
      .where('reason', '=', 'Annual depreciation charge for FY2026')
      .executeTakeFirstOrThrow();

    // A correction posted in JULY 2027 reverses the 2026 close, through the
    // ordinary reversal route (`reverses_id`), not by editing the original —
    // a posted voucher is immutable (ADR-0019).
    await posting.postVoucher(
      draft(
        '2027-07-31',
        [
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: true, base: 30000 },
          { code: 'DEPRECIATION_EXPENSE', isDebit: false, base: 30000 },
        ],
        'Reversal of the 2026 annual depreciation charge',
        close.id,
      ),
    );

    // As of April 2027 the reversal has not happened yet: the 2026 charge
    // still stands and the catch-up is only 2027's four months.
    expect(await attribution.postedForAsset(laptop, '2027-04-30')).toBe(30000);
    // As of the end of 2027 it has been reversed, so nothing stands posted.
    expect(await attribution.postedForAsset(laptop, '2027-12-31')).toBe(0);
  });

  it('refuses a disposal that depends on unattributed depreciation, and computes it once allocated', async () => {
    // Issue #214's reproduction shape: two assets in one class and a
    // depreciation charge posted BY HAND, carrying no annual-close marker.
    const a = await register({
      name: 'Laptop A',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const b = await register({
      name: 'Laptop B',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const manual = await posting.postVoucher(
      draft(
        '2026-12-31',
        [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 20000 },
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 20000 },
        ],
        'Depreciation booked by hand',
      ),
    );

    // It is visible as unattributed even though it is not a recognised close.
    const unattributed =
      await attribution.unattributedDepreciation('2027-06-30');
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({
      voucherId: manual.id,
      assetClass: 'it_equipment',
      unattributedMinor: 20000,
      cause: 'unattributed_posting',
    });

    // The register says so rather than quietly overstating the book values.
    const before = await assets.list();
    expect(before.map((r) => r.unattributed_depreciation_minor)).toEqual([
      20000, 20000,
    ]);

    // A disposal that would have to guess is REFUSED, actionably.
    await expect(
      assets.dispose(a, { disposal_date: '2027-06-30' }),
    ).rejects.toThrow(BadRequestException);
    let payload: Record<string, unknown> | undefined;
    try {
      await assets.dispose(a, { disposal_date: '2027-06-30' });
    } catch (e) {
      payload = (e as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
    }
    expect(payload).toMatchObject({
      error: 'depreciation_attribution_required',
    });
    expect(
      (payload!.unattributed as Array<{ voucherId: number }>)[0].voucherId,
    ).toBe(manual.id);
    // Nothing was posted and nothing was retired by the refused attempt.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(20000);
    expect(
      (
        await db
          .selectFrom('fixed_asset')
          .select('retired_at')
          .where('id', '=', a)
          .executeTakeFirstOrThrow()
      ).retired_at,
    ).toBeNull();

    // An allocation that does not reconcile to the posted class total is
    // refused — neither under- nor over-allocation is accepted.
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: a, amountMinor: 10000 }],
      }),
    ).rejects.toThrow(/reconcile/);
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [
          { fixedAssetId: a, amountMinor: 15000 },
          { fixedAssetId: b, amountMinor: 15000 },
        ],
      }),
    ).rejects.toThrow(/reconcile/);

    // The supported path: the true split, which reconciles exactly.
    await attribution.allocate({
      voucherId: manual.id,
      allocations: [
        { fixedAssetId: a, amountMinor: 10000 },
        { fixedAssetId: b, amountMinor: 10000 },
      ],
    });
    expect(
      await attribution.unattributedDepreciation('2027-06-30'),
    ).toHaveLength(0);

    // #214: each asset now deducts only its own, and the register reconciles
    // to the class control balance (240000 cost − 20000 contra).
    const after = await assets.list();
    expect(after.map((r) => r.book_value_minor)).toEqual([110000, 110000]);
    expect(after.reduce((s, r) => s + r.book_value_minor, 0)).toBe(
      240000 - 20000,
    );

    // And the disposal now computes: 18 months at 2500 is 45000 accumulated by
    // 2027-06-30, of which 10000 is already posted for this asset.
    const result = await assets.dispose(a, { disposal_date: '2027-06-30' });
    expect(
      result.depreciationVoucher!.lines.find((l) => l.is_debit)!.base_amount,
    ).toBe(35000);
    // Only A's cost and A's contra leave: B's 10000 stays on the class.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(10000);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(-120000);

    // The allocation is on the audit trail and cannot be re-split.
    const logged = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'fixed_asset.depreciation_allocated')
      .execute();
    expect(logged).toHaveLength(1);
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: b, amountMinor: 20000 }],
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an allocation to an asset the voucher cannot have charged', async () => {
    const manual = await posting.postVoucher(
      draft('2026-06-30', [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 10000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 10000 },
      ]),
    );
    // Acquired AFTER that voucher was posted, so it cannot be part of it.
    const later = await register({
      name: 'Later laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: later, amountMinor: 10000 }],
      }),
    ).rejects.toThrow(/acquired after/);

    // …and that asset is NOT held hostage by the ambiguity either: the
    // movement predates it, so its own disposal still computes.
    const result = await assets.dispose(later, {
      disposal_date: '2026-12-31',
    });
    expect(
      result.depreciationVoucher!.lines.find((l) => l.is_debit)!.base_amount,
    ).toBe(30000);
  });

  it('retires exactly once under a retried disposal', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await annual.finalize(await periodId('FY2026'));

    const first = await assets.dispose(laptop, {
      disposal_date: '2027-04-30',
    });
    const vouchersAfterFirst = (
      await db.selectFrom('voucher').select('id').execute()
    ).length;

    await expect(
      assets.dispose(laptop, { disposal_date: '2027-04-30' }),
    ).rejects.toThrow(ConflictException);

    // The retry posted nothing: no second catch-up, no second disposal.
    expect((await db.selectFrom('voucher').select('id').execute()).length).toBe(
      vouchersAfterFirst,
    );
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', laptop)
      .executeTakeFirstOrThrow();
    expect(row.disposal_voucher_id).toBe(first.disposalVoucher.id);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(0);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(0);
  });

  it('rejects a disposal dated before the asset existed', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-03-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await expect(
      assets.dispose(laptop, { disposal_date: '2026-01-15' }),
    ).rejects.toThrow(/acquired on 2026-03-01/);
    await expect(
      assets.dispose(laptop, { disposal_date: 'not-a-date' }),
    ).rejects.toThrow(/ISO date/);
  });
  it('reads cost, depreciation and retirement on ONE basis when dates run into the future', async () => {
    // Everything here is dated after the machine's clock. The register must
    // not show a future acquisition's cost while cutting off the future close
    // that depreciates it, nor zero an asset out before its disposal date.
    await periods.create({
      name: 'FY2099',
      start_date: '2099-01-01',
      end_date: '2099-12-31',
      kind: 'annual',
    });
    const future = await register({
      name: 'Future laptop',
      assetClass: 'it_equipment',
      date: '2099-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });

    // Cost is on the books and no depreciation is posted yet.
    let rows = await assets.list();
    expect(rows.find((r) => r.id === future)!.book_value_minor).toBe(120000);

    // A future-dated close: the cost and the charge move together.
    await annual.finalize(await periodId('FY2026'));
    await annual.finalize(await periodId('FY2027'));
    await periods.create({
      name: 'FY2098',
      start_date: '2098-01-01',
      end_date: '2098-12-31',
      kind: 'annual',
    });
    await annual.finalize(await periodId('FY2098'));
    await annual.finalize(await periodId('FY2099'));
    rows = await assets.list();
    expect(rows.find((r) => r.id === future)!.book_value_minor).toBe(90000);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(30000);

    // A future-dated disposal removes cost AND contra together, so the row
    // reads zero because the ledger says zero — not because `retired_at` is a
    // wall-clock stamp that has already passed.
    await periods.create({
      name: 'FY2100',
      start_date: '2100-01-01',
      end_date: '2100-12-31',
      kind: 'annual',
    });
    await assets.dispose(future, { disposal_date: '2100-04-30' });
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(0);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(0);
    rows = await assets.list();
    expect(rows.find((r) => r.id === future)!.book_value_minor).toBe(0);
  });

  it('rejects a disposal date that is not a real calendar day', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    for (const bad of [
      '2027-02-30',
      '2027-13-01',
      '2027-00-10',
      '2027-04-31',
    ]) {
      await expect(
        assets.dispose(laptop, { disposal_date: bad }),
      ).rejects.toThrow(/ISO date/);
    }
    // The register is untouched by every rejected attempt.
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', laptop)
      .executeTakeFirstOrThrow();
    expect(row.retired_at).toBeNull();
  });
  it('lets only one of two concurrent allocations of the same class win', async () => {
    const a = await register({
      name: 'Laptop A',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const b = await register({
      name: 'Laptop B',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const manual = await posting.postVoucher(
      draft('2026-12-31', [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 20000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 20000 },
      ]),
    );

    // Two requests that each reconcile on their own and touch DISJOINT assets:
    // the unique (voucher, asset) index cannot catch them, so the
    // remaining-amount recheck inside the transaction has to.
    const results = await Promise.allSettled([
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: a, amountMinor: 20000 }],
      }),
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: b, amountMinor: 20000 }],
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // The class is attributed exactly once, to exactly what was posted.
    const rows = await db
      .selectFrom('fixed_asset_depreciation')
      .select(['amount_minor'])
      .where('voucher_id', '=', manual.id)
      .execute();
    expect(rows.reduce((s, r) => s + r.amount_minor, 0)).toBe(20000);
    expect(
      await attribution.unattributedDepreciation('2027-01-01'),
    ).toHaveLength(0);
  });

  it('resolves the still-ambiguous class of a partly attributed voucher', async () => {
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const vanA = await register({
      name: 'Van A',
      assetClass: 'vehicle',
      date: '2026-01-01',
      costMinor: 500000,
      lifeYears: 5,
      accountCode: 'FIXED_ASSETS_VEHICLES',
    });
    const vanB = await register({
      name: 'Van B',
      assetClass: 'vehicle',
      date: '2026-01-01',
      costMinor: 300000,
      lifeYears: 5,
      accountCode: 'FIXED_ASSETS_VEHICLES',
    });
    // One voucher, two classes. IT is settled first; vehicles is left over —
    // the shape migration 075 leaves behind when only one class reconciles.
    const manual = await posting.postVoucher(
      draft('2026-12-31', [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 190000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
        { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 160000 },
      ]),
    );
    await attribution.allocate({
      voucherId: manual.id,
      allocations: [{ fixedAssetId: laptop, amountMinor: 30000 }],
    });

    // IT is settled and cannot be re-split; vehicles is still open and says so.
    const stillOpen = await attribution.unattributedDepreciation('2027-01-01');
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]).toMatchObject({
      assetClass: 'vehicle',
      unattributedMinor: 160000,
    });
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: laptop, amountMinor: 30000 }],
      }),
    ).rejects.toThrow(/already has a complete attribution/);

    // The leftover class resolves on its own, and must still reconcile exactly.
    await expect(
      attribution.allocate({
        voucherId: manual.id,
        allocations: [{ fixedAssetId: vanA, amountMinor: 100000 }],
      }),
    ).rejects.toThrow(/160000 is unattributed/);
    await attribution.allocate({
      voucherId: manual.id,
      allocations: [
        { fixedAssetId: vanA, amountMinor: 100000 },
        { fixedAssetId: vanB, amountMinor: 60000 },
      ],
    });

    // The IT rows written earlier are untouched, and nothing is ambiguous now.
    expect(
      await attribution.unattributedDepreciation('2027-01-01'),
    ).toHaveLength(0);
    expect(await attribution.postedForAsset(laptop, '2026-12-31')).toBe(30000);
    expect(await attribution.postedForAsset(vanA, '2026-12-31')).toBe(100000);
    expect(await attribution.postedForAsset(vanB, '2026-12-31')).toBe(60000);
  });
  it('refuses to finalize a year holding a hand-posted charge, and gets it right once allocated', async () => {
    // A live asset due 300 for the year, with 100 already booked by hand.
    // Netting nothing would post the full 300 on top and charge the year 400.
    const laptop = await register({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const manual = await posting.postVoucher(
      draft(
        '2026-06-30',
        [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 10000 },
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 10000 },
        ],
        'Depreciation booked by hand',
      ),
    );

    // The DRAFT says the figures are not complete, as a blocking diagnostic.
    const fy2026 = await periodId('FY2026');
    const draftResult = await annual.generate(fy2026);
    const blocking = draftResult.warnings.filter(
      (w) => w.code === 'depreciation_unattributed',
    );
    expect(blocking).toHaveLength(1);
    expect((blocking[0] as { severity?: string }).severity).toBe('block');

    // And finalize refuses outright rather than filing them.
    await expect(annual.finalize(fy2026)).rejects.toThrow(
      /not attributed to individual assets/,
    );
    // Nothing was posted and the year is still open.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(10000);
    expect(
      (
        await db
          .selectFrom('reporting_period')
          .select('status')
          .where('id', '=', fy2026)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('open');

    await attribution.allocate({
      voucherId: manual.id,
      allocations: [{ fixedAssetId: laptop, amountMinor: 10000 }],
    });

    await annual.finalize(fy2026);
    // The close posts only the 200 that was missing: 300 for the year, not 400.
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(30000);
    expect(await attribution.postedForAsset(laptop, '2026-12-31')).toBe(30000);
  });

  it('refuses to finalize where an unattributed close would be netted off a living peer', async () => {
    // The shape that silently under-charges: an unattributed close charged
    // asset A, A is then retired, and the class-level netting would take A's
    // 300 off the LIVING peer B's own 300 — leaving B uncharged for the year.
    const a = await register({
      name: 'Laptop A',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const b = await register({
      name: 'Laptop B',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    // A legacy-shaped close: the documented reason, no attribution behind it.
    const legacyClose = await posting.postVoucher(
      draft(
        '2026-12-31',
        [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 30000 },
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
        ],
        'Annual depreciation charge for FY2026',
      ),
    );

    const fy2026 = await periodId('FY2026');
    await expect(annual.finalize(fy2026)).rejects.toThrow(
      /not attributed to individual assets/,
    );

    // Allocate it to A, where it belongs, then retire A.
    await attribution.allocate({
      voucherId: legacyClose.id,
      allocations: [{ fixedAssetId: a, amountMinor: 30000 }],
    });
    await assets.dispose(a, { disposal_date: '2026-12-31' });
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(0); // A's 300 left with A

    // Now the year finalizes, and B is charged its OWN 300 — not suppressed by
    // the close that belonged to the asset that has left the books.
    await annual.finalize(fy2026);
    expect(await attribution.postedForAsset(b, '2026-12-31')).toBe(30000);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(30000);
  });
  it('registers two assets in one class against the class control balance (issue #214)', async () => {
    // Issue #214's reproduction, through the kernel's own posting path: two IT
    // assets of EUR 1,200 and depreciation on ACCUM_DEPRECIATION_IT. The bug
    // subtracted the whole class contra from EACH asset, so the register
    // totalled 2,000 against a ledger control balance of 2,200.
    const a = await register({
      name: 'Laptop A',
      assetClass: 'it_equipment',
      date: '2026-11-01',
      costMinor: 120000,
      lifeYears: 2,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const b = await register({
      name: 'Laptop B',
      assetClass: 'it_equipment',
      date: '2026-11-01',
      costMinor: 120000,
      lifeYears: 2,
      accountCode: 'FIXED_ASSETS_IT',
    });
    // Two months of a two-year life on each: 5,000 + 5,000 = EUR 200 in all.
    await annual.finalize(await periodId('FY2026'));
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(20000);

    const rows = await assets.list();
    expect(rows.map((r) => r.book_value_minor)).toEqual([110000, 110000]);
    expect(rows.reduce((s, r) => s + r.book_value_minor, 0)).toBe(220000);

    // The ledger control balance: cost − contra, for the class.
    const control =
      -(await creditNet('FIXED_ASSETS_IT')) -
      (await creditNet('ACCUM_DEPRECIATION_IT'));
    expect(control).toBe(220000);

    // …and it keeps reconciling with a disposed asset beside a live one.
    await assets.dispose(a, { disposal_date: '2027-06-30' });
    const after = await assets.list();
    expect(after.find((r) => r.id === a)!.book_value_minor).toBe(0);
    const controlAfter =
      -(await creditNet('FIXED_ASSETS_IT')) -
      (await creditNet('ACCUM_DEPRECIATION_IT'));
    expect(after.reduce((s, r) => s + r.book_value_minor, 0)).toBe(
      controlAfter,
    );
    expect(after.find((r) => r.id === b)!.book_value_minor).toBe(110000);
  });
});
