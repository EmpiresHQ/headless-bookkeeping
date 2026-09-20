import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
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
import { DepreciationAttributionService } from './depreciation-attribution.service';
import { FixedAssetsService } from './fixed-assets.service';

/**
 * A database that already held a DISPOSED asset when migration 075 arrived.
 *
 * The disposal posted two vouchers the old code never attributed: the
 * catch-up charge, and the clearing debit that took the asset's accumulated
 * depreciation off the class. Both are movements on an `ACCUM_DEPRECIATION_*`
 * account, so under the signed model they would read as unexplained — and an
 * unexplained movement blocks the year's close and the class's disposals.
 *
 * Neither is actually unknown. `fixed_asset.disposal_voucher_id` names the
 * voucher that retired one specific asset, and the catch-up carries the
 * documented reason that names the same asset. The migration back-fills what
 * that evidence determines, and nothing else.
 *
 * The world is built at migration 074 — before any of this existed — and the
 * migration is then run over it, so the fixture is a real upgrade rather than
 * a simulation of one.
 */
describe('Upgrading a database with a disposed asset (integration, issue #208)', () => {
  const LAST_BEFORE = '074_add_reporting_period_kind';

  let db: Kysely<Database>;
  let seq = 0;

  async function accountId(code: string): Promise<number> {
    const row = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** A posted voucher written the way a pre-075 database holds one. */
  async function postRaw(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
    reason?: string,
  ): Promise<number> {
    seq += 1;
    const res = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-LEGACY-${seq}`,
        tax_point_date: taxPointDate,
        posted_at: Math.floor(Date.now() / 1000),
        reason: reason ?? null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const voucherId = res.id as number;
    for (const l of lines) {
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: voucherId,
          account_id: await accountId(l.code),
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          is_debit: l.isDebit ? 1 : 0,
        } as never)
        .execute();
    }
    return voucherId;
  }

  async function registerRaw(
    name: string,
    date: string,
    costMinor: number,
    lifeYears: number,
  ): Promise<number> {
    const acq = await postRaw(date, [
      { code: 'FIXED_ASSETS_IT', isDebit: true, base: costMinor },
      { code: 'BANK_EUR', isDebit: false, base: costMinor },
    ]);
    const row = await db
      .insertInto('fixed_asset')
      .values({
        name,
        asset_class: 'it_equipment',
        acquisition_voucher_id: acq,
        acquisition_date: date,
        cost_base_minor: costMinor,
        useful_life_years: lifeYears,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as number;
  }

  beforeEach(async () => {
    seq = 0;
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(LAST_BEFORE);
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
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function migrateToLatest(): Promise<void> {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');
  }

  /** Boot the real services over the upgraded database. */
  async function boot(): Promise<{
    attribution: DepreciationAttributionService;
    assets: FixedAssetsService;
    annual: AnnualAccountsService;
    periods: ReportingPeriodsService;
  }> {
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
    return {
      attribution: module.get(DepreciationAttributionService),
      assets: module.get(FixedAssetsService),
      annual: module.get(AnnualAccountsService),
      periods: module.get(ReportingPeriodsService),
    };
  }

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

  /**
   * FY2026 with two IT assets; one of them disposed of mid-2027 the old way —
   * a catch-up voucher and a disposal voucher, neither attributed — and a live
   * peer alongside it.
   */
  async function seedLegacyDisposal(): Promise<{
    disposed: number;
    peer: number;
    catchUpId: number;
    disposalId: number;
  }> {
    for (const [name, year] of [
      ['FY2026', 2026],
      ['FY2027', 2027],
    ] as const) {
      await db
        .insertInto('reporting_period')
        .values({
          name,
          start_date: `${year}-01-01`,
          end_date: `${year}-12-31`,
          status: name === 'FY2026' ? 'locked' : 'open',
          kind: 'annual',
          created_at: Math.floor(Date.now() / 1000),
        } as never)
        .execute();
    }
    await postRaw('2026-01-01', [
      { code: 'BANK_EUR', isDebit: true, base: 500000 },
      { code: 'EQUITY', isDebit: false, base: 500000 },
    ]);

    // 120000 over 4 years each: 30000 a year.
    const disposed = await registerRaw('Laptop', '2026-01-01', 120000, 4);
    const peer = await registerRaw('Workstation', '2026-01-01', 120000, 4);

    // The FY2026 close, aggregated per class the way the old code posted it.
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 60000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 60000 },
      ],
      'Annual depreciation charge for FY2026',
    );

    // The old disposal: catch-up for four months of 2027, then retirement.
    const catchUpId = await postRaw(
      '2027-04-30',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 10000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 10000 },
      ],
      `Catch-up depreciation on disposal of fixed asset ${disposed}`,
    );
    const disposalId = await postRaw(
      '2027-04-30',
      [
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: true, base: 40000 },
        { code: 'FIXED_ASSETS_IT', isDebit: false, base: 120000 },
        { code: 'GAIN_LOSS_ON_ASSET_DISPOSAL', isDebit: true, base: 80000 },
      ],
      `Disposal of fixed asset ${disposed}`,
    );
    await db
      .updateTable('fixed_asset')
      .set({
        retired_at: Math.floor(Date.now() / 1000),
        disposal_voucher_id: disposalId,
      })
      .where('id', '=', disposed)
      .execute();

    return { disposed, peer, catchUpId, disposalId };
  }

  it('introduces no unknown for a disposal the register already identifies', async () => {
    const { disposed, peer, catchUpId, disposalId } =
      await seedLegacyDisposal();

    await migrateToLatest();
    const { attribution, assets } = await boot();

    // Nothing is reported as unexplained: the close re-derived, and both
    // disposal legs are owned by the asset the register names.
    expect(
      await attribution.unattributedDepreciation('9999-12-31'),
    ).toHaveLength(0);

    // The disposed asset nets to nothing — 30000 close + 10000 catch-up,
    // all 40000 cleared on retirement — and the peer keeps its own 30000.
    expect(await attribution.postedForAsset(disposed, '9999-12-31')).toBe(0);
    expect(await attribution.postedForAsset(disposed, '2026-12-31')).toBe(
      30000,
    );
    expect(await attribution.postedForAsset(peer, '9999-12-31')).toBe(30000);

    // Every back-filled row points at a real leg of the right voucher.
    const rows = await db
      .selectFrom('fixed_asset_depreciation')
      .select(['fixed_asset_id', 'voucher_id', 'amount_minor', 'source'])
      .orderBy('voucher_id')
      .execute();
    expect(rows).toEqual([
      expect.objectContaining({
        fixed_asset_id: disposed,
        amount_minor: 30000,
      }),
      expect.objectContaining({ fixed_asset_id: peer, amount_minor: 30000 }),
      expect.objectContaining({
        fixed_asset_id: disposed,
        voucher_id: catchUpId,
        amount_minor: 10000,
        source: 'legacy_backfill',
      }),
      expect.objectContaining({
        fixed_asset_id: disposed,
        voucher_id: disposalId,
        amount_minor: -40000,
        source: 'legacy_backfill',
      }),
    ]);

    // The register reads right: the retired asset is off the books and the
    // live peer reconciles to the class control balance.
    const listed = await assets.list();
    expect(listed.find((r) => r.id === disposed)!.book_value_minor).toBe(0);
    expect(listed.find((r) => r.id === peer)!.book_value_minor).toBe(90000);
    expect(listed.every((r) => r.unattributed_depreciation_minor === 0)).toBe(
      true,
    );
    expect(
      -(await creditNet('FIXED_ASSETS_IT')) -
        (await creditNet('ACCUM_DEPRECIATION_IT')),
    ).toBe(90000);
  });

  it('leaves the live peer fully usable: the next year closes and it can be disposed of', async () => {
    const { disposed, peer } = await seedLegacyDisposal();
    await migrateToLatest();
    const { attribution, assets, annual } = await boot();

    const fy2027 = await db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', 'FY2027')
      .executeTakeFirstOrThrow();

    // FY2027 closes, charging the PEER's year and nothing for the asset that
    // left the books — the legacy disposal neither blocks the close nor is
    // charged again.
    await annual.finalize(fy2027.id);
    expect(await attribution.postedForAsset(peer, '2027-12-31')).toBe(60000);
    expect(await attribution.postedForAsset(disposed, '2027-12-31')).toBe(0);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(60000);

    // And the peer can itself be disposed of, clearing exactly its own.
    await db
      .insertInto('reporting_period')
      .values({
        name: 'FY2028',
        start_date: '2028-01-01',
        end_date: '2028-12-31',
        status: 'open',
        kind: 'annual',
        created_at: Math.floor(Date.now() / 1000),
      } as never)
      .execute();
    const result = await assets.dispose(peer, {
      disposal_date: '2028-06-30',
    });
    expect(
      result.depreciationVoucher!.lines.find((l) => l.is_debit)!.base_amount,
    ).toBe(15000);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(0);
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(0);
  });

  it('leaves a disposal it cannot identify unattributed instead of guessing', async () => {
    // Same shape, but the register does not name the disposal voucher — so
    // which asset the clearing debit belongs to is not evidenced.
    const { disposalId } = await seedLegacyDisposal();
    await db
      .updateTable('fixed_asset')
      .set({ disposal_voucher_id: null })
      .where('disposal_voucher_id', '=', disposalId)
      .execute();

    await migrateToLatest();
    const { attribution } = await boot();

    const unknown = await attribution.unattributedDepreciation('9999-12-31');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      voucherId: disposalId,
      assetClass: 'it_equipment',
      unattributedMinor: -40000,
    });
  });
  /**
   * The same upgrade, over history the #208 bug actually produced.
   *
   * The old disposal charged the FULL theoretical accumulation as catch-up
   * (40000) although the FY2026 close had already posted 30000 for the asset,
   * and then cleared only the 40000 it had just computed. The asset left the
   * books with 30000 of its accumulated depreciation still sitting on the
   * class — an orphan credit for an asset that no longer exists.
   *
   * That is DAMAGE ALREADY IN THE LEDGER. This work does not repair it:
   * posted vouchers are immutable, and inventing a correcting entry during a
   * migration would be exactly the silent guessing the rest of this design
   * refuses. What the upgrade must do is leave it alone, keep it traceable,
   * and keep everything else working.
   */
  async function seedBuggyDisposal(): Promise<{
    disposed: number;
    peer: number;
  }> {
    for (const [name, year] of [
      ['FY2026', 2026],
      ['FY2027', 2027],
    ] as const) {
      await db
        .insertInto('reporting_period')
        .values({
          name,
          start_date: `${year}-01-01`,
          end_date: `${year}-12-31`,
          status: name === 'FY2026' ? 'locked' : 'open',
          kind: 'annual',
          created_at: Math.floor(Date.now() / 1000),
        } as never)
        .execute();
    }
    await postRaw('2026-01-01', [
      { code: 'BANK_EUR', isDebit: true, base: 500000 },
      { code: 'EQUITY', isDebit: false, base: 500000 },
    ]);
    const disposed = await registerRaw('Laptop', '2026-01-01', 120000, 4);
    const peer = await registerRaw('Workstation', '2026-01-01', 120000, 4);
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 60000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 60000 },
      ],
      'Annual depreciation charge for FY2026',
    );
    // THE BUG: the whole accumulation charged again as catch-up…
    await postRaw(
      '2027-04-30',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 40000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 40000 },
      ],
      `Catch-up depreciation on disposal of fixed asset ${disposed}`,
    );
    // …and only that much cleared on retirement.
    const disposalId = await postRaw(
      '2027-04-30',
      [
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: true, base: 40000 },
        { code: 'FIXED_ASSETS_IT', isDebit: false, base: 120000 },
        { code: 'GAIN_LOSS_ON_ASSET_DISPOSAL', isDebit: true, base: 80000 },
      ],
      `Disposal of fixed asset ${disposed}`,
    );
    await db
      .updateTable('fixed_asset')
      .set({
        retired_at: Math.floor(Date.now() / 1000),
        disposal_voucher_id: disposalId,
      })
      .where('id', '=', disposed)
      .execute();
    return { disposed, peer };
  }

  it('preserves the orphan a pre-#208 disposal left, rather than correcting the ledger', async () => {
    const { disposed, peer } = await seedBuggyDisposal();
    const ledgerBefore = {
      vouchers: await db.selectFrom('voucher').selectAll().execute(),
      lines: await db.selectFrom('voucher_line').selectAll().execute(),
    };

    await migrateToLatest();
    const { attribution, assets } = await boot();

    // Not one posted line is touched. The class still carries 60000: the
    // living peer's own 30000, plus the 30000 orphaned by the retired asset.
    expect(await db.selectFrom('voucher').selectAll().execute()).toEqual(
      ledgerBefore.vouchers,
    );
    expect(await db.selectFrom('voucher_line').selectAll().execute()).toEqual(
      ledgerBefore.lines,
    );
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(60000);

    // Nothing is invented to paper over it: every movement is explained by
    // the evidence, so there is no false "unknown" either.
    expect(
      await attribution.unattributedDepreciation('9999-12-31'),
    ).toHaveLength(0);

    // The orphan stays TRACEABLE: it is the retired asset's own residue
    // (30000 close + 40000 catch-up − 40000 cleared), not an anonymous
    // balance and not silently reassigned to the living peer.
    expect(await attribution.postedForAsset(disposed, '9999-12-31')).toBe(
      30000,
    );
    expect(await attribution.postedForAsset(peer, '9999-12-31')).toBe(30000);

    // KNOWN LIMITATION. The register cannot reconcile to the class control
    // balance while a retired asset's depreciation is still on the class: the
    // control balance is short by exactly the orphan. Only a manual
    // accounting correction in the ledger can close that gap.
    const listed = await assets.list();
    const live = listed.filter((r) => r.retired_at === null);
    expect(live.reduce((s, r) => s + r.book_value_minor, 0)).toBe(90000);
    const control =
      -(await creditNet('FIXED_ASSETS_IT')) -
      (await creditNet('ACCUM_DEPRECIATION_IT'));
    expect(control).toBe(60000);
    expect(live.reduce((s, r) => s + r.book_value_minor, 0) - control).toBe(
      30000,
    );
  });

  it('keeps the live peer correct despite the orphan', async () => {
    const { peer } = await seedBuggyDisposal();
    await migrateToLatest();
    const { attribution, assets, annual } = await boot();

    const fy2027 = await db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', 'FY2027')
      .executeTakeFirstOrThrow();

    // The orphan neither blocks the close nor is charged to the peer.
    await annual.finalize(fy2027.id);
    expect(await attribution.postedForAsset(peer, '2027-12-31')).toBe(60000);

    await db
      .insertInto('reporting_period')
      .values({
        name: 'FY2028',
        start_date: '2028-01-01',
        end_date: '2028-12-31',
        status: 'open',
        kind: 'annual',
        created_at: Math.floor(Date.now() / 1000),
      } as never)
      .execute();
    const result = await assets.dispose(peer, {
      disposal_date: '2028-06-30',
    });
    // 30 months of a 48-month life is 75000; 60000 stands posted.
    expect(
      result.depreciationVoucher!.lines.find((l) => l.is_debit)!.base_amount,
    ).toBe(15000);
    // The peer's own cost and contra both leave; the orphan — and only the
    // orphan — remains behind on the class.
    expect(await creditNet('FIXED_ASSETS_IT')).toBe(0);
    expect(await creditNet('ACCUM_DEPRECIATION_IT')).toBe(30000);
  });
});
