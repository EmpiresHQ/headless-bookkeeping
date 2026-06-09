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
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { AgentConfigService } from './agent-config.service';
import {
  ProposeDraftService,
  ProposeDraftResult,
  ProposeDraftOutcome,
  SUPPLIER_CREATE_NOT_IMPLEMENTED,
} from './propose-draft.service';
import { TriageResult } from '../triage/types';
import { BadRequestException } from '@nestjs/common';

/**
 * proposeDraft now returns a discriminated ProposeDraftOutcome. The working
 * path always yields a 'draft'; this narrows it (and fails the test loudly if
 * a supplier-unresolved slipped through where a draft was expected).
 */
function expectDraft(outcome: ProposeDraftOutcome): ProposeDraftResult {
  expect(outcome.outcome).toBe('draft');
  if (outcome.outcome !== 'draft') {
    throw new Error(`expected a draft outcome, got '${outcome.outcome}'`);
  }
  return outcome;
}

describe('ProposeDraftService (integration)', () => {
  let db: Kysely<Database>;
  let module: TestingModule;
  let service: ProposeDraftService;
  let expensesService: ExpensesService;
  let _policyService: PolicyService;

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
        StatusTransitionService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        VoucherProjectionService,
        ExpensesService,
        EntitiesService,
        AgentConfigService,
        ProposeDraftService,
      ],
    }).compile();

    service = module.get(ProposeDraftService);
    expensesService = module.get(ExpensesService);
    _policyService = module.get(PolicyService);
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
      const result = expectDraft(
        await service.proposeDraft(sampleTriageResult()),
      );

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
        // The supplier_proposal is now a discriminated union: a 'match' carries
        // the resolved entity id (the contract that previously admitted a bare
        // { match_entity_id } now requires the `mode` discriminant).
        supplier_proposal: { mode: 'match', match_entity_id: supplier.id },
      };

      const result = expectDraft(
        await service.proposeDraft(triageResult, 10, supplier.id),
      );

      const expense = await expensesService.getExpenseById(result.expenseId);
      expect(expense.document_id).toBe(10);
      expect(expense.supplier_id).toBe(supplier.id);
    });

    it('resolves a match supplier_proposal to its entity id (no explicit id)', async () => {
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Matched Supplier',
        registrationKey: 'IE54321',
      });

      // No explicit supplierId — resolution comes solely from the proposal.
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: { mode: 'match', match_entity_id: supplier.id },
      };

      const result = expectDraft(await service.proposeDraft(triageResult, 11));

      const expense = await expensesService.getExpenseById(result.expenseId);
      expect(expense.supplier_id).toBe(supplier.id);
    });

    it('routes a create supplier_proposal to needs_triage (no null-supplier draft, Task 43)', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Brand New Supplier Ltd',
          create_country: 'IE',
        },
      };

      const outcome = await service.proposeDraft(triageResult, 12);

      // No draft was created — the create proposal is reported unresolved.
      expect(outcome.outcome).toBe('supplier-unresolved');
      if (outcome.outcome === 'supplier-unresolved') {
        expect(outcome.reason).toBe(SUPPLIER_CREATE_NOT_IMPLEMENTED);
      }

      // Crucially: NO expense (and therefore no null-supplier draft) was
      // silently created for the document.
      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 12)
        .execute();
      expect(expenses).toHaveLength(0);
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

    it('holds for approval when confidence is below threshold (0.5)', async () => {
      const lowConfidenceResult: TriageResult = {
        ...sampleTriageResult(),
        confidence: 0.5,
      };

      const result = expectDraft(
        await service.proposeDraft(lowConfidenceResult),
      );

      expect(result.expenseId).toBeGreaterThan(0);
      expect(result.pipelineResult.policy.action).toBe('hold-for-approval');
      expect(result.pipelineResult.policy.reason).toContain(
        'AI confidence 0.5 below threshold 0.8',
      );
    });

    it('auto-posts when confidence is at or above threshold (0.94)', async () => {
      // Create a supplier so supplierKnown = true (otherwise unknown-supplier gate holds).
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Known Supplier',
        registrationKey: 'IE99999',
      });

      const result = expectDraft(
        await service.proposeDraft(sampleTriageResult(), null, supplier.id),
      );

      expect(result.expenseId).toBeGreaterThan(0);
      expect(result.pipelineResult.policy.action).toBe('auto-post');
    });

    it('writes an ai_proposal row after proposeDraft (auto-post path)', async () => {
      // Seed a per-agent model override — this is a discriminating value that
      // differs from the old hardcoded literal 'openai/gpt-4o-mini'.
      await db
        .insertInto('setting')
        .values({
          key: 'ai_model.triage',
          value: 'openai/gpt-4o',
          updated_at: 0,
        })
        .execute();

      // Create a supplier so the pipeline auto-posts.
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Provenance Supplier',
        registrationKey: 'IE88888',
      });

      const result = expectDraft(
        await service.proposeDraft(sampleTriageResult(), null, supplier.id),
      );

      const proposals = await db
        .selectFrom('ai_proposal')
        .selectAll()
        .where('business_object_id', '=', result.expenseId)
        .execute();

      expect(proposals).toHaveLength(1);
      expect(proposals[0].business_object_type).toBe('expense');
      // model_id must reflect the resolved setting, NOT the old hardcoded literal.
      expect(proposals[0].model_id).toBe('openai/gpt-4o');
      expect(proposals[0].model_version).toBe('v1');
      expect(proposals[0].confidence).toBe(0.94);
      expect(proposals[0].raw_triage_result).toBeDefined();
      // Verify the stored JSON can be parsed back.
      const parsed = JSON.parse(proposals[0].raw_triage_result!) as {
        kind: string;
        confidence: number;
      };
      expect(parsed.kind).toBe('new_expense');
      expect(parsed.confidence).toBe(0.94);
    });

    it('writes an ai_proposal row after proposeDraft (hold-for-approval path)', async () => {
      const lowConfidenceResult: TriageResult = {
        ...sampleTriageResult(),
        confidence: 0.3,
      };

      const result = expectDraft(
        await service.proposeDraft(lowConfidenceResult),
      );

      const proposals = await db
        .selectFrom('ai_proposal')
        .selectAll()
        .where('business_object_id', '=', result.expenseId)
        .execute();

      expect(proposals).toHaveLength(1);
      expect(proposals[0].confidence).toBe(0.3);
      expect(proposals[0].business_object_type).toBe('expense');
    });

    it('sets ocr_artifact_id to null when no ocr_markdown artifact exists', async () => {
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'OCR Test Supplier',
        registrationKey: 'IE77777',
      });

      const result = expectDraft(
        await service.proposeDraft(sampleTriageResult(), null, supplier.id),
      );

      const proposals = await db
        .selectFrom('ai_proposal')
        .select('ocr_artifact_id')
        .where('business_object_id', '=', result.expenseId)
        .executeTakeFirstOrThrow();

      expect(proposals.ocr_artifact_id).toBeNull();
    });
  });
});
