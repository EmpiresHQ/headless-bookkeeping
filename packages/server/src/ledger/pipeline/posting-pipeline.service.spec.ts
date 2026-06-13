import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PostingService } from '../posting/posting.service';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';
import { StatusTransitionService } from '../status/status-transition.service';
import { PolicyService } from '../../policy/policy.service';
import { RulesService } from '../../rules/rules.service';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { OrganizationService } from '../../organization/organization.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../plugins/estonia-country.plugin';
import { PostingPipelineService } from './posting-pipeline.service';
import { DraftVoucher } from '../voucher/types';

describe('PostingPipelineService afterPost hook (integration)', () => {
  let db: Kysely<Database>;
  let pipeline: PostingPipelineService;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
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
      ],
    }).compile();

    pipeline = module.get(PostingPipelineService);

    // Seed a draft expense to satisfy the status-transition claim.
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('expense')
      .values({
        document_id: null, supplier_id: null, category: 'software',
        gross_amount: 10000, vat_amount: 0, currency: 'EUR',
        tax_point_date: '2024-02-15', status: 'draft', voucher_id: null,
        document_vat_marking: null, supplier_invoice_number: null,
        asset_name: null, asset_useful_life_years: null, asset_residual_value_minor: null,
        created_at: now, updated_at: now,
      })
      .execute();
  });

  afterEach(async () => { await db.destroy(); });

  const draft = (): DraftVoucher => ({
    tax_point_date: '2024-02-15',
    lines: [
      { account_code: 'EXPENSE_SOFTWARE', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: true },
      { account_code: 'CASH', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: false },
    ],
  });

  it('runs afterPost inside the posting transaction (receives the posted voucher)', async () => {
    let seenVoucherId = 0;
    const result = await pipeline.runPipeline({
      businessObjectId: 1,
      businessObjectType: 'expense',
      draftGenerator: () => Promise.resolve(draft()),
      category: 'software',
      refetch: () => Promise.resolve({ id: 1 }),
      confidence: 1,
      supplierKnown: true,
      afterPost: (_trx, voucher) => {
        seenVoucherId = voucher.id;
        return Promise.resolve();
      },
    });
    expect(result.voucher).not.toBeNull();
    expect(seenVoucherId).toBe(result.voucher!.id);
  });

  it('rolls back the post when afterPost throws (no voucher persisted)', async () => {
    await expect(
      pipeline.runPipeline({
        businessObjectId: 1,
        businessObjectType: 'expense',
        draftGenerator: () => Promise.resolve(draft()),
        category: 'software',
        refetch: () => Promise.resolve({ id: 1 }),
        confidence: 1,
        supplierKnown: true,
        afterPost: () => Promise.reject(new Error('hook boom')),
      }),
    ).rejects.toThrow('hook boom');

    const vouchers = await db.selectFrom('voucher').selectAll().execute();
    expect(vouchers).toHaveLength(0);
  });
});
