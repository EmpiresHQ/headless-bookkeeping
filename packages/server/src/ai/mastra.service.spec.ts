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

const EXPECTED_ENRICHMENT_TOOL_NAMES = [
  'listCategories',
  'getClassificationMemory',
  'previewCategoryMapping',
  'getClassificationContext',
] as const;

describe('MastraService', () => {
  let db: Kysely<Database>;
  let service: MastraService;

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

    // Agents are built on demand via buildTriageEnrichmentAgent() /
    // buildTriageClassificationAgent() / buildBankMappingAgent(). Those
    // statically import @mastra/*; under Jest the specifiers map to
    // test/mastra-stub.ts (see moduleNameMapper), so the real Agent API is
    // exercised against the stub classes. Each build re-reads the settings table.
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('buildBankMappingAgent', () => {
    it('builds a tool-less bank-mapping agent from settings', async () => {
      const agent = await service.buildBankMappingAgent();

      expect(agent.model).toBe('openai/gpt-4o-mini');
      expect(Object.keys((await agent.listTools()) ?? {})).toHaveLength(0);
    });
  });

  describe('buildTriageEnrichmentAgent', () => {
    it('builds a read-only enrichment agent led by getClassificationContext', async () => {
      const agent = await service.buildTriageEnrichmentAgent();
      const toolNames = Object.keys((await agent.listTools()) ?? {});

      expect(toolNames).toEqual(
        expect.arrayContaining(EXPECTED_ENRICHMENT_TOOL_NAMES),
      );
      expect(toolNames).toHaveLength(EXPECTED_ENRICHMENT_TOOL_NAMES.length);
      expect(toolNames).not.toContain('searchSuppliers');
      expect(toolNames).toContain('getClassificationContext');
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
