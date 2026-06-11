import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { CategoryService } from '../categories/category.service';

describe('ApprovalsController (integration)', () => {
  let db: Kysely<Database>;
  let controller: ApprovalsController;
  let expensesService: ExpensesService;

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
      controllers: [ApprovalsController],
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
        ExpensesService,
        SalesInvoicesService,
        ApprovalsService,
        {
          provide: CategoryService,
          useValue: {
            list: async () => [],
            isValid: async () => true,
            assertValid: async () => {},
          },
        },
      ],
    }).compile();

    controller = module.get(ApprovalsController);
    expensesService = module.get(ExpensesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const sampleExpense = () => ({
    category: 'software',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
  });

  // ── POST /api/approvals ──────────────────────────────────────────

  describe('POST /api/approvals', () => {
    it('creates a pending approval for an expense', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const result = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Amount exceeds ceiling',
      });

      expect(result.approval.status).toBe('pending');
      expect(result.approval.object_type).toBe('expense');
      expect(result.approval.object_id).toBe(expense.id);
      expect(result.approval.requested_by).toBe('user@test.com');
      expect(result.approval.approved_by).toBeNull();
      expect(result.approval.rejected_reason).toBeNull();
      expect(result.approval.superseded_by).toBeNull();
      expect(result.approval.resolved_at).toBeNull();
    });

    it('throws ConflictException for duplicate pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await expect(
        controller.createApproval({
          object_type: 'expense',
          object_id: expense.id,
          requested_by: 'user@test.com',
          reason: 'Duplicate',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── POST /api/approvals/:id/approve ──────────────────────────────

  describe('POST /api/approvals/:id/approve', () => {
    it('approves and posts the voucher', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const result = await controller.approveApproval(
        String(approvalResult.approval.id),
        { approved_by: 'admin@test.com' },
      );

      expect(result.approval.status).toBe('approved');
      expect(result.approval.approved_by).toBe('admin@test.com');
      expect(result.approval.resolved_at).not.toBeNull();
      expect(result.voucher).not.toBeNull();
      expect(result.voucher?.lines.length).toBeGreaterThan(0);
    });

    it('is idempotent — approving twice does not double-post', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const first = await controller.approveApproval(
        String(approvalResult.approval.id),
        { approved_by: 'admin@test.com' },
      );

      const second = await controller.approveApproval(
        String(approvalResult.approval.id),
        { approved_by: 'admin@test.com' },
      );

      expect(second.approval.status).toBe('approved');
      expect(second.voucher?.id).toBe(first.voucher?.id);
    });

    it('throws ConflictException for already-rejected approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await controller.rejectApproval(String(approvalResult.approval.id), {
        rejected_reason: 'Wrong category',
      });

      await expect(
        controller.approveApproval(String(approvalResult.approval.id), {
          approved_by: 'admin@test.com',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException for unknown approval id', async () => {
      await expect(
        controller.approveApproval('999', { approved_by: 'admin@test.com' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── POST /api/approvals/:id/reject ───────────────────────────────

  describe('POST /api/approvals/:id/reject', () => {
    it('rejects and returns expense to draft', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const result = await controller.rejectApproval(
        String(approvalResult.approval.id),
        { rejected_reason: 'Wrong category' },
      );

      expect(result.approval.status).toBe('rejected');
      expect(result.approval.rejected_reason).toBe('Wrong category');
      expect(result.approval.resolved_at).not.toBeNull();

      // Verify expense is back to draft
      const updatedExpense = await expensesService.getExpenseById(expense.id);
      expect(updatedExpense.status).toBe('draft');
    });

    it('throws ConflictException for already-approved approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await controller.approveApproval(String(approvalResult.approval.id), {
        approved_by: 'admin@test.com',
      });

      await expect(
        controller.rejectApproval(String(approvalResult.approval.id), {
          rejected_reason: 'Too late',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── POST /api/approvals/:id/supersede ────────────────────────────

  describe('POST /api/approvals/:id/supersede', () => {
    it('supersedes a pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval1 = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'First version',
      });

      // Create a second approval (for a different object to avoid conflict)
      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      const approval2 = await controller.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Second version',
      });

      const result = await controller.supersedeApproval(
        String(approval1.approval.id),
        { superseded_by: String(approval2.approval.id) },
      );

      expect(result.approval.status).toBe('superseded');
      expect(result.approval.superseded_by).toBe(approval2.approval.id);
      expect(result.approval.resolved_at).not.toBeNull();
    });

    it('throws ConflictException for already-resolved approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approvalResult = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await controller.approveApproval(String(approvalResult.approval.id), {
        approved_by: 'admin@test.com',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      const approval2 = await controller.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Second',
      });

      await expect(
        controller.supersedeApproval(String(approvalResult.approval.id), {
          superseded_by: String(approval2.approval.id),
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── GET /api/approvals ───────────────────────────────────────────

  describe('GET /api/approvals', () => {
    it('lists all approvals', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test 1',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await controller.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const result = await controller.listApprovals({});
      expect(result.approvals).toHaveLength(2);
    });

    it('filters by status', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval1 = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await controller.approveApproval(String(approval1.approval.id), {
        approved_by: 'admin@test.com',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await controller.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const pendingResult = await controller.listApprovals({
        status: 'pending',
      });
      expect(pendingResult.approvals).toHaveLength(1);

      const approvedResult = await controller.listApprovals({
        status: 'approved',
      });
      expect(approvedResult.approvals).toHaveLength(1);
    });

    it('filters by object_type', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const result = await controller.listApprovals({
        object_type: 'expense',
      });
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].object_type).toBe('expense');
    });
  });

  // ── GET /api/approvals/pending ───────────────────────────────────

  describe('GET /api/approvals/pending', () => {
    it('lists only pending approvals', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval1 = await controller.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await controller.approveApproval(String(approval1.approval.id), {
        approved_by: 'admin@test.com',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await controller.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const result = await controller.listPendingApprovals();
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].status).toBe('pending');
    });
  });
});
