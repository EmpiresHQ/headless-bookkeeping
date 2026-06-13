import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { BadRequestException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PolicyService } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { CategoryService } from '../categories/category.service';
import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';
import { FixedAssetsService } from './fixed-assets.service';

describe('FixedAssetsService disposal (integration)', () => {
  let db: Kysely<Database>;
  let expenses: ExpensesService;
  let pipeline: PostingPipelineService;
  let registrar: FixedAssetRegistrarService;
  let service: FixedAssetsService;

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
    await db.updateTable('organization').set({ country: 'EE' }).execute();

    // Raise the auto-post ceiling above the capex amount so the post auto-posts
    // (and the afterPost registrar hook fires) rather than being held for
    // approval — the default ceiling (100000) is below the test's 2000000 capex.
    await db
      .updateTable('policy_config')
      .set({ value: '100000000' })
      .where('key', '=', 'auto_post_amount_ceiling')
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        FixedAssetsService,
        FixedAssetRegistrarService,
        ExpensesService,
        CategoryService,
        VoucherProjectionService,
        CurrencyService,
        PostingPipelineService,
        PostingService,
        AccountService,
        LedgerBalanceService,
        LedgerValidationService,
        PeriodLockService,
        StatusTransitionService,
        PolicyService,
        RulesService,
        OrgContextResolver,
        OrganizationService,
        PluginLoader,
        NullCountryPlugin,
        EstoniaCountryPlugin,
      ],
    }).compile();

    expenses = module.get(ExpensesService);
    pipeline = module.get(PostingPipelineService);
    registrar = module.get(FixedAssetRegistrarService);
    service = module.get(FixedAssetsService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // Acquire a €20,000 vehicle on 2024-01-01, 5y life, €4,000 residual.
  async function acquireCar(): Promise<number> {
    const expense = await expenses.createExpense({
      category: 'vehicle',
      gross_amount: 2000000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2024-01-01',
      asset_name: 'Company car',
    });
    await pipeline.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () => expenses.generateDraftVoucher(expense.id),
      category: 'vehicle',
      refetch: () => expenses.getExpenseById(expense.id),
      confidence: 1,
      supplierKnown: true,
      afterPost: (trx, v) => registrar.registerFromVoucher(trx, v, expense.id),
    });
    const row = await db
      .selectFrom('fixed_asset')
      .select('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  // Sum of debit-positive base over the contra ACCUM_DEPRECIATION_VEHICLES account.
  async function accumDep(): Promise<number> {
    const r = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select((eb) =>
        eb.fn
          .sum<number>(
            eb
              .case()
              .when('vl.is_debit', '=', 1)
              .then(eb.ref('vl.base_amount'))
              .else(eb.neg(eb.ref('vl.base_amount')))
              .end(),
          )
          .as('net'),
      )
      .where('a.code', '=', 'ACCUM_DEPRECIATION_VEHICLES')
      .executeTakeFirst();
    return Number(r?.net ?? 0); // credit-normal contra → negative when accumulated
  }

  it('disposal with proceeds (gain) posts catch-up depreciation then a disposal voucher and retires the asset', async () => {
    const id = await acquireCar();
    // Dispose 2025-12-31 (2 full years). Depreciable base 1,600,000; /5=320,000/yr; 2y=640,000.
    // NBV = 2,000,000 − 640,000 = 1,360,000. Proceeds 1,500,000 ⇒ gain 140,000.
    const result = await service.dispose(id, {
      disposal_date: '2025-12-31',
      proceeds_minor: 1500000,
    });

    // Two NEW vouchers posted by disposal (in addition to the acquisition voucher).
    expect(result.depreciationVoucher).not.toBeNull();
    expect(result.disposalVoucher).not.toBeNull();

    // Accumulated depreciation reached 640,000 (contra credit-normal ⇒ −640,000 before disposal clears it).
    // After the disposal voucher debits ACCUM to clear it, the net over the account is 0.
    expect(await accumDep()).toBe(0);

    // GAIN_LOSS line: a gain is a credit (revenue-normal). Assert the credit magnitude.
    const gainLine = result.disposalVoucher!.lines.find(
      (l) =>
        result.disposalVoucher!.lines.length > 0 &&
        l.base_amount === 140000 &&
        !l.is_debit,
    );
    expect(gainLine).toBeDefined();

    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.retired_at).not.toBeNull();
    expect(row.disposal_voucher_id).toBe(result.disposalVoucher!.id);
  });

  it('scrap (zero proceeds) books the full net book value as a loss', async () => {
    const id = await acquireCar();
    // Dispose 2025-12-31, no proceeds. NBV 1,360,000 ⇒ loss 1,360,000 (debit to GAIN_LOSS).
    const result = await service.dispose(id, { disposal_date: '2025-12-31' });
    const lossLine = result.disposalVoucher!.lines.find(
      (l) => l.base_amount === 1360000 && l.is_debit,
    );
    expect(lossLine).toBeDefined();
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.retired_at).not.toBeNull();
  });

  it('disposal with low proceeds (loss) books a debit to GAIN_LOSS', async () => {
    const id = await acquireCar();
    // NBV 1,360,000; proceeds 1,000,000 ⇒ loss 360,000.
    const result = await service.dispose(id, {
      disposal_date: '2025-12-31',
      proceeds_minor: 1000000,
    });
    const lossLine = result.disposalVoucher!.lines.find(
      (l) => l.base_amount === 360000 && l.is_debit,
    );
    expect(lossLine).toBeDefined();
  });

  it('rejects a disposal dated into a locked period (no write)', async () => {
    const id = await acquireCar();
    // Lock the seeded 2024-Q1 period (2024-01-01..2024-03-31).
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked' })
      .where('id', '=', 1)
      .execute();

    const vouchersBefore = (
      await db.selectFrom('voucher').selectAll().execute()
    ).length;
    await expect(
      service.dispose(id, { disposal_date: '2024-02-15', proceeds_minor: 100 }),
    ).rejects.toThrow(BadRequestException);

    const vouchersAfter = (await db.selectFrom('voucher').selectAll().execute())
      .length;
    expect(vouchersAfter).toBe(vouchersBefore); // catch-up + disposal both rolled back
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.retired_at).toBeNull();
  });
});
