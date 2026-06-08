/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
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
import { MastraService } from './mastra.service';
import { Pass2AgentService } from './pass2-agent.service';
import { TriageResult } from '../triage/types';

describe('Pass2AgentService', () => {
  let db: Kysely<Database>;
  let service: Pass2AgentService;
  let mastraService: MastraService;

  // Mock classes for Mastra initialization.
  const MockMastra = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      agents: config.agents,
      storage: config.storage,
    }));

  const MockAgent = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      id: config.id,
      name: config.name,
      instructions: config.instructions,
      tools: config.tools,
      structuredOutput: jest.fn(),
    }));

  const MockLibSQLStore = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      id: config.id,
      url: config.url,
    }));

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

    await mastraService.initialize({
      MastraClass: MockMastra,
      AgentClass: MockAgent,
      LibSQLStoreClass: MockLibSQLStore,
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('classify', () => {
    it('returns a valid TriageResult for well-formed markdown', async () => {
      const agent = mastraService.getAgent();
      const mockResult = sampleTriageResult();
      jest.spyOn(agent, 'structuredOutput').mockResolvedValue(mockResult);

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
      // Create a fresh service with uninitialized MastraService.
      const uninitializedMastra = new MastraService(
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );
      const freshService = new Pass2AgentService(uninitializedMastra);

      const result = await freshService.classify('some markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('agent-unavailable');
      }
    });

    it('retries on invalid output and reports invalid-output after max attempts', async () => {
      const agent = mastraService.getAgent();
      // structuredOutput returns data that fails Zod validation
      // (missing required fields).
      const invalidOutput = {
        kind: 'new_expense',
        // Missing: document_type, gross_amount, vat_amount, currency,
        // tax_point_date, category, document_vat_marking, confidence
      };
      jest
        .spyOn(agent, 'structuredOutput')
        .mockResolvedValue(invalidOutput as any);

      const markdown = 'broken invoice content';
      const result = await service.classify(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
      // Verify it was called MAX_RETRIES (3) times.
      expect(agent.structuredOutput).toHaveBeenCalledTimes(3);
    });

    it('retries on structuredOutput error and succeeds on second attempt', async () => {
      const agent = mastraService.getAgent();
      const mockResult = sampleTriageResult();

      jest
        .spyOn(agent, 'structuredOutput')
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockRejectedValueOnce(new Error('LLM rate limit'))
        .mockResolvedValue(mockResult);

      const markdown = 'valid invoice';
      const result = await service.classify(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual(mockResult);
      }
      expect(agent.structuredOutput).toHaveBeenCalledTimes(3);
    });

    it('output never contains vat_code or account (grep clean)', async () => {
      const agent = mastraService.getAgent();
      const mockResult = sampleTriageResult();
      jest.spyOn(agent, 'structuredOutput').mockResolvedValue(mockResult);

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

    it('agent uses the correct read-only tool set', () => {
      const agent = mastraService.getAgent();
      const toolNames = Object.keys(agent.tools || {});

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

    it('reports transient when structuredOutput throws every time', async () => {
      const agent = mastraService.getAgent();
      jest
        .spyOn(agent, 'structuredOutput')
        .mockRejectedValue(new Error('persistent failure'));

      const result = await service.classify('any markdown');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('transient');
      }
      expect(agent.structuredOutput).toHaveBeenCalledTimes(3);
    });

    it('validates currency is 3 characters', async () => {
      const agent = mastraService.getAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        currency: 'EURO', // 4 chars, should fail z.string().length(3)
      };
      jest.spyOn(agent, 'structuredOutput').mockResolvedValue(invalidResult);

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates confidence is between 0 and 1', async () => {
      const agent = mastraService.getAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        confidence: 1.5, // > 1, should fail z.number().min(0).max(1)
      };
      jest.spyOn(agent, 'structuredOutput').mockResolvedValue(invalidResult);

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });

    it('validates kind is a valid enum value', async () => {
      const agent = mastraService.getAgent();
      const invalidResult = {
        ...sampleTriageResult(),
        kind: 'invalid_kind',
      };
      jest.spyOn(agent, 'structuredOutput').mockResolvedValue(invalidResult);

      const result = await service.classify('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid-output');
      }
    });
  });
});
