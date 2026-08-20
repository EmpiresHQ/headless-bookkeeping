import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
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
import { AuditLogService } from '../audit-log/audit-log.service';

describe('FixedAssetRegistrarService (capex → register, integration)', () => {
  let db: Kysely<Database>;
  let expenses: ExpensesService;
  let pipeline: PostingPipelineService;
  let registrar: FixedAssetRegistrarService;

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

    // Raise the auto-post ceiling above the capex amount so the post
    // auto-posts (and the afterPost registrar hook fires) rather than being
    // held for approval — the default ceiling (100000) is below the test's
    // 2000000 capex.
    await db
      .updateTable('policy_config')
      .set({ value: '100000000' })
      .where('key', '=', 'auto_post_amount_ceiling')
      .execute();

    // This suite proves capex → fixed-asset registration mechanics, not the
    // auto_post_enabled master switch (which defaults to false and would
    // otherwise hold every posting for approval instead of auto-posting,
    // so the afterPost registrar hook would never fire).
    await db
      .insertInto('policy_config')
      .values({
        key: 'auto_post_enabled',
        value: 'true',
        updated_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditLogService,
        ExpensesService,
        CategoryService,
        VoucherProjectionService,
        CurrencyService,
        PostingPipelineService,
        PostingService,
        AccountService,
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
        FixedAssetRegistrarService,
      ],
    }).compile();

    expenses = module.get(ExpensesService);
    pipeline = module.get(PostingPipelineService);
    registrar = module.get(FixedAssetRegistrarService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function postCapex(over: {
    asset_name: string;
    asset_useful_life_years?: number | null;
    asset_residual_value_minor?: number | null;
    category: string;
  }) {
    const expense = await expenses.createExpense({
      category: over.category,
      gross_amount: 2000000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      asset_name: over.asset_name,
      asset_useful_life_years: over.asset_useful_life_years ?? null,
      asset_residual_value_minor: over.asset_residual_value_minor ?? null,
    });
    await pipeline.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () => expenses.generateDraftVoucher(expense.id),
      category: over.category,
      refetch: () => expenses.getExpenseById(expense.id),
      confidence: 1,
      supplierKnown: true,
      afterPost: (trx, voucher) =>
        registrar.registerFromVoucher(trx, voucher, expense.id),
    });
    return expense.id;
  }

  it('creates a register row with plugin defaults when no overrides given (vehicle 5y, residual 400000)', async () => {
    await postCapex({ asset_name: 'Company car', category: 'vehicle' });
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.name).toBe('Company car');
    expect(row.asset_class).toBe('vehicle');
    expect(row.cost_base_minor).toBe(2000000);
    expect(row.useful_life_years).toBe(5);
    expect(row.residual_value_minor).toBe(400000);
    expect(row.acquisition_date).toBe('2024-02-15');
    expect(row.acquisition_voucher_id).toBeGreaterThan(0);
    expect(row.retired_at).toBeNull();
  });

  it('honours useful-life and residual overrides from the intake payload', async () => {
    await postCapex({
      asset_name: 'Long-life laptop',
      category: 'it_equipment',
      asset_useful_life_years: 6,
      asset_residual_value_minor: 10000,
    });
    const row = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.asset_class).toBe('it_equipment');
    expect(row.useful_life_years).toBe(6);
    expect(row.residual_value_minor).toBe(10000);
  });

  it('creates NO register row for a non-capex expense', async () => {
    const expense = await expenses.createExpense({
      category: 'software',
      gross_amount: 5000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      asset_name: null,
    });
    await pipeline.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () => expenses.generateDraftVoucher(expense.id),
      category: 'software',
      refetch: () => expenses.getExpenseById(expense.id),
      confidence: 1,
      supplierKnown: true,
      afterPost: (trx, voucher) =>
        registrar.registerFromVoucher(trx, voucher, expense.id),
    });
    const rows = await db.selectFrom('fixed_asset').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
