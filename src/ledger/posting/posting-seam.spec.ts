import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { OrganizationService } from '../../organization/organization.service';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../plugins/estonia-country.plugin';
import { CurrencyService } from '../../currency/currency.service';
import { AccountService } from '../account/account.service';
import { LedgerValidationService } from '../validation/ledger-validation.service';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';
import { RulesService } from '../../rules/rules.service';
import { PolicyService } from '../../policy/policy.service';
import { PostingPipelineService } from '../pipeline/posting-pipeline.service';
import { ExpensesService } from '../../expenses/expenses.service';
import { SalesInvoicesService } from '../../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../projection/voucher-projection.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { ReconciliationService } from '../../reconciliation/reconciliation.service';
import { VoucherRepository } from '../voucher/voucher.repository';
import { PostingService, PostingSemantics } from './posting.service';
import { CategoryService } from '../../categories/category.service';
import { StatusTransitionService } from '../status/status-transition.service';
import { DraftVoucher } from '../voucher/types';
import { SemanticValidationContext } from '../../rules/types';

/**
 * Consolidation proofs for the single deep posting seam (ADR-0019).
 *
 * Proves the four behaviors the consolidation must guarantee:
 *  (a) account resolution lives in exactly one place (PostingService.resolveLines),
 *  (b) a direct low-level post cannot bypass semantic validation for an
 *      intake-driven voucher,
 *  (c) a system-generated voucher with no semantic context still posts,
 *  (d) approval posting and pipeline posting share the same idempotency
 *      guarantee (the single claim helper).
 */
