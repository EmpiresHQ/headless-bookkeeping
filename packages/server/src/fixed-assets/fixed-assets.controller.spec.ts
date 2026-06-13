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
import { FixedAssetsController } from './fixed-assets.controller';

describe('FixedAssetsController (integration)', () => {
  let db: Kysely<Database>;
  let expenses: ExpensesService;
  let pipeline: PostingPipelineService;
  let registrar: FixedAssetRegistrarService;
  let controller: FixedAssetsController;

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

    // Raise the auto-post ceiling above the capex amount so the pipeline auto-posts
    // (and the afterPost registrar hook fires) — the default ceiling (100000) is below
    // the test's 2000000 capex amount.
    await db
      .updateTable('policy_config')
      .set({ value: '100000000' })
      .where('key', '=', 'auto_post_amount_ceiling')
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FixedAssetsController],
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
    controller = module.get(FixedAssetsController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function acquireCar(): Promise<void> {
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
  }

  it('GET /api/fixed-assets lists the register with computed book value (no depreciation yet → cost)', async () => {
    await acquireCar();
    const { fixedAssets } = await controller.list();
    expect(fixedAssets).toHaveLength(1);
    expect(fixedAssets[0].name).toBe('Company car');
    expect(fixedAssets[0].asset_class).toBe('vehicle');
    // No depreciation posted yet ⇒ book value == cost.
    expect(fixedAssets[0].book_value_minor).toBe(2000000);
    expect(fixedAssets[0].retired_at).toBeNull();
  });

  it('book value drops by accumulated depreciation after a disposal catch-up posting', async () => {
    await acquireCar();
    const before = (await controller.list()).fixedAssets[0];
    await controller.dispose(before.id, {
      disposal_date: '2025-12-31',
      proceeds_minor: 1500000,
    });
    const after = (await controller.list()).fixedAssets[0];
    // After disposal the accumulated (640,000) is debited away again to clear ACCUM,
    // so the per-class contra nets to 0 ⇒ book value reads back as cost. The asset is retired.
    expect(after.retired_at).not.toBeNull();
    expect(after.disposal_voucher_id).not.toBeNull();
  });
});
