import { fxTestProviders } from '../../test/fx-fixtures';
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
import { AuditLogService } from '../audit-log/audit-log.service';

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
        ...fxTestProviders(),
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
    // ── Issue #403 approval fidelity: the draft is generated BEFORE the
    // posting transaction, so an edit, a settlement re-selection, or a
    // bank-line allocation landing in that window must refuse the approval
    // INSIDE the transaction — the pending approval and the object's current
    // state survive, nothing stale posts. Deterministic sequential
    // equivalents of the two races (the real interleavings are covered by
    // root's probes against the actual FX-authority pause seam).
    async function seedDkkPurchaseWithBankLine(): Promise<{
      expenseId: number;
      bankTxnId: number;
    }> {
      await db.updateTable('organization').set({ country: 'EE' }).execute();
      const now = Math.floor(Date.now() / 1000);
      const supplier = await db
        .insertInto('entity')
        .values({
          role: 'supplier',
          country: 'DK',
          name: 'Next House Copenhagen',
          goods_vs_services: 'services',
          tax_status: 'taxable_business',
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('entity_identifier')
        .values({
          entity_id: supplier.id,
          kind: 'registration_key',
          value: 'DK403APPROVAL',
          confirmed: 1,
        })
        .execute();
      const account = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'BANK_EUR')
        .executeTakeFirstOrThrow();
      const stmt = await db
        .insertInto('bank_statement')
        .values({
          account_id: account.id,
          start_date: '2026-06-19',
          end_date: '2026-06-19',
          uploaded_at: 0,
          file_path: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id);
      const bankTxnId = await db
        .insertInto('bank_transaction')
        .values({
          statement_id: stmt,
          transaction_date: '2026-06-19',
          description: 'Next House Copenhagen DKK 60',
          amount: -811,
          currency: 'EUR',
          source_currency: 'DKK',
          source_amount: 6000,
          fx_rate: 0.1338333,
          fx_rate_decimals: 7,
          conversion_fee: 8,
          counterparty_iban: null,
          counterparty_descriptor: 'NEXT HOUSE COPENHAGEN',
          reference: null,
          status: 'open',
          created_at: 0,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id);
      const expense = await expensesService.createExpense({
        category: 'travel',
        gross_amount: 6000,
        vat_amount: 1200,
        currency: 'DKK',
        tax_point_date: '2026-06-19',
        supplier_id: supplier.id,
        service_place_rule: 'immovable_property',
        place_of_supply_country: 'DK',
      });
      return { expenseId: expense.id, bankTxnId };
    }

    it('refuses an approval whose bank-settlement evidence got allocated in the post-generation window (issue #403)', async () => {
      // Synthetic declared facts (not a production receipt claim): a
      // DK-accommodation-declared DKK purchase with same-day bank evidence.
      const { expenseId, bankTxnId } = await seedDkkPurchaseWithBankLine();
      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expenseId,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      // The racing allocation, landed BETWEEN the approval's draft
      // generation and its posting transaction (another purchase's settled
      // match — the books now own part of the line's cash). Injected at the
      // REAL generation seam: the spy performs the real generation, then the
      // allocation lands exactly in the post-generation window.
      const realGenerate =
        expensesService.generateDraftVoucher.bind(expensesService);
      const generateSpy = jest
        .spyOn(expensesService, 'generateDraftVoucher')
        .mockImplementation(async (id: number) => {
          const draft = await realGenerate(id);
          const voucher = await db
            .insertInto('voucher')
            .values({
              voucher_number: 'V403APPROVAL',
              tax_point_date: '2026-06-19',
              posted_at: 0,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
            .then((r) => r.id);
          await db
            .insertInto('reconciliation_match')
            .values({
              bank_transaction_id: bankTxnId,
              voucher_id: voucher,
              match_type: 'exact',
              amount_matched: 803,
              cash_base_amount: 795,
              status: 'active',
              signal: 'manual',
              created_at: 0,
            })
            .execute();
          return draft;
        });

      // The approval refuses INSIDE its posting transaction: nothing
      // posted, the approval stays PENDING (retry or resolve the conflict).
      const err = await service
        .approveApproval(approval.id, 'user@test.com')
        .catch((e: unknown) => e as Error);
      generateSpy.mockRestore();
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/allocated on the books/i);
      const after = await db
        .selectFrom('approval')
        .select('status')
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe('pending');
      const expenseRow = await db
        .selectFrom('expense')
        .select(['status', 'voucher_id'])
        .where('id', '=', expenseId)
        .executeTakeFirstOrThrow();
      expect(expenseRow.status).toBe('pending');
      expect(expenseRow.voucher_id).toBeNull();
      // No voucher posted for the expense: only the racing allocation's
      // seeded one exists.
      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(1);
    });

    it('refuses an approval whose settlement SELECTION changed in the post-generation window (issue #403)', async () => {
      // Synthetic declared facts (not a production receipt claim): a
      // DK-accommodation-declared DKK purchase with same-day bank evidence;
      // the ambiguous twin appears only inside the race window.
      const { expenseId } = await seedDkkPurchaseWithBankLine();
      const approval = await service.createApproval({
        object_type: 'expense',
        object_id: expenseId,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      // The operator's re-selection lands BETWEEN the approval's draft
      // generation (on the automatically-claimed first line) and its
      // posting transaction — injected at the REAL generation seam: the
      // spy performs the real generation (only the first line exists, so
      // it resolves and claims it), then the ambiguous twin APPEARS and
      // the operator selects it, exactly the interleaving.
      const realGenerate =
        expensesService.generateDraftVoucher.bind(expensesService);
      let selectedRow = -1;
      const generateSpy = jest
        .spyOn(expensesService, 'generateDraftVoucher')
        .mockImplementation(async (id: number) => {
          const draft = await realGenerate(id);
          const account = await db
            .selectFrom('account')
            .select('id')
            .where('code', '=', 'BANK_EUR')
            .executeTakeFirstOrThrow();
          const stmt = await db
            .insertInto('bank_statement')
            .values({
              account_id: account.id,
              start_date: '2026-06-19',
              end_date: '2026-06-19',
              uploaded_at: 0,
              file_path: null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
            .then((r) => r.id);
          const twinRow = await db
            .insertInto('bank_transaction')
            .values({
              statement_id: stmt,
              transaction_date: '2026-06-19',
              description: 'Next House Copenhagen DKK 60 again',
              amount: -830,
              currency: 'EUR',
              source_currency: 'DKK',
              source_amount: 6000,
              fx_rate: 0.137,
              fx_rate_decimals: 3,
              conversion_fee: 8,
              counterparty_iban: null,
              counterparty_descriptor: 'NEXT HOUSE COPENHAGEN',
              reference: null,
              status: 'open',
              created_at: 0,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
            .then((r) => r.id);
          await expensesService.selectSettlementFx(id, twinRow);
          selectedRow = twinRow;
          return draft;
        });

      // The approval refuses on the stale evidence: nothing posts, the
      // pending approval and the CURRENT selection survive.
      const err = await service
        .approveApproval(approval.id, 'user@test.com')
        .catch((e: unknown) => e as Error);
      generateSpy.mockRestore();
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /was changed while it was being posted/i,
      );
      const after = await db
        .selectFrom('approval')
        .select('status')
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe('pending');
      // The CURRENT selection survives untouched.
      const claims = await db
        .selectFrom('bank_settlement_usage')
        .selectAll()
        .execute();
      expect(claims).toHaveLength(1);
      expect(claims[0].bank_transaction_id).toBe(selectedRow);
      // No voucher posted at all.
      expect(
        (await db.selectFrom('voucher').select('id').execute()).length,
      ).toBe(0);
    });

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
