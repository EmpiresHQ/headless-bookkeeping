import { ConflictException } from '@nestjs/common';
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
        document_id: null,
        supplier_id: null,
        category: 'software',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-15',
        status: 'draft',
        voucher_id: null,
        document_vat_marking: null,
        supplier_invoice_number: null,
        asset_name: null,
        asset_useful_life_years: null,
        asset_residual_value_minor: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const draft = (): DraftVoucher => ({
    tax_point_date: '2024-02-15',
    lines: [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
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
    ],
  });

  const salesInvoiceDraft = (): DraftVoucher => ({
    tax_point_date: '2024-02-15',
    lines: [
      {
        account_code: 'AR',
        amount: 12300,
        currency: 'EUR',
        base_amount: 12300,
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
        vat_code: 'IE_OUTPUT_23',
        is_debit: false,
      },
      {
        account_code: 'VAT_PAYABLE',
        amount: 2300,
        currency: 'EUR',
        base_amount: 2300,
        fx_rate: 1,
        vat_code: 'IE_OUTPUT_23',
        is_debit: false,
      },
    ],
  });

  async function insertDraftSalesInvoice(
    database: Kysely<Database>,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const row = await database
      .insertInto('sales_invoice')
      .values({
        customer_id: null,
        invoice_number: 'INV-PIPELINE-001',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2024-02-15',
        due_date: null,
        document_vat_marking: null,
        document_id: null,
        status: 'draft',
        sent_at: null,
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

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

  it('holds an expense by creating an approval and moving the object to pending when policy requires approval', async () => {
    const result = await pipeline.runPipeline({
      businessObjectId: 1,
      businessObjectType: 'expense',
      draftGenerator: () => Promise.resolve(draft()),
      category: 'software',
      refetch: () =>
        db
          .selectFrom('expense')
          .selectAll()
          .where('id', '=', 1)
          .executeTakeFirstOrThrow(),
      confidence: 0.5,
      supplierKnown: true,
      requestedBy: 'policy@test.com',
    });

    expect(result.voucher).toBeNull();
    expect(result.policy.action).toBe('hold-for-approval');

    const expense = await db
      .selectFrom('expense')
      .select(['status'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(expense.status).toBe('pending');

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'expense')
      .where('object_id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('pending');
    expect(approval.requested_by).toBe('policy@test.com');
  });

  it('holds a sales invoice by creating an approval and moving the object to pending when policy requires approval', async () => {
    const invoiceId = await insertDraftSalesInvoice(db);

    const result = await pipeline.runPipeline({
      businessObjectId: invoiceId,
      businessObjectType: 'sales_invoice',
      draftGenerator: () => Promise.resolve(salesInvoiceDraft()),
      category: 'revenue',
      refetch: () =>
        db
          .selectFrom('sales_invoice')
          .selectAll()
          .where('id', '=', invoiceId)
          .executeTakeFirstOrThrow(),
      confidence: 0.5,
      supplierKnown: true,
      requestedBy: 'policy@test.com',
    });

    expect(result.voucher).toBeNull();
    expect(result.policy.action).toBe('hold-for-approval');

    const invoice = await db
      .selectFrom('sales_invoice')
      .select(['status'])
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('pending');

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'sales_invoice')
      .where('object_id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('pending');
    expect(approval.requested_by).toBe('policy@test.com');
  });

  it('creates one open pending_approval finding for an expense hold', async () => {
    await pipeline.runPipeline({
      businessObjectId: 1,
      businessObjectType: 'expense',
      draftGenerator: () => Promise.resolve(draft()),
      category: 'software',
      refetch: () =>
        db
          .selectFrom('expense')
          .selectAll()
          .where('id', '=', 1)
          .executeTakeFirstOrThrow(),
      confidence: 0.5,
      supplierKnown: true,
      requestedBy: 'policy@test.com',
    });

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'expense')
      .where('object_id', '=', 1)
      .executeTakeFirstOrThrow();

    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'pending_approval')
      .where('referenced_object_type', '=', 'approval')
      .where('referenced_object_id', '=', approval.id)
      .where('status', '=', 'open')
      .execute();

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].description).toContain('expense');
    expect(findings[0].description).toContain(String(approval.id));
  });

  it('creates one open pending_approval finding for a sales invoice hold', async () => {
    const invoiceId = await insertDraftSalesInvoice(db);

    await pipeline.runPipeline({
      businessObjectId: invoiceId,
      businessObjectType: 'sales_invoice',
      draftGenerator: () => Promise.resolve(salesInvoiceDraft()),
      category: 'revenue',
      refetch: () =>
        db
          .selectFrom('sales_invoice')
          .selectAll()
          .where('id', '=', invoiceId)
          .executeTakeFirstOrThrow(),
      confidence: 0.5,
      supplierKnown: true,
      requestedBy: 'policy@test.com',
    });

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'sales_invoice')
      .where('object_id', '=', invoiceId)
      .executeTakeFirstOrThrow();

    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'pending_approval')
      .where('referenced_object_type', '=', 'approval')
      .where('referenced_object_id', '=', approval.id)
      .where('status', '=', 'open')
      .execute();

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].description).toContain('sales_invoice');
    expect(findings[0].description).toContain(String(approval.id));
  });

  it('does not create a second open finding when /post is retried on an already-held expense', async () => {
    const params = {
      businessObjectId: 1,
      businessObjectType: 'expense' as const,
      draftGenerator: () => Promise.resolve(draft()),
      category: 'software',
      refetch: () =>
        db
          .selectFrom('expense')
          .selectAll()
          .where('id', '=', 1)
          .executeTakeFirstOrThrow(),
      confidence: 0.5,
      supplierKnown: true,
      requestedBy: 'policy@test.com',
    };

    await pipeline.runPipeline(params);

    await expect(pipeline.runPipeline(params)).rejects.toThrow(
      ConflictException,
    );

    const approvals = await db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', 'expense')
      .where('object_id', '=', 1)
      .execute();
    expect(approvals).toHaveLength(1);

    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'pending_approval')
      .where('status', '=', 'open')
      .execute();
    expect(findings).toHaveLength(1);
    expect(findings[0].referenced_object_id).toBe(approvals[0].id);
  });
});
