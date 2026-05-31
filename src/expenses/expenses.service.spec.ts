import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { ExpensesService } from './expenses.service';
import { NotFoundException } from '@nestjs/common';

describe('ExpensesService (integration)', () => {
  let db: Kysely<Database>;
  let service: ExpensesService;

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
        PluginLoader,
        CurrencyService,
        ExpensesService,
      ],
    }).compile();

    service = module.get(ExpensesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const sampleDto = () => ({
    category: 'software',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
  });

  describe('createExpense', () => {
    it('creates an expense in draft status', async () => {
      const expense = await service.createExpense(sampleDto());
      expect(expense.status).toBe('draft');
      expect(expense.category).toBe('software');
      expect(expense.gross_amount).toBe(12300);
      expect(expense.vat_amount).toBe(2300);
      expect(expense.currency).toBe('EUR');
      expect(expense.voucher_id).toBeNull();
      expect(expense.created_at).toBeGreaterThan(0);
    });

    it('accepts optional document_id and supplier_id', async () => {
      const expense = await service.createExpense({
        ...sampleDto(),
        document_id: 42,
        supplier_id: 7,
      });
      expect(expense.document_id).toBe(42);
      expect(expense.supplier_id).toBe(7);
    });
  });

  describe('getExpenses', () => {
    it('returns all expenses in order', async () => {
      await service.createExpense(sampleDto());
      await service.createExpense({
        ...sampleDto(),
        category: 'transport',
      });

      const expenses = await service.getExpenses();
      expect(expenses).toHaveLength(2);
      expect(expenses[0].category).toBe('software');
      expect(expenses[1].category).toBe('transport');
    });

    it('returns an empty array when no expenses exist', async () => {
      const expenses = await service.getExpenses();
      expect(expenses).toEqual([]);
    });
  });

  describe('getExpenseById', () => {
    it('returns the requested expense', async () => {
      const created = await service.createExpense(sampleDto());
      const found = await service.getExpenseById(created.id);
      expect(found.id).toBe(created.id);
      expect(found.category).toBe('software');
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(service.getExpenseById(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('generateDraftVoucher', () => {
    it('returns a transient draft voucher with accrual lines', async () => {
      const expense = await service.createExpense(sampleDto());
      const draft = await service.generateDraftVoucher(expense.id);

      expect(draft.voucher_number).toBe('PENDING');
      expect(draft.tax_point_date).toBe('2026-03-15');
      expect(draft.lines).toHaveLength(3);

      // Dr Expense (net)
      const expenseLine = draft.lines.find(
        (l) => l.account_code === 'EXPENSE_SOFTWARE' && l.is_debit,
      );
      expect(expenseLine).toBeDefined();
      expect(expenseLine!.amount).toBe(10000); // 12300 - 2300
      expect(expenseLine!.currency).toBe('EUR');
      expect(expenseLine!.base_amount).toBe(10000);
      expect(expenseLine!.fx_rate).toBe(1);
      expect(expenseLine!.vat_code).toBe('IE_INPUT_23');

      // Dr VAT_RECEIVABLE
      const vatLine = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE' && l.is_debit,
      );
      expect(vatLine).toBeDefined();
      expect(vatLine!.amount).toBe(2300);
      expect(vatLine!.currency).toBe('EUR');
      expect(vatLine!.base_amount).toBe(2300);
      expect(vatLine!.fx_rate).toBe(1);
      expect(vatLine!.vat_code).toBe('IE_INPUT_23');

      // Cr AP (gross)
      const apLine = draft.lines.find(
        (l) => l.account_code === 'AP' && !l.is_debit,
      );
      expect(apLine).toBeDefined();
      expect(apLine!.amount).toBe(12300);
      expect(apLine!.currency).toBe('EUR');
      expect(apLine!.base_amount).toBe(12300);
      expect(apLine!.fx_rate).toBe(1);
      expect(apLine!.vat_code).toBeNull();
    });

    it('balances in base currency (debits == credits)', async () => {
      const expense = await service.createExpense(sampleDto());
      const draft = await service.generateDraftVoucher(expense.id);

      const debitTotal = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);

      expect(debitTotal).toBe(creditTotal);
      expect(debitTotal).toBe(12300);
    });

    it('falls back to EXPENSE_OTHER for unknown categories', async () => {
      const expense = await service.createExpense({
        ...sampleDto(),
        category: 'unknown-category-xyz',
      });
      const draft = await service.generateDraftVoucher(expense.id);

      const expenseLine = draft.lines.find(
        (l) => l.is_debit && l.account_code.startsWith('EXPENSE_'),
      );
      expect(expenseLine!.account_code).toBe('EXPENSE_OTHER');
    });

    it('does NOT write a voucher to the database', async () => {
      const expense = await service.createExpense(sampleDto());
      await service.generateDraftVoucher(expense.id);

      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);

      const lines = await db.selectFrom('voucher_line').selectAll().execute();
      expect(lines).toHaveLength(0);
    });

    it('throws NotFoundException for non-existent expense', async () => {
      await expect(service.generateDraftVoucher(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('skips VAT_RECEIVABLE line when vat_amount is zero', async () => {
      const expense = await service.createExpense({
        ...sampleDto(),
        vat_amount: 0,
        gross_amount: 10000,
      });
      const draft = await service.generateDraftVoucher(expense.id);

      // Only 2 lines: Dr Expense + Cr AP (no VAT_RECEIVABLE)
      expect(draft.lines).toHaveLength(2);

      const vatLine = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE',
      );
      expect(vatLine).toBeUndefined();

      // Verify balance with zero VAT
      const debitTotal = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      expect(debitTotal).toBe(creditTotal);
      expect(debitTotal).toBe(10000);
    });
  });
});
