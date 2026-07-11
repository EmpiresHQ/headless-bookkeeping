import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import type { Agent } from '@mastra/core/agent';
import { AgentConfigService } from './agent-config.service';
import { MastraService } from './mastra.service';
import { Pass2AgentService, Pass2Context } from './pass2-agent.service';
import { triageResultSchema, TriageResult } from '../triage/types';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { CategoryService } from '../categories/category.service';
import { withOrgIdentity } from './triage-instructions';

type GenerateResult = Awaited<ReturnType<Agent['generate']>>;

describe('Pass2AgentService', () => {
  let db: Kysely<Database>;
  let service: Pass2AgentService;
  let mastraService: MastraService;

  const sampleTriageResult = (): TriageResult => ({
    kind: 'new_expense',
    document_type: 'receipt',
    gross_amount: 1525,
    vat_amount: 285,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    category: 'transport',
    document_vat_marking: '23%',
    supplier_invoice_number: null,
    confidence: 0.94,
    outgoing_signals: {
      org_name_is_issuer: false,
      org_vat_is_issuer: false,
      has_buyer_block: false,
      self_identifies_as_invoice: false,
    },
  });

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
        VoucherProjectionService,
        EntitiesService,
        ExpensesService,
        {
          provide: PeriodLockService,
          useValue: {
            assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
            findLockedPeriod: jest.fn().mockResolvedValue(undefined),
            getCurrentOpenPeriod: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CategoryService,
          useValue: {
            list: () => Promise.resolve([]),
            isValid: () => Promise.resolve(true),
            assertValid: () => Promise.resolve(),
          },
        },
        AgentConfigService,
        MastraService,
        Pass2AgentService,
      ],
    }).compile();

    service = module.get(Pass2AgentService);
    mastraService = module.get(MastraService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const requireEnrichmentAgent = async (): Promise<Agent> => {
    const agent = await mastraService.buildTriageEnrichmentAgent();
    jest
      .spyOn(mastraService, 'buildTriageEnrichmentAgent')
      .mockResolvedValue(agent);
    return agent;
  };

  const requireSplitAgents = async (): Promise<{
    enrichmentAgent: Agent;
    classificationAgent: Agent;
  }> => ({
    enrichmentAgent: await requireEnrichmentAgent(),
    classificationAgent: await requireClassificationAgent(),
  });

  const mockEnrichmentSummary = (
    agent: Agent,
    summary = 'deterministic enrichment summary',
  ) =>
    jest
      .spyOn(agent, 'generate')
      .mockImplementation(async () => generateTextOutput(summary));

  const requireClassificationAgent = async (): Promise<Agent> => {
    const agent = await mastraService.buildTriageClassificationAgent();
    jest
      .spyOn(mastraService, 'buildTriageClassificationAgent')
      .mockResolvedValue(agent);
    return agent;
  };

  /**
   * Build a FullOutput-shaped result for the real `generate()` contract — the
   * parsed structured object lives on `.object`.
   */
  const generateOutput = (object: unknown): GenerateResult =>
    ({ object, text: '' }) as unknown as GenerateResult;

  const generateTextOutput = (text: string): GenerateResult =>
    ({ object: undefined, text }) as unknown as GenerateResult;

  describe('classify', () => {
    it('characterizes the caller-facing success contract for classify()', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const mockResult = sampleTriageResult();
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(mockResult));

      const result = await service.classify('baseline markdown');

      expect(result).toMatchObject({ ok: true, result: mockResult });
    });

    it('returns a valid TriageResult for well-formed markdown', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const mockResult = sampleTriageResult();
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(mockResult));

      const markdown = `
        # Invoice
        Supplier: Acme Corp
        Amount: €15.25
        VAT: €2.85
        Date: 2026-03-15
        Category: Transport
      `;

      const result = await service.classify(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual(mockResult);
        expect(result.result.kind).toBe('new_expense');
        expect(result.result.confidence).toBe(0.94);
      }
    });

    it('returns agent-unavailable when the agent cannot be built', async () => {
      // The @mastra runtime / model credentials are unavailable: the enrichment
      // builder rejects before any classification attempt can start.
      jest
        .spyOn(mastraService, 'buildTriageEnrichmentAgent')
        .mockRejectedValue(new Error('Mastra runtime unavailable'));

      const result = await service.classify('some markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('agent-unavailable');
      }
    });

    it('reports enrichment-failed when the enrichment phase throws and never enters strict classification', async () => {
      const enrichmentAgent = await requireEnrichmentAgent();
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      jest
        .spyOn(enrichmentAgent, 'generate')
        .mockRejectedValue(new Error('tool provider offline'));

      const result = await service.classify('invoice markdown');

      expect(result).toEqual({
        ok: false,
        category: 'enrichment-failed',
        detail: 'enrichment phase failed: tool provider offline',
      });
      expect(buildClassificationSpy).not.toHaveBeenCalled();
    });

    it('reports enrichment-incomplete when enrichment returns no reusable summary', async () => {
      const enrichmentAgent = await requireEnrichmentAgent();
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      jest
        .spyOn(enrichmentAgent, 'generate')
        .mockResolvedValue(generateTextOutput('   '));

      const result = await service.classify('malformed invoice markdown');

      expect(result).toEqual({
        ok: false,
        category: 'enrichment-incomplete',
        detail: 'enrichment phase returned no reusable summary',
      });
      expect(buildClassificationSpy).not.toHaveBeenCalled();
    });

    it('retries on strict invalid output and reports invalid-output after max attempts', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      // generate() resolves with an object that fails Zod validation
      // (missing required fields).
      const invalidOutput = {
        kind: 'new_expense',
        // Missing: document_type, gross_amount, vat_amount, currency,
        // tax_point_date, category, document_vat_marking, confidence
      };
      mockEnrichmentSummary(enrichmentAgent);
      const enrichmentGenerateSpy = jest.spyOn(enrichmentAgent, 'generate');
      const generateSpy = jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(invalidOutput));

      const markdown = 'broken invoice content';
      const result = await service.classify(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
        expect(result.detail).toContain('strict classification');
        expect(result.detail).not.toContain('enrichment phase');
      }
      expect(enrichmentGenerateSpy).toHaveBeenCalledTimes(1);
      // Verify it was called MAX_RETRIES (3) times.
      expect(generateSpy).toHaveBeenCalledTimes(3);
    });

    it('runs one enrichment call before strict retries and preserves enrichment on success', async () => {
      const enrichmentAgent = await requireEnrichmentAgent();
      const classificationAgent = await requireClassificationAgent();
      const legacyBuildSpy = jest.spyOn(mastraService, 'buildTriageAgent');
      const buildEnrichmentSpy = jest.spyOn(
        mastraService,
        'buildTriageEnrichmentAgent',
      );
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      const mockResult = sampleTriageResult();
      const enrichmentSummary =
        'supplier evidence: EE102139798; category: transport; mapping preview: expense.transport';

      const enrichmentGenerateSpy = jest
        .spyOn(enrichmentAgent, 'generate')
        .mockImplementation(async () => generateTextOutput(enrichmentSummary));
      const classificationGenerateSpy = jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValueOnce(generateOutput({ kind: 'new_expense' }))
        .mockRejectedValueOnce(new Error('schema retry'))
        .mockResolvedValueOnce(generateOutput(mockResult));

      const result = await service.classify('incoming receipt markdown');

      expect(result).toMatchObject({
        ok: true,
        result: mockResult,
        enrichment: { summary: enrichmentSummary },
      });
      expect(legacyBuildSpy).not.toHaveBeenCalled();
      expect(buildEnrichmentSpy).toHaveBeenCalledTimes(1);
      expect(buildEnrichmentSpy).toHaveBeenCalledWith(undefined);
      expect(buildClassificationSpy).toHaveBeenCalledTimes(1);
      expect(buildClassificationSpy).toHaveBeenCalledWith(undefined);
      expect(enrichmentGenerateSpy).toHaveBeenCalledTimes(1);
      expect(enrichmentGenerateSpy).toHaveBeenCalledWith(
        'incoming receipt markdown',
      );
      expect(classificationGenerateSpy).toHaveBeenCalledTimes(3);
      expect(classificationGenerateSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(enrichmentSummary),
        { structuredOutput: { schema: triageResultSchema } },
      );
      expect(classificationGenerateSpy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(enrichmentSummary),
        { structuredOutput: { schema: triageResultSchema } },
      );
      expect(classificationGenerateSpy).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining(enrichmentSummary),
        { structuredOutput: { schema: triageResultSchema } },
      );
    });

    it('passes org identity context to both split builders', async () => {
      const enrichmentAgent = await requireEnrichmentAgent();
      const classificationAgent = await requireClassificationAgent();
      const legacyBuildSpy = jest.spyOn(mastraService, 'buildTriageAgent');
      const buildEnrichmentSpy = jest.spyOn(
        mastraService,
        'buildTriageEnrichmentAgent',
      );
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      jest
        .spyOn(enrichmentAgent, 'generate')
        .mockImplementation(async () => generateTextOutput('enrichment notes'));
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(sampleTriageResult()));

      const ctx: Pass2Context = {
        orgContext: {
          iban: 'EE382200221020145685',
          name: 'Acme OÜ',
          vatNumber: 'EE123456789',
        },
        directionHint: 'outgoing',
      };

      await service.classify('# Sales Invoice\nBuyer: Some Corp', ctx);

      expect(legacyBuildSpy).not.toHaveBeenCalled();
      expect(buildEnrichmentSpy).toHaveBeenCalledWith({
        iban: 'EE382200221020145685',
        name: 'Acme OÜ',
        vatNumber: 'EE123456789',
        directionHint: 'outgoing',
      });
      expect(buildClassificationSpy).toHaveBeenCalledWith({
        iban: 'EE382200221020145685',
        name: 'Acme OÜ',
        vatNumber: 'EE123456789',
        directionHint: 'outgoing',
      });
    });

    it('retries on generate() error and succeeds on second attempt', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const mockResult = sampleTriageResult();
      mockEnrichmentSummary(enrichmentAgent);

      const generateSpy = jest
        .spyOn(classificationAgent, 'generate')
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockRejectedValueOnce(new Error('LLM rate limit'))
        .mockResolvedValue(generateOutput(mockResult));

      const markdown = 'valid invoice';
      const result = await service.classify(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual(mockResult);
      }
      expect(generateSpy).toHaveBeenCalledTimes(3);
    });

    it('output never contains vat_code or account (grep clean)', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const mockResult = sampleTriageResult();
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(mockResult));

      const result = await service.classify('test markdown');

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      // TriageResult schema has no vat_code or account fields.
      expect(result.result).not.toHaveProperty('vat_code');
      expect(result.result).not.toHaveProperty('account');
      // The result keys should match the TriageResult schema.
      const keys = Object.keys(result.result);
      expect(keys).not.toContain('vat_code');
      expect(keys).not.toContain('account');
    });

    it('agent uses the correct read-only tool set', async () => {
      const enrichmentAgent = await requireEnrichmentAgent();
      const classificationAgent = await requireClassificationAgent();
      const toolNames = Object.keys((await enrichmentAgent.listTools()) ?? {});
      const classificationToolNames = Object.keys(
        (await classificationAgent.listTools()) ?? {},
      );

      expect(toolNames).toContain('listCategories');
      expect(toolNames).toContain('getClassificationMemory');
      expect(toolNames).toContain('previewCategoryMapping');
      // The composed deep read is the primary path (granular tools retained).
      expect(toolNames).toContain('getClassificationContext');
      expect(toolNames).toHaveLength(4);
      expect(toolNames).not.toContain('searchSuppliers');
      expect(classificationToolNames).toHaveLength(0);

      // Verify no write tools.
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];
      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('reports transient when generate() throws every time', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      mockEnrichmentSummary(enrichmentAgent);
      const enrichmentGenerateSpy = jest.spyOn(enrichmentAgent, 'generate');
      const generateSpy = jest
        .spyOn(classificationAgent, 'generate')
        .mockRejectedValue(new Error('persistent failure'));

      const result = await service.classify('any markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('transient');
        expect(result.detail).toBe(
          'strict classification failed after 3 attempts: persistent failure',
        );
      }
      expect(enrichmentGenerateSpy).toHaveBeenCalledTimes(1);
      expect(generateSpy).toHaveBeenCalledTimes(3);
    });

    it('defaults a dropped currency to EUR instead of failing the parse', async () => {
      // Some OpenAI-compatible endpoints do not enforce json_schema `required`,
      // so the model can omit a field. A dropped currency must NOT lose the whole
      // extraction to invalid-output — it defaults to the EUR base.
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const noCurrency: Record<string, unknown> = { ...sampleTriageResult() };
      delete noCurrency.currency;
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(noCurrency));

      const result = await service.classify('test');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.currency).toBe('EUR');
      }
    });

    it('validates currency is 3 characters', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const invalidResult = {
        ...sampleTriageResult(),
        currency: 'EURO', // 4 chars, should fail z.string().length(3)
      };
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates confidence is between 0 and 1', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const invalidResult = {
        ...sampleTriageResult(),
        confidence: 1.5, // > 1, should fail z.number().min(0).max(1)
      };
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates kind is a valid enum value', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const invalidResult = {
        ...sampleTriageResult(),
        kind: 'invalid_kind',
      };
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('calls split builders with no args when ctx is absent (backward compatible)', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const buildEnrichmentSpy = jest.spyOn(
        mastraService,
        'buildTriageEnrichmentAgent',
      );
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(sampleTriageResult()));

      await service.classify('# Receipt\nAmount: €10');

      expect(buildEnrichmentSpy).toHaveBeenCalledWith(undefined);
      expect(buildClassificationSpy).toHaveBeenCalledWith(undefined);
    });

    it('passes incoming direction hint correctly to split builders', async () => {
      const { enrichmentAgent, classificationAgent } =
        await requireSplitAgents();
      const buildEnrichmentSpy = jest.spyOn(
        mastraService,
        'buildTriageEnrichmentAgent',
      );
      const buildClassificationSpy = jest.spyOn(
        mastraService,
        'buildTriageClassificationAgent',
      );
      mockEnrichmentSummary(enrichmentAgent);
      jest
        .spyOn(classificationAgent, 'generate')
        .mockResolvedValue(generateOutput(sampleTriageResult()));

      const ctx: Pass2Context = {
        orgContext: {
          iban: null,
          name: 'My Company OÜ',
          vatNumber: null,
        },
        directionHint: 'incoming',
      };

      await service.classify('# Supplier Invoice', ctx);

      expect(buildEnrichmentSpy).toHaveBeenCalledWith({
        iban: null,
        name: 'My Company OÜ',
        vatNumber: null,
        directionHint: 'incoming',
      });
      expect(buildClassificationSpy).toHaveBeenCalledWith({
        iban: null,
        name: 'My Company OÜ',
        vatNumber: null,
        directionHint: 'incoming',
      });
    });
  });

  describe('withOrgIdentity (pure helper)', () => {
    it('appends org identity block to instructions', () => {
      const base = 'BASE INSTRUCTIONS';
      const result = withOrgIdentity(base, {
        name: 'Acme OÜ',
        vatNumber: 'EE123456789',
        iban: 'EE382200221020145685',
        directionHint: 'outgoing',
      });

      expect(result).toContain('BASE INSTRUCTIONS');
      expect(result).toContain('YOUR ORGANIZATION');
      expect(result).toContain('name="Acme OÜ"');
      expect(result).toContain('VAT="EE123456789"');
      expect(result).toContain('IBAN="EE382200221020145685"');
      expect(result).toContain('direction="outgoing"');
      expect(result).toContain('new_sales_invoice');
      expect(result).toContain('customer_proposal');
      expect(result).toContain('outgoing_signals');
    });

    it('substitutes "unknown" for null fields', () => {
      const result = withOrgIdentity('BASE', {
        name: null,
        vatNumber: null,
        iban: null,
        directionHint: 'incoming',
      });

      expect(result).toContain('name="unknown"');
      expect(result).toContain('VAT="unknown"');
      expect(result).toContain('IBAN="unknown"');
      expect(result).toContain('direction="incoming"');
      expect(result).toContain('new_expense');
    });

    it('references incoming supplier_proposal path when direction is incoming', () => {
      const result = withOrgIdentity('BASE', {
        name: 'Co',
        vatNumber: 'EE1',
        iban: 'EE123',
        directionHint: 'incoming',
      });

      expect(result).toContain('supplier_proposal');
      expect(result).toContain('new_expense');
    });
  });
});
