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
import { ApprovalsService } from './approvals.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CategoryService } from '../categories/category.service';

describe('ApprovalsService (integration)', () => {
  let db: Kysely<Database>;
  let service: ApprovalsService;
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
            list: () => Promise.resolve([]),
            isValid: () => Promise.resolve(true),
            assertValid: () => Promise.resolve(),
          },
        },
      ],
    }).compile();

    service = module.get(ApprovalsService);
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

  // ── createApproval ───────────────────────────────────────────────

  describe('createApproval', () => {
    it('creates a pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      expect(approval.status).toBe('pending');
      expect(approval.object_type).toBe('expense');
      expect(approval.object_id).toBe(expense.id);
      expect(approval.requested_by).toBe('user@test.com');
      expect(approval.resolved_at).toBeNull();
    });

    it('throws ConflictException for duplicate pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await expect(
        service.createApproval({
          object_type: 'expense',
          object_id: expense.id,
          requested_by: 'user@test.com',
          reason: 'Duplicate',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows a new approval after the previous one is resolved', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval1 = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.rejectApproval(approval1.id, 'Wrong category');

      // Should now be able to create a new approval for the same object
      const approval2 = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Retry',
      });

      expect(approval2.status).toBe('pending');
      expect(approval2.id).not.toBe(approval1.id);
    });
  });

  // ── approveApproval ──────────────────────────────────────────────

  describe('approveApproval', () => {
    it('approves and posts the voucher', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const result = await service.approveApproval(
        approval.id,
        'admin@test.com',
      );

      expect(result.approval.status).toBe('approved');
      expect(result.approval.approved_by).toBe('admin@test.com');
      expect(result.approval.resolved_at).not.toBeNull();
      expect(result.voucher).not.toBeNull();
      expect(result.voucher?.lines.length).toBeGreaterThan(0);

      // Verify debits = credits
      const debitTotal = result
        .voucher!.lines.filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = result
        .voucher!.lines.filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      expect(debitTotal).toBe(creditTotal);
    });

    it('is idempotent — second approve returns same voucher', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const first = await service.approveApproval(
        approval.id,
        'admin@test.com',
      );
      const second = await service.approveApproval(
        approval.id,
        'admin@test.com',
      );

      expect(second.approval.status).toBe('approved');
      expect(second.voucher?.id).toBe(first.voucher?.id);
    });

    it('throws ConflictException for non-pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.rejectApproval(approval.id, 'Wrong');

      await expect(
        service.approveApproval(approval.id, 'admin@test.com'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(
        service.approveApproval(999, 'admin@test.com'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── rejectApproval ───────────────────────────────────────────────

  describe('rejectApproval', () => {
    it('rejects and returns business object to draft', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const result = await service.rejectApproval(
        approval.id,
        'Wrong category',
      );

      expect(result.status).toBe('rejected');
      expect(result.rejected_reason).toBe('Wrong category');
      expect(result.resolved_at).not.toBeNull();

      const updatedExpense = await expensesService.getExpenseById(expense.id);
      expect(updatedExpense.status).toBe('draft');
    });

    it('throws ConflictException for already-approved approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.approveApproval(approval.id, 'admin@test.com');

      await expect(
        service.rejectApproval(approval.id, 'Too late'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── supersedeApproval ────────────────────────────────────────────

  describe('supersedeApproval', () => {
    it('supersedes a pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval1 = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'First',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      const approval2 = await service.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Second',
      });

      const result = await service.supersedeApproval(
        approval1.id,
        approval2.id,
      );

      expect(result.status).toBe('superseded');
      expect(result.superseded_by).toBe(approval2.id);
      expect(result.resolved_at).not.toBeNull();
    });

    it('throws ConflictException for non-pending approval', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.approveApproval(approval.id, 'admin@test.com');

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      const approval2 = await service.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Second',
      });

      await expect(
        service.supersedeApproval(approval.id, approval2.id),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── listApprovals ────────────────────────────────────────────────

  describe('listApprovals', () => {
    it('lists all approvals', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test 1',
      });

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await service.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const approvals = await service.listApprovals();
      expect(approvals).toHaveLength(2);
    });

    it('filters by status', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.approveApproval(approval.id, 'admin@test.com');

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await service.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const pending = await service.listApprovals({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');

      const approved = await service.listApprovals({ status: 'approved' });
      expect(approved).toHaveLength(1);
      expect(approved[0].status).toBe('approved');
    });

    it('filters by object_type', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const approvals = await service.listApprovals({
        object_type: 'expense',
      });
      expect(approvals).toHaveLength(1);
      expect(approvals[0].object_type).toBe('expense');
    });
  });

  // ── listPendingApprovals ─────────────────────────────────────────

  describe('listPendingApprovals', () => {
    it('returns only pending approvals', async () => {
      const expense = await expensesService.createExpense(sampleExpense());

      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      await service.approveApproval(approval.id, 'admin@test.com');

      const expense2 = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      await service.createApproval({
        object_type: 'expense',
        object_id: expense2.id,
        requested_by: 'user@test.com',
        reason: 'Test 2',
      });

      const pending = await service.listPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');
    });
  });
});
