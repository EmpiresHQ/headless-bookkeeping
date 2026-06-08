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
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import type { Agent } from '@mastra/core/agent';
import { MastraService } from './mastra.service';
import { Pass2AgentService } from './pass2-agent.service';
import { TriageResult } from '../triage/types';

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
        PluginLoader,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        ExpensesService,
        MastraService,
        Pass2AgentService,
      ],
    }).compile();

    service = module.get(Pass2AgentService);
    mastraService = module.get(MastraService);

    // initialize() statically imports @mastra/*; under Jest those specifiers
    // map to test/mastra-stub.ts (moduleNameMapper), whose Agent exposes a
    // jest-spyable generate() returning a FullOutput-shaped object.
    await mastraService.initialize();
  });

  afterEach(async () => {
    await db.destroy();
  });

  /**
   * Resolve the initialized triage Agent, asserting it is non-null so the spy
   * has a concrete target (the stub Agent, via moduleNameMapper).
   */
  const requireAgent = (): NonNullable<
    ReturnType<MastraService['getAgent']>
  > => {
    const agent = mastraService.getAgent();
    if (!agent) throw new Error('agent not initialized');
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
      const agent = requireAgent();
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

    it('returns agent-unavailable when agent is not initialized', async () => {
      // A MastraService whose initialize() was never called leaves getAgent()
      // null — no DI graph needed to exercise the unavailable path.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          OrganizationService,
          NullCountryPlugin,
          PluginLoader,
          CurrencyService,
          VoucherProjectionService,
          EntitiesService,
          ExpensesService,
          MastraService,
          Pass2AgentService,
        ],
      }).compile();

      const uninitializedMastra = module.get(MastraService);
      const freshService = new Pass2AgentService(uninitializedMastra);

      const result = await freshService.classify('some markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('agent-unavailable');
      }
    });

    it('retries on invalid output and reports invalid-output after max attempts', async () => {
      const agent = requireAgent();
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
      const agent = requireAgent();
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
      const agent = requireAgent();
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
      const agent = requireAgent();
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
      const agent = requireAgent();
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

    it('validates currency is 3 characters', async () => {
      const agent = requireAgent();
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
      const agent = requireAgent();
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
      const agent = requireAgent();
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
