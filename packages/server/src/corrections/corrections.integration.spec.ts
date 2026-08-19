import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { CreditNotesService } from '../credit-notes/credit-notes.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { CorrectionsService } from './corrections.service';
import { CorrectionRequest } from './types';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('Corrections (integration)', () => {
  let db: Kysely<Database>;
  let correctionsService: CorrectionsService;
  let expensesService: ExpensesService;
  let salesInvoicesService: SalesInvoicesService;
  let postingService: PostingService;
  let voucherRepo: VoucherRepository;
  let lineRepo: VoucherLineRepository;

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
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        VoucherProjectionService,
        AuditLogService,
        ExpensesService,
        SalesInvoicesService,
        CreditNotesService,
        CorrectionsService,
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

    correctionsService = module.get(CorrectionsService);
    expensesService = module.get(ExpensesService);
    salesInvoicesService = module.get(SalesInvoicesService);
    postingService = module.get(PostingService);
    voucherRepo = module.get(VoucherRepository);
    lineRepo = module.get(VoucherLineRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('draft correction', () => {
    it('edits the expense object and returns a new draft voucher', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong amount',
        patch: { gross_amount: 15000, vat_amount: 3000 },
      };

      const result = await correctionsService.correctExpense(
        expense.id,
        request,
      );

      expect(result.outcome).toBe('draft_edited');
      expect(result.draftVoucher).toBeDefined();

      const updated = await expensesService.getExpenseById(expense.id);
      expect(updated.status).toBe('draft');
      expect(updated.gross_amount).toBe(15000);
      expect(updated.vat_amount).toBe(3000);

      // No vouchers should be posted for a draft correction
      const vouchers = await voucherRepo.getVouchers();
      expect(vouchers).toHaveLength(0);
    });
  });

  describe('posted correction', () => {
    it('creates a mirrored reversal + corrected voucher with proper back-references', async () => {
      // 1. Create and post an expense
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });

      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      // 2. Correct the posted expense
      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong amount',
        patch: { gross_amount: 15000, vat_amount: 3000 },
      };

      const result = await correctionsService.correctExpense(
        expense.id,
        request,
      );

      expect(result.outcome).toBe('posted_reversal_and_correction');
      expect(result.reversalVoucherId).toBeDefined();
      expect(result.correctedVoucherId).toBeDefined();

      // 3. Verify reversal voucher
      const reversalId = result.reversalVoucherId as number;
      const reversal = await voucherRepo.getVoucherById(reversalId);
      expect(reversal).not.toBeNull();
      expect(reversal!.voucher_number).toMatch(/^V-2026-\d{6}$/);
      expect(reversal!.voucher_number).not.toBe(posted.voucher_number);
      expect(reversal!.reverses_id).toBe(posted.id);
      expect(reversal!.reason).toBe('Wrong amount');
      expect(reversal!.corrects_object_type).toBeNull();
      expect(reversal!.corrects_object_id).toBeNull();

      // 4. Verify reversal lines are mirrored
      const reversalLines = await lineRepo.getLinesByVoucherId(reversalId);
      const originalLines = await lineRepo.getLinesByVoucherId(posted.id);
      expect(reversalLines).toHaveLength(originalLines.length);

      for (let i = 0; i < originalLines.length; i++) {
        const orig = originalLines[i];
        const rev = reversalLines[i];
        expect(rev.account_id).toBe(orig.account_id);
        expect(rev.amount).toBe(orig.amount);
        expect(rev.currency).toBe(orig.currency);
        expect(rev.base_amount).toBe(orig.base_amount);
        expect(rev.fx_rate).toBe(orig.fx_rate);
        expect(rev.vat_code).toBe(orig.vat_code);
        expect(rev.is_debit).toBe(!orig.is_debit); // flipped
      }

      // 5. Verify corrected voucher
      const correctedId = result.correctedVoucherId as number;
      const corrected = await voucherRepo.getVoucherById(correctedId);
      expect(corrected).not.toBeNull();
      expect(corrected!.voucher_number).toMatch(/^V-2026-\d{6}$/);
      expect(corrected!.voucher_number).not.toBe(posted.voucher_number);
      expect(corrected!.corrects_object_type).toBe('expense');
      expect(corrected!.corrects_object_id).toBe(expense.id);
      expect(corrected!.reason).toBe('Wrong amount');
      expect(corrected!.reverses_id).toBeNull();

      // 6. Verify expense is marked reversed and points to corrected voucher
      const updatedExpense = await expensesService.getExpenseById(expense.id);
      expect(updatedExpense.status).toBe('reversed');
      expect(updatedExpense.voucher_id).toBe(correctedId);
      expect(updatedExpense.gross_amount).toBe(15000);
      expect(updatedExpense.vat_amount).toBe(3000);
    });

    it('rolls back the amount patch if posting fails inside the transaction', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      // Force the in-transaction post to fail AFTER the patch hook has run.
      const spy = jest
        .spyOn(postingService, 'postVoucherTx')
        .mockRejectedValue(new Error('boom inside trx'));

      await expect(
        correctionsService.correctExpense(expense.id, {
          kind: 'financial',
          reason: 'Wrong amount',
          patch: { gross_amount: 15000, vat_amount: 3000 },
        }),
      ).rejects.toThrow('boom inside trx');

      // The whole operation rolled back: amounts unchanged, still posted on the
      // original voucher, no reversal/correction vouchers written.
      const after = await expensesService.getExpenseById(expense.id);
      expect(after.gross_amount).toBe(12300);
      expect(after.vat_amount).toBe(2300);
      expect(after.status).toBe('posted');
      expect(after.voucher_id).toBe(posted.id);
      expect(await voucherRepo.getVouchers()).toHaveLength(1);

      spy.mockRestore();
    });
  });

  describe('reversal-only (duplicate / erroneous posting)', () => {
    it('posts a mirrored reversal alone, leaves the object reversed on its ORIGINAL voucher', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 5200,
        vat_amount: 1000,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      const result = await correctionsService.correctExpense(expense.id, {
        kind: 'reversal',
        reason: 'Duplicate of expense 85 (same purchase, order + invoice)',
      });

      expect(result.outcome).toBe('posted_reversal');
      expect(result.reversalVoucherId).toBeDefined();
      // No replacement voucher: that is the whole point of a reversal-only.
      expect(result.correctedVoucherId).toBeUndefined();

      const reversal = await voucherRepo.getVoucherById(
        result.reversalVoucherId as number,
      );
      expect(reversal!.reverses_id).toBe(posted.id);
      expect(reversal!.corrects_object_type).toBeNull();
      expect(reversal!.corrects_object_id).toBeNull();

      // Mirrored lines net the original to zero.
      const revLines = await lineRepo.getLinesByVoucherId(reversal!.id);
      const origLines = await lineRepo.getLinesByVoucherId(posted.id);
      expect(revLines).toHaveLength(origLines.length);
      for (let i = 0; i < origLines.length; i++) {
        expect(revLines[i].account_id).toBe(origLines[i].account_id);
        expect(revLines[i].base_amount).toBe(origLines[i].base_amount);
        expect(revLines[i].is_debit).toBe(!origLines[i].is_debit);
      }

      // The object is terminal, still pointing at the voucher it actually
      // produced — there is no corrected voucher to re-point it at.
      const after = await expensesService.getExpenseById(expense.id);
      expect(after.status).toBe('reversed');
      expect(after.voucher_id).toBe(posted.id);
      expect(after.gross_amount).toBe(5200);
    });

    it('refuses to reverse an already-reversed object', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 5200,
        vat_amount: 1000,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      await correctionsService.correctExpense(expense.id, {
        kind: 'reversal',
        reason: 'first',
      });
      const second = await correctionsService.correctExpense(expense.id, {
        kind: 'reversal',
        reason: 'second',
      });
      expect(second.outcome).toBe('unsupported_status');
    });

    it('redirects a reversal out of a locked period into the current open one', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 5200,
        vat_amount: 1000,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-03',
          start_date: '2026-03-01',
          end_date: '2026-03-31',
          status: 'locked',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-04',
          start_date: '2026-04-01',
          end_date: '2026-04-30',
          status: 'open',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      const result = await correctionsService.correctExpense(expense.id, {
        kind: 'reversal',
        reason: 'duplicate found after filing',
      });

      expect(result.outcome).toBe('posted_reversal');
      expect(result.redirected).toBe(true);
      const reversal = await voucherRepo.getVoucherById(
        result.reversalVoucherId as number,
      );
      expect(reversal!.tax_point_date).toBe('2026-04-01');
    });
  });

  describe('locked-period redirect (ADR-0009)', () => {
    it('re-dates reversal + correction into the current open period', async () => {
      // 1. Create and post an expense dated in what will become a locked period.
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      // 2. File (lock) the period containing the original, and open a later one.
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'locked',
          filed_at: 0,
          created_at: 0,
        })
        .execute();
      const openPeriod = await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q2',
          start_date: '2026-04-01',
          end_date: '2026-06-30',
          status: 'open',
          filed_at: null,
          created_at: 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 3. Correct the now-locked posted expense.
      const result = await correctionsService.correctExpense(expense.id, {
        kind: 'financial',
        reason: 'Wrong amount, found after filing',
        patch: { gross_amount: 15000, vat_amount: 3000 },
      });

      expect(result.outcome).toBe('posted_reversal_and_correction');
      expect(result.redirected).toBe(true);
      expect(result.redirectedToPeriodId).toBe(openPeriod.id);

      // 4. Both new vouchers are dated into the open period, not the locked one.
      const reversal = await voucherRepo.getVoucherById(
        result.reversalVoucherId as number,
      );
      const corrected = await voucherRepo.getVoucherById(
        result.correctedVoucherId as number,
      );
      expect(reversal!.tax_point_date).toBe('2026-04-01');
      expect(corrected!.tax_point_date).toBe('2026-04-01');
      expect(reversal!.reverses_id).toBe(posted.id);
      expect(corrected!.corrects_object_type).toBe('expense');
      expect(corrected!.corrects_object_id).toBe(expense.id);

      // 5. The original locked voucher is untouched.
      const original = await voucherRepo.getVoucherById(posted.id);
      expect(original!.tax_point_date).toBe('2026-03-15');
    });

    it('throws when there is no open period to receive the correction', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      // Lock everything: the migration-seeded period plus the original's period.
      await db
        .updateTable('reporting_period')
        .set({ status: 'locked' })
        .execute();
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'locked',
          filed_at: 0,
          created_at: 0,
        })
        .execute();

      await expect(
        correctionsService.correctExpense(expense.id, {
          kind: 'financial',
          reason: 'No open period',
          patch: { gross_amount: 15000 },
        }),
      ).rejects.toThrow(/no open period/i);
    });
  });

  describe('correct-a-correction policy (ADR-0006)', () => {
    it('refuses to correct an already-corrected object: it is left terminal (reversed), not re-correctable', async () => {
      const expense = await expensesService.createExpense({
        category: 'software',
        gross_amount: 12300,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
      });
      const draft = await expensesService.generateDraftVoucher(expense.id);
      const posted = await postingService.postVoucher(draft);
      await expensesService.updateExpenseStatus(
        expense.id,
        'posted',
        posted.id,
      );

      // First correction: posted → reversed, re-pointed at the corrected voucher.
      const first = await correctionsService.correctExpense(expense.id, {
        kind: 'financial',
        reason: 'Wrong amount',
        patch: { gross_amount: 15000, vat_amount: 3000 },
      });
      expect(first.outcome).toBe('posted_reversal_and_correction');

      const afterFirst = await expensesService.getExpenseById(expense.id);
      expect(afterFirst.status).toBe('reversed');

      // Second correction on the same object: the object is terminal
      // (`reversed`), so the kernel reports it as unsupported rather than
      // stacking a correction on a correction — and posts NO further vouchers.
      const before = await voucherRepo.getVouchers();
      const second = await correctionsService.correctExpense(expense.id, {
        kind: 'financial',
        reason: 'Correct the correction',
        patch: { gross_amount: 20000 },
      });
      expect(second.outcome).toBe('unsupported_status');

      const after = await voucherRepo.getVouchers();
      expect(after).toHaveLength(before.length);
    });
  });

  describe('sales invoice posted correction', () => {
    it('creates reversal + corrected voucher for a posted sales invoice', async () => {
      const invoice = await salesInvoicesService.createInvoice({
        customer_id: null,
        invoice_number: 'INV-2026-001',
        gross_amount: 20000,
        vat_amount: 4000,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        due_date: '2026-04-15',
      });

      const draft = await salesInvoicesService.generateDraftVoucher(invoice.id);
      const posted = await postingService.postVoucher(draft);
      await salesInvoicesService.updateInvoiceStatus(
        invoice.id,
        'posted',
        posted.id,
      );

      const request: CorrectionRequest = {
        kind: 'financial',
        reason: 'Wrong gross amount',
        patch: { gross_amount: 25000, vat_amount: 5000 },
      };

      const result = await correctionsService.correctSalesInvoice(
        invoice.id,
        request,
      );

      expect(result.outcome).toBe('posted_reversal_and_correction');

      const reversal = await voucherRepo.getVoucherById(
        result.reversalVoucherId as number,
      );
      expect(reversal!.reverses_id).toBe(posted.id);
      expect(reversal!.voucher_number).toMatch(/^V-2026-\d{6}$/);
      expect(reversal!.voucher_number).not.toBe(posted.voucher_number);

      const corrected = await voucherRepo.getVoucherById(
        result.correctedVoucherId as number,
      );
      expect(corrected!.corrects_object_type).toBe('sales_invoice');
      expect(corrected!.corrects_object_id).toBe(invoice.id);
      expect(corrected!.voucher_number).toMatch(/^V-2026-\d{6}$/);
      expect(corrected!.voucher_number).not.toBe(posted.voucher_number);

      const updatedInvoice = await salesInvoicesService.getInvoiceById(
        invoice.id,
      );
      expect(updatedInvoice.status).toBe('reversed');
      expect(updatedInvoice.voucher_id).toBe(result.correctedVoucherId);
    });
  });
});
