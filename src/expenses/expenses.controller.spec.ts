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
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { NotFoundException } from '@nestjs/common';
import { CategoryService } from '../categories/category.service';

describe('ExpensesController (integration)', () => {
  let db: Kysely<Database>;
  let controller: ExpensesController;

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
      controllers: [ExpensesController],
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

    controller = module.get(ExpensesController);
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

  describe('POST /api/expenses', () => {
    it('creates an expense in draft status', async () => {
      const result = await controller.createExpense(sampleDto());
      expect(result.status).toBe('draft');
      expect(result.category).toBe('software');
      expect(result.gross_amount).toBe(12300);
      expect(result.vat_amount).toBe(2300);
    });
  });

  describe('GET /api/expenses', () => {
    it('lists expenses', async () => {
      await controller.createExpense(sampleDto());
      await controller.createExpense({
        ...sampleDto(),
        category: 'transport',
      });

      const result = await controller.getExpenses();
      expect(result.expenses).toHaveLength(2);
    });
  });

  describe('GET /api/expenses/:id', () => {
    it('returns the requested expense', async () => {
      const created = await controller.createExpense(sampleDto());
      const result = await controller.getExpense(String(created.id));
      expect(result.id).toBe(created.id);
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(controller.getExpense('999')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /api/expenses/:id/generate-draft', () => {
    it('returns a transient draft voucher', async () => {
      const expense = await controller.createExpense(sampleDto());
      const draft = await controller.generateDraft(String(expense.id));

      expect(draft.lines).toHaveLength(3);
      expect(draft.tax_point_date).toBe('2026-03-15');

      const debitTotal = draft.lines
        .filter((l) => l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      const creditTotal = draft.lines
        .filter((l) => !l.is_debit)
        .reduce((sum, l) => sum + l.base_amount, 0);
      expect(debitTotal).toBe(creditTotal);
    });

    it('throws NotFoundException for non-existent expense', async () => {
      await expect(controller.generateDraft('999')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
