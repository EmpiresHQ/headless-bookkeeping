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
import { Pass2AgentService } from './pass2-agent.service';
import { TriageResult } from '../triage/types';
import { PeriodLockService } from '../reporting-periods/period-lock.service';

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

  /**
   * Build a triage Agent (the stub Agent, via moduleNameMapper) and pin
   * buildTriageAgent() to return it, so classify()'s on-demand build resolves to
   * this same instance — giving the spy a concrete generate() target.
   */
  const requireAgent = async (): Promise<Agent> => {
    const agent = await mastraService.buildTriageAgent();
    jest.spyOn(mastraService, 'buildTriageAgent').mockResolvedValue(agent);
    return agent;
  };

  /**
   * Build a FullOutput-shaped result for the real `generate()` contract — the
   * parsed structured object lives on `.object`.
   */
  const generateOutput = (object: unknown): GenerateResult =>
    ({ object, text: '' }) as unknown as GenerateResult;

  describe('classify', () => {
    it('returns a valid TriageResult for well-formed markdown', async () => {
      const agent = await requireAgent();
      const mockResult = sampleTriageResult();
      jest
        .spyOn(agent, 'generate')
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
      // The @mastra runtime / model credentials are unavailable: buildTriageAgent
      // rejects, and classify() maps that to the agent-unavailable category.
      jest
        .spyOn(mastraService, 'buildTriageAgent')
        .mockRejectedValue(new Error('Mastra runtime unavailable'));

      const result = await service.classify('some markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('agent-unavailable');
      }
    });

    it('retries on invalid output and reports invalid-output after max attempts', async () => {
      const agent = await requireAgent();
      // generate() resolves with an object that fails Zod validation
      // (missing required fields).
      const invalidOutput = {
        kind: 'new_expense',
        // Missing: document_type, gross_amount, vat_amount, currency,
        // tax_point_date, category, document_vat_marking, confidence
      };
      const generateSpy = jest
        .spyOn(agent, 'generate')
        .mockResolvedValue(generateOutput(invalidOutput));

      const markdown = 'broken invoice content';
      const result = await service.classify(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
      // Verify it was called MAX_RETRIES (3) times.
      expect(generateSpy).toHaveBeenCalledTimes(3);
    });

    it('retries on generate() error and succeeds on second attempt', async () => {
      const agent = await requireAgent();
      const mockResult = sampleTriageResult();

      const generateSpy = jest
        .spyOn(agent, 'generate')
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
      const agent = await requireAgent();
      const mockResult = sampleTriageResult();
      jest
        .spyOn(agent, 'generate')
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
      const agent = await requireAgent();
      const toolNames = Object.keys((await agent.listTools()) ?? {});

      expect(toolNames).toContain('searchSuppliers');
      expect(toolNames).toContain('listCategories');
      expect(toolNames).toContain('getClassificationMemory');
      expect(toolNames).toContain('previewCategoryMapping');
      // The composed deep read is the primary path (granular tools retained).
      expect(toolNames).toContain('getClassificationContext');
      expect(toolNames).toHaveLength(5);

      // Verify no write tools.
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];
      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('reports transient when generate() throws every time', async () => {
      const agent = await requireAgent();
      const generateSpy = jest
        .spyOn(agent, 'generate')
        .mockRejectedValue(new Error('persistent failure'));

      const result = await service.classify('any markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('transient');
      }
      expect(generateSpy).toHaveBeenCalledTimes(3);
    });

    it('defaults a dropped currency to EUR instead of failing the parse', async () => {
      // Some OpenAI-compatible endpoints do not enforce json_schema `required`,
      // so the model can omit a field. A dropped currency must NOT lose the whole
      // extraction to invalid-output — it defaults to the EUR base.
      const agent = await requireAgent();
      const noCurrency: Record<string, unknown> = { ...sampleTriageResult() };
      delete noCurrency.currency;
      jest
        .spyOn(agent, 'generate')
        .mockResolvedValue(generateOutput(noCurrency));

      const result = await service.classify('test');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.currency).toBe('EUR');
      }
    });

    it('validates currency is 3 characters', async () => {
      const agent = await requireAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        currency: 'EURO', // 4 chars, should fail z.string().length(3)
      };
      jest
        .spyOn(agent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates confidence is between 0 and 1', async () => {
      const agent = await requireAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        confidence: 1.5, // > 1, should fail z.number().min(0).max(1)
      };
      jest
        .spyOn(agent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates kind is a valid enum value', async () => {
      const agent = await requireAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        kind: 'invalid_kind',
      };
      jest
        .spyOn(agent, 'generate')
        .mockResolvedValue(generateOutput(invalidResult));

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });
  });
});
