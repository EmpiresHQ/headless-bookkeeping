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
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import {
  ProposeDraftService,
  ProposeDraftResult,
  ProposeDraftOutcome,
} from './propose-draft.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
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
  let salesInvoicesService: {
    createInvoice: jest.Mock;
    generateDraftVoucher: jest.Mock;
    getInvoiceById: jest.Mock;
    findByDocumentId: jest.Mock;
  };
  let postingPipelineService: PostingPipelineService;

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
        EntitiesService,
        AgentConfigService,
        CategoryService,
        {
          provide: SalesInvoicesService,
          useValue: {
            createInvoice: jest.fn(),
            generateDraftVoucher: jest.fn(),
            getInvoiceById: jest.fn(),
            findByDocumentId: jest.fn(),
          },
        },
        ProposeDraftService,
      ],
    }).compile();

    service = module.get(ProposeDraftService);
    expensesService = module.get(ExpensesService);
    _policyService = module.get(PolicyService);
    salesInvoicesService = module.get(SalesInvoicesService);
    postingPipelineService = module.get(PostingPipelineService);
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
    supplier_invoice_number: null,
    confidence: 0.94,
    outgoing_signals: {
      org_name_is_issuer: false,
      org_vat_is_issuer: false,
      has_buyer_block: false,
      self_identifies_as_invoice: false,
    },
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

    it('onboards a Supplier from a create proposal and produces a draft', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Brand New Supplier Ltd',
          create_country: 'IE',
          create_registration_key: 'IE9999999',
          create_email: null,
          create_phone: null,
          create_address: null,
        },
      };

      const outcome = await service.proposeDraft(triageResult, 12);
      expect(outcome.outcome).toBe('draft');

      // The Supplier was created and is matchable by its registration key.
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.findByRegistrationKey('IE9999999');
      expect(supplier).toBeDefined();
      expect(supplier!.name).toBe('Brand New Supplier Ltd');
      expect(supplier!.role).toBe('supplier');

      // The draft expense is linked to the freshly-created Supplier.
      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 12)
        .execute();
      expect(expenses).toHaveLength(1);
      expect(expenses[0].supplier_id).toBe(supplier!.id);
    });

    it('reuses an existing Supplier when the create reg key already exists', async () => {
      const entitiesService = module.get(EntitiesService);
      const existing = await entitiesService.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Existing Co',
        registrationKey: 'IE1234567',
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Existing Co (variant spelling)',
          create_country: 'IE',
          create_registration_key: 'IE1234567',
          create_email: null,
          create_phone: null,
          create_address: null,
        },
      };

      const outcome = await service.proposeDraft(triageResult, 13);
      expect(outcome.outcome).toBe('draft');

      // No duplicate Supplier — the draft links to the existing one.
      const identifiers = await db
        .selectFrom('entity_identifier')
        .selectAll()
        .where('value', '=', 'IE1234567')
        .execute();
      expect(identifiers).toHaveLength(1);
      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 13)
        .execute();
      expect(expenses[0].supplier_id).toBe(existing.id);
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

    it('passes supplier_invoice_number from triage into the created expense', async () => {
      const createExpenseSpy = jest.spyOn(expensesService, 'createExpense');
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_invoice_number: 'SUP-55',
      };
      await service.proposeDraft(triageResult, undefined);
      expect(createExpenseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ supplier_invoice_number: 'SUP-55' }),
      );
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

    it('reuses an existing Supplier when only the EMAIL matches (Anomaly regression)', async () => {
      const entitiesService = module.get(EntitiesService);
      const existing = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Anomaly',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'help@anoma.ly',
          create_phone: null,
          create_address: null,
        },
      };

      expectDraft(await service.proposeDraft(triageResult, 20));

      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 20)
        .execute();
      expect(expenses[0].supplier_id).toBe(existing.id);

      const suppliers = await db
        .selectFrom('entity')
        .select('id')
        .where('role', '=', 'supplier')
        .where('name', '=', 'Anomaly')
        .execute();
      expect(suppliers).toHaveLength(1);
    });

    it('onboards a new Supplier with all identifiers when nothing matches', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Fresh US Co',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'billing@fresh.io',
          create_phone: '+1 555 7777',
          create_address: '1 Market St',
        },
      };

      expectDraft(await service.proposeDraft(triageResult, 21));

      const entitiesService = module.get(EntitiesService);
      const [match] = await entitiesService.resolveByIdentifiers([
        { kind: 'phone', value: '+15557777' },
      ]);
      expect(match).toBeDefined();
      const created = await entitiesService.findById(match);
      const kinds = created.identifiers.map((i) => i.kind).sort();
      expect(kinds).toEqual(['address', 'email', 'phone']);
    });

    it('backfills a missing identifier onto a matched Supplier', async () => {
      const entitiesService = module.get(EntitiesService);
      const existing = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        identifiers: [{ kind: 'email', value: 'help@anoma.ly' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Anomaly',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'help@anoma.ly',
          create_phone: '+1 555 0000',
          create_address: null,
        },
      };

      expectDraft(await service.proposeDraft(triageResult, 22));

      const phones = (
        await entitiesService.findById(existing.id)
      ).identifiers.filter((i) => i.kind === 'phone');
      expect(phones).toHaveLength(1);
      expect(phones[0].value).toBe('+15550000');
    });

    it('routes to supplier-unresolved when the create proposal has no match keys', async () => {
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'No Identifiers Inc',
          create_country: 'US',
          create_registration_key: null,
          create_email: null,
          create_phone: null,
          create_address: '1 Anonymous Way', // address is NOT a match key
        },
      };

      const outcome = await service.proposeDraft(triageResult, 23);
      expect(outcome.outcome).toBe('supplier-unresolved');
    });

    it('routes to supplier-unresolved when identifiers match TWO different Suppliers', async () => {
      const entitiesService = module.get(EntitiesService);
      await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier A',
        identifiers: [{ kind: 'email', value: 'a@x.io' }],
      });
      await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'US',
        name: 'Supplier B',
        identifiers: [{ kind: 'phone', value: '+15551111' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'create',
          create_name: 'Ambiguous',
          create_country: 'US',
          create_registration_key: null,
          create_email: 'a@x.io', // → Supplier A
          create_phone: '+1 555 1111', // → Supplier B
          create_address: null,
        },
      };

      const outcome = await service.proposeDraft(triageResult, 24);
      expect(outcome.outcome).toBe('supplier-unresolved');
    });

    it('routes to supplier-unresolved when a match proposal points to a non-existent entity', async () => {
      // The agent hallucinated an entity id (field case: match_entity_id 500001).
      // Resolving it blindly fed a phantom supplier_id to createExpense → FK
      // violation → the document was stranded in pending. It must instead route
      // to operator triage, recoverably.
      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: { mode: 'match', match_entity_id: 999999 },
      };

      const outcome = await service.proposeDraft(triageResult, 30);
      expect(outcome.outcome).toBe('supplier-unresolved');

      // No phantom expense was written.
      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 30)
        .execute();
      expect(expenses).toHaveLength(0);
    });

    it('routes to supplier-unresolved when a match proposal points to a non-supplier entity', async () => {
      // The matched entity exists but is a customer, not a supplier. Booking an
      // expense against it is wrong; route to triage instead of posting.
      const entitiesService = module.get(EntitiesService);
      const customer = await entitiesService.onboardWithIdentifiers({
        role: 'customer',
        country: 'EE',
        name: 'A Customer OÜ',
        identifiers: [{ kind: 'registration_key', value: 'EE10000001' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: { mode: 'match', match_entity_id: customer.id },
      };

      const outcome = await service.proposeDraft(triageResult, 31);
      expect(outcome.outcome).toBe('supplier-unresolved');

      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 31)
        .execute();
      expect(expenses).toHaveLength(0);
    });

    it('routes a match to supplier-unresolved when the observed country contradicts the entity', async () => {
      // The matched entity is a US software vendor; the document the agent read
      // is Estonian. Booking against it would be the Paavli→Anomaly mis-resolve.
      const entitiesService = module.get(EntitiesService);
      const usVendor = await entitiesService.onboard({
        role: 'supplier',
        country: 'US',
        name: 'Anomaly',
        registrationKey: 'US-ANOMALY',
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'match',
          match_entity_id: usVendor.id,
          observed_country: 'EE',
          observed_registration_key: null,
        },
      };

      const outcome = await service.proposeDraft(triageResult, 32);
      expect(outcome.outcome).toBe('supplier-unresolved');

      const expenses = await db
        .selectFrom('expense')
        .selectAll()
        .where('document_id', '=', 32)
        .execute();
      expect(expenses).toHaveLength(0);
    });

    it('keeps a match when the observed country agrees with the entity', async () => {
      const entitiesService = module.get(EntitiesService);
      const eeSupplier = await entitiesService.onboard({
        role: 'supplier',
        country: 'EE',
        name: 'Paavli Kinnisvara OÜ',
        registrationKey: 'EE11000000',
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'match',
          match_entity_id: eeSupplier.id,
          observed_country: 'EE',
          observed_registration_key: null,
        },
      };

      const result = expectDraft(await service.proposeDraft(triageResult, 33));
      const expense = await expensesService.getExpenseById(result.expenseId);
      expect(expense.supplier_id).toBe(eeSupplier.id);
    });

    it('routes a match to supplier-unresolved when the observed registration key contradicts the entity', async () => {
      const entitiesService = module.get(EntitiesService);
      const supplier = await entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: 'EE',
        name: 'Example Seller OÜ',
        identifiers: [{ kind: 'registration_key', value: 'EE100200300' }],
      });

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        supplier_proposal: {
          mode: 'match',
          match_entity_id: supplier.id,
          observed_country: 'EE',
          observed_registration_key: 'EE999999999', // entity carries a DIFFERENT reg key
        },
      };

      const outcome = await service.proposeDraft(triageResult, 34);
      expect(outcome.outcome).toBe('supplier-unresolved');
    });

    it('returns category-unresolved for a triage category the active plugin does not know', async () => {
      const categoryService = module.get(CategoryService);
      // Stub isValid to return false for anything that is not 'software'.
      jest.spyOn(categoryService, 'isValid').mockResolvedValue(false);

      const triage: TriageResult = {
        kind: 'new_expense',
        category: 'made-up-category',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-01-01',
        document_type: 'receipt',
        document_vat_marking: null,
        supplier_invoice_number: null,
        confidence: 0.9,
        outgoing_signals: {
          org_name_is_issuer: false,
          org_vat_is_issuer: false,
          has_buyer_block: false,
          self_identifies_as_invoice: false,
        },
      };

      const outcome = await service.proposeDraft(triage, null, 1);
      expect(outcome.outcome).toBe('category-unresolved');
    });

    it('persists ai_confidence, ai_document_type, ai_kind from the classification onto the Expense row', async () => {
      // Seed a document row so document_id FK is satisfied.
      const docId = await db
        .insertInto('document')
        .values({
          hash: 'ai-fields-test-hash',
          filename: 'ai-fields-test.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1,
          status: 'pending',
          claimant_id: null,
          created_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id);

      const triageResult: TriageResult = {
        ...sampleTriageResult(),
        confidence: 0.87,
        document_type: 'invoice',
        kind: 'new_expense',
      };

      const result = expectDraft(
        await service.proposeDraft(triageResult, docId),
      );

      const row = await db
        .selectFrom('expense')
        .select(['ai_confidence', 'ai_document_type', 'ai_kind'])
        .where('id', '=', result.expenseId)
        .executeTakeFirstOrThrow();

      expect(row.ai_confidence).toBe(0.87);
      expect(row.ai_document_type).toBe('invoice');
      expect(row.ai_kind).toBe('new_expense');
    });

    it('propagates claimant_id to the created Expense when provided', async () => {
      const entitiesService = module.get(EntitiesService);

      // Seed a claimant entity — expense.claimant_id is an FK → entity(id).
      const claimant = await entitiesService.onboard({
        role: 'employee',
        country: 'EE',
        name: 'Test Employee',
        email: 'employee@example.com',
      });

      // Seed a document row so document_id FK is satisfied.
      const docId = await db
        .insertInto('document')
        .values({
          hash: 'claimant-test-hash',
          filename: 'claimant-test.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1,
          status: 'pending',
          claimant_id: null,
          created_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id);

      const triageResult: TriageResult = {
        kind: 'new_expense' as const,
        category: 'meals',
        gross_amount: 2400,
        vat_amount: 400,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        document_type: 'receipt',
        document_vat_marking: null,
        supplier_invoice_number: null,
        confidence: 0.95,
        outgoing_signals: {
          org_name_is_issuer: false,
          org_vat_is_issuer: false,
          has_buyer_block: false,
          self_identifies_as_invoice: false,
        },
        company_addressed_receipt: true,
      };

      const result = expectDraft(
        await service.proposeDraft(triageResult, docId, undefined, claimant.id),
      );

      const expense = await db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', result.expenseId)
        .executeTakeFirstOrThrow();

      expect(expense.claimant_id).toBe(claimant.id);
      // SQLite stores booleans as integers (1 = true).
      expect(expense.company_addressed_receipt).toBe(1);
    });
  });

  describe('proposeSalesInvoiceDraft', () => {
    const salesTriageResult = (): TriageResult => ({
      kind: 'new_sales_invoice',
      document_type: 'invoice',
      gross_amount: 12200,
      vat_amount: 2200,
      currency: 'EUR',
      tax_point_date: '2026-04-01',
      category: 'revenue',
      document_vat_marking: null,
      supplier_invoice_number: null,
      confidence: 0.9,
      outgoing_signals: {
        org_name_is_issuer: true,
        org_vat_is_issuer: true,
        has_buyer_block: true,
        self_identifies_as_invoice: true,
      },
    });

    it('creates a sales invoice draft and runs the posting pipeline (match customer)', async () => {
      salesInvoicesService.createInvoice.mockResolvedValue({
        id: 55,
        customer_id: 7,
      });
      const runPipelineSpy = jest
        .spyOn(postingPipelineService, 'runPipeline')
        .mockResolvedValue({ ok: true } as never);

      const out = await service.proposeSalesInvoiceDraft(
        {
          ...salesTriageResult(),
          supplier_invoice_number: 'INV-9',
          customer_proposal: { mode: 'match', match_entity_id: 7 },
        },
        42,
      );

      expect(out.outcome).toBe('draft');
      expect((out as { invoiceId: number }).invoiceId).toBe(55);
      expect(salesInvoicesService.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          document_id: 42,
          customer_id: 7,
          invoice_number: 'INV-9',
        }),
      );
      expect(runPipelineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          businessObjectType: 'sales_invoice',
          category: 'revenue',
        }),
      );
    });

    it('parks (customer-unresolved) for a create proposal — no draft created', async () => {
      const out = await service.proposeSalesInvoiceDraft(
        {
          ...salesTriageResult(),
          supplier_invoice_number: 'INV-9',
          customer_proposal: {
            mode: 'create',
            create_name: 'X',
            create_country: 'EE',
            create_registration_key: null,
            create_email: null,
            create_phone: null,
            create_address: null,
          },
        },
        42,
      );

      expect(out.outcome).toBe('customer-unresolved');
      expect(salesInvoicesService.createInvoice).not.toHaveBeenCalled();
    });

    it('returns invoice-number-missing when supplier_invoice_number is null', async () => {
      const out = await service.proposeSalesInvoiceDraft(
        {
          ...salesTriageResult(),
          supplier_invoice_number: null,
          customer_proposal: { mode: 'match', match_entity_id: 7 },
        },
        42,
      );

      expect(out.outcome).toBe('invoice-number-missing');
    });

    it('returns duplicate-number when invoice_number collides', async () => {
      salesInvoicesService.createInvoice.mockRejectedValue(
        new Error('UNIQUE constraint failed: sales_invoice.invoice_number'),
      );

      const out = await service.proposeSalesInvoiceDraft(
        {
          ...salesTriageResult(),
          supplier_invoice_number: 'INV-9',
          customer_proposal: { mode: 'match', match_entity_id: 7 },
        },
        42,
      );

      expect(out.outcome).toBe('duplicate-number');
    });
  });

  describe('manualClassifyInvoiceDraft', () => {
    it('creates a sales invoice from operator data and runs the pipeline', async () => {
      salesInvoicesService.createInvoice.mockResolvedValue({ id: 88 });
      const runPipelineSpy = jest
        .spyOn(postingPipelineService, 'runPipeline')
        .mockResolvedValue({ ok: true } as never);

      const out = await service.manualClassifyInvoiceDraft(99, {
        customer_id: 7,
        invoice_number: 'INV-77',
        gross_amount: 12200,
        vat_amount: 2200,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        document_vat_marking: null,
      });

      expect(out.outcome).toBe('draft');
      expect((out as { invoiceId: number }).invoiceId).toBe(88);
      expect(salesInvoicesService.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          document_id: 99,
          customer_id: 7,
          invoice_number: 'INV-77',
          gross_amount: 12200,
          vat_amount: 2200,
          currency: 'EUR',
          tax_point_date: '2026-06-01',
          document_vat_marking: null,
        }),
      );
      expect(runPipelineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          businessObjectType: 'sales_invoice',
          category: 'revenue',
          requestedBy: 'operator',
        }),
      );
    });

    it('defaults a missing customer_id / document_vat_marking to null', async () => {
      salesInvoicesService.createInvoice.mockResolvedValue({ id: 90 });
      jest
        .spyOn(postingPipelineService, 'runPipeline')
        .mockResolvedValue({ ok: true } as never);

      await service.manualClassifyInvoiceDraft(101, {
        invoice_number: 'INV-90',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
      });

      expect(salesInvoicesService.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          customer_id: null,
          document_vat_marking: null,
        }),
      );
    });

    it('returns duplicate-number when the invoice number collides', async () => {
      salesInvoicesService.createInvoice.mockRejectedValue(
        new Error('UNIQUE constraint failed: sales_invoice.invoice_number'),
      );

      const out = await service.manualClassifyInvoiceDraft(99, {
        customer_id: null,
        invoice_number: 'INV-DUP',
        gross_amount: 12200,
        vat_amount: 2200,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        document_vat_marking: null,
      });

      expect(out.outcome).toBe('duplicate-number');
    });
  });
});
