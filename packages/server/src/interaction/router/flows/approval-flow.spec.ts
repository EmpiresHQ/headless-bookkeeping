// allow: SIZE_OK — approval integration cases share one in-memory harness because the task verifies this exact spec path.
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../../database/types';
import { migrations } from '../../../database/migrations';
import { OrganizationService } from '../../../organization/organization.service';
import { OrgContextResolver } from '../../../organization/org-context.resolver';
import { PluginLoader } from '../../../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../../plugins/estonia-country.plugin';
import { CurrencyService } from '../../../currency/currency.service';
import { AccountService } from '../../../ledger/account/account.service';
import { LedgerValidationService } from '../../../ledger/validation/ledger-validation.service';
import { PostingService } from '../../../ledger/posting/posting.service';
import { StatusTransitionService } from '../../../ledger/status/status-transition.service';
import { PeriodLockService } from '../../../reporting-periods/period-lock.service';
import { RulesService } from '../../../rules/rules.service';
import { PolicyService } from '../../../policy/policy.service';
import { PostingPipelineService } from '../../../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../../../expenses/expenses.service';
import { SalesInvoicesService } from '../../../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../../../ledger/projection/voucher-projection.service';
import { ApprovalsService } from '../../../approvals/approvals.service';
import { ReconciliationService } from '../../../reconciliation/reconciliation.service';
import { AllowanceLimitService } from '../../../allowances/allowance-limit.service';
import { AllowanceProjectionService } from '../../../allowances/allowance-projection.service';
import { BusinessTripService } from '../../../allowances/business-trip.service';
import { AllowanceService } from '../../../allowances/allowance.service';
import { AuditFindingsService } from '../../../audit-findings/audit-findings.service';
import { CategoryService } from '../../../categories/category.service';
import { TelegramApprovalSupportService } from '../../telegram-approval-support.service';
import { ApprovalFlow } from './approval-flow';
import type { DispatchContext } from '../flow-dispatcher';
import type { RoutedIntent } from '../types';
import { AuditLogService } from '../../../audit-log/audit-log.service';

