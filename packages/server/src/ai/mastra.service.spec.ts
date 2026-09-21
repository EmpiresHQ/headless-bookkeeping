import { TriageEvidence } from './triage-context';
import { fxTestProviders } from '../../test/fx-fixtures';
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
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import { MastraService } from './mastra.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('MastraService', () => {
  let db: Kysely<Database>;
  let service: MastraService;
  let entities: EntitiesService;
  let expenses: ExpensesService;

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
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        AuditLogService,
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
        CategoryService,
        MastraService,
      ],
    }).compile();

    service = module.get(MastraService);
    entities = module.get(EntitiesService);
    expenses = module.get(ExpensesService);

    // Agents are built on demand via buildTriageEnrichmentAgent() /
    // buildTriageClassificationAgent() / buildBankMappingAgent(). Those
    // statically import @mastra/*; under Jest the specifiers map to
    // test/mastra-stub.ts (see moduleNameMapper), so the real Agent API is
    // exercised against the stub classes. Each build re-reads the settings table.
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('application context lookup', () => {
    const input = (): TriageEvidence => ({
      kind: 'new_expense' as const,
      category: 'software',
      evidence: {
        registrationKey: 'IE5550000',
        name: 'OCR seller',
        country: 'IE',
        goodsVsServices: 'services' as const,
      },
    });
    it('normalizes the key and returns only posted category history, not draft/pending/reversed guesses', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Seller',
        registrationKey: 'IE5550000',
        goodsVsServices: 'services',
      });
      for (const [i, status] of [
        'posted',
        'posted',
        'draft',
        'pending',
        'reversed',
      ].entries()) {
        const expense = await expenses.createExpense({
          supplier_id: supplier.id,
          category: i < 2 ? 'software' : 'meals',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-01-01',
          supplier_invoice_number: `TEST-${i}`,
        });
        await db
          .updateTable('expense')
          .set({
            status: status as 'posted' | 'draft' | 'pending' | 'reversed',
          })
          .where('id', '=', expense.id)
          .execute();
      }
      const data = input();
      data.evidence.registrationKey = 'ie 5550000';
      const result = await service.resolveTriageContext(data);
      expect(result).toEqual({
        supplier: {
          resolution: 'matched',
          matchEntityId: supplier.id,
          name: 'Seller',
          country: 'IE',
        },
        classificationMemory: [{ category: 'software', count: 2 }],
      });
      expect(result).not.toHaveProperty('mapping');
    });
    it('does not match by name or substitute the organization country for missing evidence', async () => {
      await entities.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'OCR seller',
        registrationKey: 'IE5550000',
        goodsVsServices: 'services',
      });
      expect(
        await service.resolveTriageContext({
          ...input(),
          evidence: {
            ...input().evidence,
            registrationKey: null,
            country: null,
          },
        }),
      ).toEqual({
        supplier: { resolution: 'unmatched' },
        classificationMemory: [],
      });
    });
    it('rejects a country contradiction and unknown category', async () => {
      await entities.onboard({
        role: 'supplier',
        country: 'IE',
        name: 'Seller',
        registrationKey: 'IE5550000',
        goodsVsServices: 'services',
      });
      await expect(
        service.resolveTriageContext({
          ...input(),
          evidence: { ...input().evidence, country: 'US' },
        }),
      ).rejects.toThrow('contradicts');
      await expect(
        service.resolveTriageContext({ ...input(), category: 'invented' }),
      ).rejects.toThrow('Unknown candidate category');
    });
    it('does not perform a supplier lookup for outgoing or irrelevant documents', async () => {
      const spy = jest.spyOn(entities, 'resolveByIdentifier');
      for (const kind of ['new_sales_invoice', 'not_a_document'] as const) {
        await service.resolveTriageContext({
          ...input(),
          kind,
          category: null,
        });
      }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('buildBankMappingAgent', () => {
    it('builds a tool-less bank-mapping agent from settings', async () => {
      const agent = await service.buildBankMappingAgent();

      expect(agent.model).toBe('openai/gpt-4o-mini');
      expect(Object.keys((await agent.listTools()) ?? {})).toHaveLength(0);
    });
  });

  describe('buildTriageEnrichmentAgent', () => {
    it('builds a tool-free evidence extractor with categories and the evidence contract', async () => {
      const agent = await service.buildTriageEnrichmentAgent();
      expect(Object.keys((await agent.listTools()) ?? {})).toEqual([]);
      expect(await agent.getInstructions()).toContain(
        'Never output a database entity ID',
      );
      expect(await agent.getInstructions()).not.toContain(
        'Call listCategories',
      );
    });

    it('agent has no write tools (grep-clean: no post/createDraft/proposeDraft)', async () => {
      const agent = await service.buildTriageEnrichmentAgent();
      const toolNames = Object.keys((await agent.listTools()) ?? {});
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];

      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('falls back to the default model when no setting row exists', async () => {
      const agent = await service.buildTriageEnrichmentAgent();
      expect(agent.model).toBe('openai/gpt-4o-mini');
    });

    it('resolves model and instructions from AgentConfigService (per-agent override)', async () => {
      await db
        .insertInto('setting')
        .values([
          {
            key: 'ai_model.triage_enrichment',
            value: 'openai/gpt-4o',
            updated_at: 0,
          },
          {
            key: 'prompt.triage_enrichment',
            value: 'SEEDED ENRICHMENT PROMPT',
            updated_at: 0,
          },
        ])
        .execute();

      const agent = await service.buildTriageEnrichmentAgent();
      expect(agent.model).toBe('openai/gpt-4o');
      expect(await agent.getInstructions()).toContain(
        'SEEDED ENRICHMENT PROMPT',
      );
    });

    it('injects the active country plugin document-classification hints', async () => {
      const agent = await service.buildTriageEnrichmentAgent();
      // Default seeded organization is country="IE", which has no dedicated
      // plugin and falls back to NullCountryPlugin's hints.
      expect(await agent.getInstructions()).toContain('DOCUMENT-TYPE GUIDANCE');
    });
  });

  describe('buildTriageClassificationAgent', () => {
    it('builds a strict classification agent with no tools', async () => {
      const agent = await service.buildTriageClassificationAgent();

      expect(Object.keys((await agent.listTools()) ?? {})).toHaveLength(0);
    });

    it('falls back to the default model when no setting row exists', async () => {
      const agent = await service.buildTriageClassificationAgent();
      expect(agent.model).toBe('openai/gpt-4o-mini');
    });

    it('resolves model and instructions from AgentConfigService (per-agent override)', async () => {
      await db
        .insertInto('setting')
        .values([
          {
            key: 'ai_model.triage_classification',
            value: 'openai/gpt-4o',
            updated_at: 0,
          },
          {
            key: 'prompt.triage_classification',
            value: 'SEEDED CLASSIFICATION PROMPT',
            updated_at: 0,
          },
        ])
        .execute();

      const agent = await service.buildTriageClassificationAgent();
      expect(agent.model).toBe('openai/gpt-4o');
      expect(await agent.getInstructions()).toContain(
        'SEEDED CLASSIFICATION PROMPT',
      );
    });

    it('injects the active country plugin document-classification hints', async () => {
      const agent = await service.buildTriageClassificationAgent();
      // Default seeded organization is country="IE", which has no dedicated
      // plugin and falls back to NullCountryPlugin's hints.
      expect(await agent.getInstructions()).toContain('DOCUMENT-TYPE GUIDANCE');
    });
  });
});
