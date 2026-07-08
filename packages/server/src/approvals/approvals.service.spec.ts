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
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { AllowanceLimitService } from '../allowances/allowance-limit.service';
import { AllowanceProjectionService } from '../allowances/allowance-projection.service';
import { BusinessTripService } from '../allowances/business-trip.service';
import { AllowanceService } from '../allowances/allowance.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CategoryService } from '../categories/category.service';
import { seedEntity } from '../../test/helpers/seed-entity';

describe('ApprovalsService (integration)', () => {
  let db: Kysely<Database>;
  let service: ApprovalsService;
  let expensesService: ExpensesService;
  let allowanceService: AllowanceService;
  let tripService: BusinessTripService;
  let reconciliationStub: {
    activateMatch: jest.Mock;
    discardDraftMatch: jest.Mock;
  };

  beforeEach(async () => {
    reconciliationStub = {
      activateMatch: jest.fn().mockResolvedValue({
        matchId: 1,
        fxVoucherId: null,
      }),
      discardDraftMatch: jest.fn().mockResolvedValue(undefined),
    };
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
        { provide: ReconciliationService, useValue: reconciliationStub },
        AllowanceLimitService,
        AllowanceProjectionService,
        BusinessTripService,
        AuditFindingsService,
        AllowanceService,
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
    allowanceService = module.get(AllowanceService);
    tripService = module.get(BusinessTripService);
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

  async function insertPendingApprovalFinding(
    approvalId: number,
  ): Promise<number> {
    const row = await db
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
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

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

    it('resolves the matching pending_approval finding when an approval is approved', async () => {
      const expense = await expensesService.createExpense(sampleExpense());
      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });
      const findingId = await insertPendingApprovalFinding(approval.id);

      await service.approveApproval(approval.id, 'admin@test.com');

      const finding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', findingId)
        .executeTakeFirstOrThrow();
      expect(finding.status).toBe('resolved');
      expect(finding.resolved_at).not.toBeNull();
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

  // ── approveBatch ─────────────────────────────────────────────────

  describe('approveBatch', () => {
    it('approves several approvals in one call', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const expense = await expensesService.createExpense(sampleExpense());
        const approval = await service.createApproval({
          object_type: 'expense',
          object_id: expense.id,
          requested_by: 'user@test.com',
          reason: `Batch ${i}`,
        });
        ids.push(approval.id);
      }

      const results = await service.approveBatch(ids, 'admin@test.com');

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.ok)).toBe(true);
      for (const r of results) {
        expect(r.ok && r.approval.status).toBe('approved');
        expect(r.ok && r.voucher).not.toBeNull();
      }
    });

    it('does not abort the batch when one id fails — reports per-id outcome', async () => {
      const expense = await expensesService.createExpense(sampleExpense());
      const good = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'good',
      });

      const results = await service.approveBatch(
        [good.id, 999],
        'admin@test.com',
      );

      expect(results).toHaveLength(2);
      const okRow = results.find((r) => r.id === good.id)!;
      const badRow = results.find((r) => r.id === 999)!;
      expect(okRow.ok).toBe(true);
      expect(badRow.ok).toBe(false);
      expect(badRow.ok === false && badRow.error).toMatch(/not found/i);
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

    it('resolves the matching pending_approval finding when an approval is rejected', async () => {
      const expense = await expensesService.createExpense(sampleExpense());
      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });
      const findingId = await insertPendingApprovalFinding(approval.id);

      await service.rejectApproval(approval.id, 'Wrong category');

      const finding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', findingId)
        .executeTakeFirstOrThrow();
      expect(finding.status).toBe('resolved');
      expect(finding.resolved_at).not.toBeNull();
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

    it('resolves the matching pending_approval finding when an approval is superseded', async () => {
      const expense = await expensesService.createExpense(sampleExpense());
      const approval1 = await service.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'First',
      });
      const findingId = await insertPendingApprovalFinding(approval1.id);

      const newerExpense = await expensesService.createExpense({
        ...sampleExpense(),
        category: 'transport',
      });
      const approval2 = await service.createApproval({
        object_type: 'expense',
        object_id: newerExpense.id,
        requested_by: 'user@test.com',
        reason: 'Second',
      });

      await service.supersedeApproval(approval1.id, approval2.id);

      const finding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', findingId)
        .executeTakeFirstOrThrow();
      expect(finding.status).toBe('resolved');
      expect(finding.resolved_at).not.toBeNull();
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

  // ── allowance approvals ──────────────────────────────────────────
  //
  // The key invariant: split is recalculated at approval time, not at
  // creation time.  This catches the race where two allowances are
  // created simultaneously (each seeing 0 accumulated days) and one
  // would otherwise overclaim the high-rate quota.

  describe('allowance approvals', () => {
    it('recalculates split at approval when another allowance has accumulated days in the same month', async () => {
      const claimant = await seedEntity(db, { role: 'employee' });
      const now = Math.floor(Date.now() / 1000);

      // Create trip B (June 13–18 = 6 days, foreign destination → high-rate päevaraha applies)
      const tripB = await tripService.createBusinessTrip({
        claimantId: claimant.id,
        departureDate: '2026-06-13',
        returnDate: '2026-06-18',
        destinationCountry: 'DE',
      });

      // Create allowance B via service — at this point allowance A is NOT yet in DB,
      // so accumulated June days = 0 → all 6 days at high rate → gross = 6 × 7500 = 45000
      const allowanceB = await allowanceService.createAllowance({
        claimantId: claimant.id,
        tripId: tripB.id,
        type: 'daily_allowance',
      });
      expect(allowanceB.gross_amount).toBe(45000); // pre-condition: 6 × 7500

      // Seed allowance A directly (simulating a concurrent allowance that landed in DB
      // after B was created but before B is approved).
      // 12 days in June — will consume 12 of the 15 monthly high-rate quota.
      await db
        .insertInto('allowance')
        .values({
          claimant_id: claimant.id,
          trip_id: null,
          type: 'daily_allowance',
          days: 12,
          km: null,
          input_amount: null,
          route_description: null,
          gross_amount: 90000, // 12 × 7500
          tax_free_amount: 90000,
          taxable_amount: 0,
          // Accumulated June days are read from the breakdown JSON via json_each,
          // not the top-level `days` column.
          breakdown: JSON.stringify([{ month: '2026-06', days: 12 }]),
          period_start: '2026-06-01',
          period_end: '2026-06-12',
          status: 'posted',
          voucher_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      // Submit B → needs_triage; creates a pending approval row
      await allowanceService.submitAllowance(allowanceB.id);

      const pendingApproval = await db
        .selectFrom('approval')
        .selectAll()
        .where('object_type', '=', 'allowance')
        .where('object_id', '=', allowanceB.id)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();

      // Approve B → recalculation sees accumulated=12 (from A) plus excludes B itself
      // → remaining high-rate days = 15 − 12 = 3
      // → B split: 3 × 7500 (high-rate) + 3 × 4000 (fallback) = 22500 + 12000 = 34500
      await service.approveApproval(pendingApproval.id, 'approver@test.com');

      const reloaded = await db
        .selectFrom('allowance')
        .selectAll()
        .where('id', '=', allowanceB.id)
        .executeTakeFirstOrThrow();

      expect(reloaded.gross_amount).toBe(34500);
      expect(reloaded.tax_free_amount).toBe(34500);
      expect(reloaded.taxable_amount).toBe(0);
      expect(reloaded.status).toBe('posted');
    });
  });

  describe('reconciliation_match approvals', () => {
    async function seedMatchApproval(objectId: number) {
      const now = Math.floor(Date.now() / 1000);
      return db
        .insertInto('approval')
        .values({
          object_type: 'reconciliation_match',
          object_id: objectId,
          status: 'pending',
          requested_by: 'operator',
          created_at: now,
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    it('approve delegates to activateMatch and marks the approval approved', async () => {
      const approval = await seedMatchApproval(4242);

      const result = await service.approveApproval(approval.id, 'alice');

      expect(reconciliationStub.activateMatch).toHaveBeenCalledWith(4242);
      expect(result.approval.status).toBe('approved');
      expect(result.approval.approved_by).toBe('alice');
      expect(result.voucher).toBeNull();
    });

    it('reject delegates to discardDraftMatch and marks the approval rejected', async () => {
      const approval = await seedMatchApproval(4243);

      const result = await service.rejectApproval(approval.id, 'wrong match');

      expect(reconciliationStub.discardDraftMatch).toHaveBeenCalledWith(4243);
      expect(result.status).toBe('rejected');
      expect(result.rejected_reason).toBe('wrong match');
    });

    it('rejects creating a reconciliation_match approval through the generic endpoint', async () => {
      await expect(
        service.createApproval({
          object_type: 'reconciliation_match',
          object_id: 1,
          requested_by: 'operator',
          reason: 'nope',
        }),
      ).rejects.toThrow(/reconciliation engine/i);
    });
  });
});
