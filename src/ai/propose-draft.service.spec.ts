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
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { EntitiesService } from '../entities/entities.service';
import { ProposeDraftService } from './propose-draft.service';
import { TriageResult } from '../triage/types';
import { BadRequestException } from '@nestjs/common';

describe('ProposeDraftService (integration)', () => {
  let db: Kysely<Database>;
  let module: TestingModule;
  let service: ProposeDraftService;
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

    module = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        AccountService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        ExpensesService,
        EntitiesService,
        ProposeDraftService,
      ],
    }).compile();

    service = module.get(ProposeDraftService);
    expensesService = module.get(ExpensesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const sampleTriageResult = (): TriageResult => ({
    kind: 'new_expense',
    document_type: 'receipt',
    gross_amount: 1525,
    vat_amount: 285,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    category: 'transport',
    document_vat_marking: 'IE_INPUT_23',
    confidence: 0.94,
  });

  describe('proposeDraft', () => {
    it('creates an expense and runs the posting pipeline', async () => {
      const result = await service.proposeDraft(sampleTriageResult());

      expect(result.expenseId).toBeGreaterThan(0);
      expect(result.pipelineResult).toBeDefined();
      expect(result.pipelineResult.businessObject).toBeDefined();

      // Verify the expense was created in the database.
      const expense = await expensesService.getExpenseById(result.expenseId);
      expect(expense.category).toBe('transport');
      expect(expense.gross_amount).toBe(1525);
      expect(expense.vat_amount).toBe(285);
      expect(expense.currency).toBe('EUR');
      expect(expense.tax_point_date).toBe('2026-03-15');
    });

    it('associates document_id and supplier_id when provided', async () => {
      // Create a supplier entity first (foreign key constraint).
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Test Supplier',
        registrationKey: 'IE12345',
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: { match_entity_id: supplier.id },
      };

      const result = await service.proposeDraft(triageResult, 10, supplier.id);

      const expense = await expensesService.getExpenseById(result.expenseId);
      expect(expense.document_id).toBe(10);
      expect(expense.supplier_id).toBe(supplier.id);
    });

    it('throws BadRequestException for non-new_expense kinds', async () => {
      const correctionResult: TriageResult = {
        ...sampleTriageResult(),
        kind: 'correction',
      };

      await expect(service.proposeDraft(correctionResult)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws for unknown kind', async () => {
      const unknownResult: TriageResult = {
        ...sampleTriageResult(),
        kind: 'unknown',
      };

      await expect(service.proposeDraft(unknownResult)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws for duplicate kind', async () => {
      const duplicateResult: TriageResult = {
        ...sampleTriageResult(),
        kind: 'duplicate',
      };

      await expect(service.proposeDraft(duplicateResult)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