describe('ApprovalFlow', () => {
  let db: Kysely<Database>;
  let flow: ApprovalFlow;
  let approvalsService: ApprovalsService;
  let expensesService: ExpensesService;
  let salesInvoicesService: SalesInvoicesService;

  const reconcileStub = {
    activateMatch: jest.fn(),
    discardDraftMatch: jest.fn(),
  };

  const callbackCtx: DispatchContext = {
    conversation_id: 1,
    principal: {
      role: 'approver',
      authVerified: true,
      senderId: 'telegram:999',
    },
    origin: 'callback',
  };

  const messageCtx: DispatchContext = {
    ...callbackCtx,
    origin: 'message',
  };

  const approveIntent = (ref: string): RoutedIntent => ({
    kind: 'action',
    actionIntent: 'approve',
    fields: { ref },
  });

  const rejectIntent = (ref: string): RoutedIntent => ({
    kind: 'action',
    actionIntent: 'reject',
    fields: { ref },
  });

  beforeEach(async () => {
    reconcileStub.activateMatch.mockReset();
    reconcileStub.discardDraftMatch.mockReset();

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
    if (error) {
      throw error instanceof Error ? error : new Error('Migration failed');
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        AccountService,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        VoucherProjectionService,
        AuditLogService,
        ExpensesService,
        SalesInvoicesService,
        { provide: ReconciliationService, useValue: reconcileStub },
        AllowanceLimitService,
        AllowanceProjectionService,
        BusinessTripService,
        AuditFindingsService,
        AllowanceService,
        ApprovalsService,
        TelegramApprovalSupportService,
        ApprovalFlow,
        {
          provide: CategoryService,
          useValue: {
            list: () => Promise.resolve([]),
            isValid: () => Promise.resolve(true),
            assertValid: () => Promise.resolve(),
          },
        },
      ],
    }).compile();

    flow = module.get(ApprovalFlow);
    approvalsService = module.get(ApprovalsService);
    expensesService = module.get(ExpensesService);
    salesInvoicesService = module.get(SalesInvoicesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function insertPendingApprovalFinding(
    approvalId: number,
  ): Promise<void> {
    await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'pending_approval',
        severity: 'medium',
        description: `Approval ${approvalId} is waiting for a decision`,
        referenced_object_type: 'approval',
        referenced_object_id: approvalId,
        status: 'open',
        created_at: Math.floor(Date.now() / 1000),
        resolved_at: null,
        snoozed_at: null,
        transitioned_by: null,
        transition_reason: null,
      })
      .execute();
  }

  async function createPendingSalesInvoiceApproval(): Promise<number> {
    const invoice = await salesInvoicesService.createInvoice({
      invoice_number: 'INV-2026-001',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
    });
    const approval = await approvalsService.createApproval({
      object_type: 'sales_invoice',
      object_id: invoice.id,
      requested_by: 'user@test.com',
      reason: 'Manual approval needed',
    });
    await insertPendingApprovalFinding(approval.id);
    return approval.id;
  }

  async function createPendingCapexExpenseApproval(): Promise<number> {
    const expense = await expensesService.createExpense({
      category: 'vehicle',
      gross_amount: 2000000,
      vat_amount: 400000,
      currency: 'EUR',
      tax_point_date: '2026-04-12',
      asset_name: 'Van',
    });
    const approval = await approvalsService.createApproval({
      object_type: 'expense',
      object_id: expense.id,
      requested_by: 'user@test.com',
      reason: 'Manual approval needed',
    });
    await insertPendingApprovalFinding(approval.id);
    return approval.id;
  }

  it('returns handled:false for unrelated action intents', async () => {
    await expect(
      flow.dispatch(
        { kind: 'action', actionIntent: 'correct', fields: {} },
        callbackCtx,
      ),
    ).resolves.toEqual({ handled: false });
  });

  it('approves a supported sales-invoice approval from a callback origin', async () => {
    const approvalId = await createPendingSalesInvoiceApproval();

    const result = await flow.dispatch(
      approveIntent(String(approvalId)),
      callbackCtx,
    );

    expect(result.handled).toBe(true);
    expect(result.callbackSucceeded).toBe(true);
    expect(result.reply).toContain('approved');

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('approved');

    const invoice = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', approval.object_id)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('posted');
    expect(invoice.voucher_id).not.toBeNull();

    const finding = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('referenced_object_id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(finding.status).toBe('resolved');
  });

  it('rejects a supported sales-invoice approval from a callback origin', async () => {
    const approvalId = await createPendingSalesInvoiceApproval();

    const result = await flow.dispatch(
      rejectIntent(String(approvalId)),
      callbackCtx,
    );

    expect(result.handled).toBe(true);
    expect(result.callbackSucceeded).toBe(true);
    expect(result.reply).toContain('rejected');

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('rejected');

    const invoice = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', approval.object_id)
      .executeTakeFirstOrThrow();
    expect(invoice.status).toBe('draft');
    expect(invoice.voucher_id).toBeNull();

    const finding = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('referenced_object_id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(finding.status).toBe('resolved');
  });

  it('refuses free-text approve without mutating the approval', async () => {
    const approvalId = await createPendingSalesInvoiceApproval();

    const result = await flow.dispatch(
      approveIntent(String(approvalId)),
      messageCtx,
    );

    expect(result).toMatchObject({
      handled: true,
      callbackSucceeded: false,
    });
    expect(result.reply?.toLowerCase()).toContain('button');

    const approval = await db
      .selectFrom('approval')
      .select(['status'])
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('pending');

    const finding = await db
      .selectFrom('audit_finding')
      .select(['status'])
      .where('referenced_object_id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(finding.status).toBe('open');
  });

  it('refuses a capex expense approval without mutating state', async () => {
    const approvalId = await createPendingCapexExpenseApproval();

    const result = await flow.dispatch(
      approveIntent(String(approvalId)),
      callbackCtx,
    );

    expect(result).toMatchObject({
      handled: true,
      callbackSucceeded: false,
    });
    expect(result.reply?.toLowerCase()).toContain('fixed asset');

    const approval = await db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('pending');

    const expense = await db
      .selectFrom('expense')
      .selectAll()
      .where('id', '=', approval.object_id)
      .executeTakeFirstOrThrow();
    expect(expense.status).toBe('pending');
    expect(expense.voucher_id).toBeNull();

    const finding = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('referenced_object_id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(finding.status).toBe('open');
  });

  it('rejects malformed approval refs without side effects', async () => {
    const approvalId = await createPendingSalesInvoiceApproval();

    const result = await flow.dispatch(approveIntent('not-an-id'), callbackCtx);

    expect(result).toMatchObject({
      handled: true,
      callbackSucceeded: false,
    });
    expect(result.reply?.toLowerCase()).toContain('valid approval id');

    const approval = await db
      .selectFrom('approval')
      .select(['status'])
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('pending');
  });

  it('returns a handled conflict reply for already-resolved rejections', async () => {
    const approvalId = await createPendingSalesInvoiceApproval();

    await flow.dispatch(rejectIntent(String(approvalId)), callbackCtx);

    const result = await flow.dispatch(
      rejectIntent(String(approvalId)),
      callbackCtx,
    );

    expect(result).toMatchObject({
      handled: true,
      callbackSucceeded: false,
    });
    expect(result.reply?.toLowerCase()).toContain('cannot reject');

    const vouchers = await db.selectFrom('voucher').selectAll().execute();
    expect(vouchers).toHaveLength(0);
  });
});