describe('Posting seam consolidation (integration)', () => {
  let db: Kysely<Database>;
  let posting: PostingService;
  let pipeline: PostingPipelineService;
  let approvals: ApprovalsService;
  let expenses: ExpensesService;
  let voucherRepo: VoucherRepository;

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
        {
          provide: ReconciliationService,
          useValue: {
            activateMatch: jest.fn(),
            discardDraftMatch: jest.fn(),
          },
        },
        ApprovalsService,
        VoucherRepository,
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

    posting = module.get(PostingService);
    pipeline = module.get(PostingPipelineService);
    approvals = module.get(ApprovalsService);
    expenses = module.get(ExpensesService);
    voucherRepo = module.get(VoucherRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const intakeSemantics = (category: string): PostingSemantics => {
    const context: SemanticValidationContext = {
      countryCode: 'IE',
      supplierFacts: {
        country: 'IE',
        goodsVsServices: 'services',
        classificationMemory: [],
      },
      orgContext: { country: 'IE', vatRegistered: true, baseCurrency: 'EUR' },
      category,
    };
    return { kind: 'intake-driven', context };
  };

  // A balanced software expense voucher carrying a real VAT code.
  const intakeDraft = (vatCode: string): DraftVoucher => ({
    tax_point_date: '2026-03-15',
    lines: [
      {
        account_code: 'EXPENSE_SOFTWARE',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: vatCode,
        is_debit: true,
      },
      {
        account_code: 'CASH',
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
      },
    ],
  });

  // A system-generated FX voucher: no source document, no VAT code, no Category.
  const systemGeneratedDraft = (): DraftVoucher => ({
    tax_point_date: '2026-03-15',
    reason: 'Realized FX on settlement',
    lines: [
      {
        account_code: 'BANK_EUR',
        amount: 500,
        currency: 'EUR',
        base_amount: 500,
        fx_rate: 1,
        is_debit: true,
      },
      {
        account_code: 'FX_GAIN_LOSS',
        amount: 500,
        currency: 'EUR',
        base_amount: 500,
        fx_rate: 1,
        is_debit: false,
      },
    ],
  });

  // ── (a) Account resolution lives in one place ──────────────────────
  describe('(a) account resolution is centralized', () => {
    it('PostingService.resolveLines is the single resolver of code → account_id', async () => {
      const draft = systemGeneratedDraft();
      const { resolved, accounts } = await posting.resolveLines(draft);

      // Every code resolved to a real account id; the resolver is the one
      // place this lookup happens (the pipeline and approvals call into it).
      expect(resolved.every((l) => l.account_id > 0)).toBe(true);
      expect(accounts.length).toBeGreaterThan(0);
    });

    it('neither the pipeline nor approvals re-implements getAccountsByCodes', () => {
      // Grep-as-test: only PostingService.resolveLines calls getAccountsByCodes.
      // The pipeline and approvals must delegate to it, never re-implement the
      // code → account_id lookup.
      const pipelineSrc = readFileSync(
        join(__dirname, '../pipeline/posting-pipeline.service.ts'),
        'utf8',
      );
      const approvalsSrc = readFileSync(
        join(__dirname, '../../approvals/approvals.service.ts'),
        'utf8',
      );
      expect(pipelineSrc).not.toContain('getAccountsByCodes');
      expect(approvalsSrc).not.toContain('getAccountsByCodes');
    });
  });

  // ── (b) No silent semantic bypass for an intake-driven voucher ─────
  describe('(b) intake-driven posts cannot bypass semantic validation', () => {
    it('rejects an intake-driven voucher with an invalid VAT code (BadRequestException)', async () => {
      await expect(
        posting.postVoucher(
          intakeDraft('TOTALLY_BOGUS'),
          intakeSemantics('software'),
        ),
      ).rejects.toThrow(BadRequestException);

      // Nothing was written.
      expect(await voucherRepo.getVouchers()).toHaveLength(0);
    });

    it('posts an intake-driven voucher with a valid VAT code', async () => {
      const posted = await posting.postVoucher(
        intakeDraft('IE_INPUT_23'),
        intakeSemantics('software'),
      );
      expect(posted.id).toBeGreaterThan(0);
      expect(await voucherRepo.getVouchers()).toHaveLength(1);
    });
  });

  // ── (c) System-generated vouchers still post with no semantic context ──
  describe('(c) system-generated vouchers post without semantic context', () => {
    it('posts an FX-style voucher carrying no VAT code / no Category', async () => {
      const posted = await posting.postVoucher(systemGeneratedDraft());
      expect(posted.id).toBeGreaterThan(0);
      expect(posted.lines).toHaveLength(2);
      expect(await voucherRepo.getVouchers()).toHaveLength(1);
    });
  });

  // ── (d) Approval & pipeline posting share the idempotency guarantee ──
  describe('(d) approval and pipeline posting share the idempotency claim', () => {
    const sampleExpense = () => ({
      category: 'software',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2026-03-15',
    });

    it('approval posting is idempotent — a second approve never double-posts', async () => {
      const expense = await expenses.createExpense(sampleExpense());
      const approval = await approvals.createApproval({
        object_type: 'expense',
        object_id: expense.id,
        requested_by: 'user@test.com',
        reason: 'Test',
      });

      const first = await approvals.approveApproval(
        approval.id,
        'admin@test.com',
      );
      const second = await approvals.approveApproval(
        approval.id,
        'admin@test.com',
      );

      expect(second.voucher?.id).toBe(first.voucher?.id);
      expect(await voucherRepo.getVouchers()).toHaveLength(1);
    });

    it('pipeline posting is idempotent — a second auto-post raises Conflict, no second voucher', async () => {
      const expense = await expenses.createExpense(sampleExpense());

      const run = () =>
        pipeline.runPipeline({
          businessObjectId: expense.id,
          businessObjectType: 'expense',
          draftGenerator: () => expenses.generateDraftVoucher(expense.id),
          category: 'software',
          refetch: () => expenses.getExpenseById(expense.id),
          confidence: 1,
          supplierKnown: true,
        });

      const first = await run();
      expect(first.voucher).not.toBeNull();

      // A retried post on the already-posted object raises Conflict (ADR-0021),
      // the SAME guarantee approvals get via the shared claim helper.
      await expect(run()).rejects.toThrow(
        `Expense ${expense.id} is already posted`,
      );
      expect(await voucherRepo.getVouchers()).toHaveLength(1);
    });
  });
});
